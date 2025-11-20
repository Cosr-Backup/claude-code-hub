# 问题排查与修复总结

## 修复的问题

### 1. 供应商模型测试报错：`Unsupported parameter: max_tokens`

**错误日志：**

```json
{
  "level": "error",
  "providerUrl": "https://api.ikuncode.cc",
  "path": "/v1/responses",
  "status": 400,
  "errorDetail": "Unsupported parameter: max_tokens",
  "msg": "Provider API test failed"
}
```

**根本原因：**
OpenAI Responses API (`/v1/responses`) 不支持 `max_tokens` 参数，但测试函数 `testProviderOpenAIResponses` 中包含了该参数。

**修复内容：**

- 文件：`src/actions/providers.ts`
- 行号：1265
- 修改：从请求体中移除 `max_tokens: API_TEST_CONFIG.TEST_MAX_TOKENS`
- 保留：`model` 和 `input` 参数

**修复后的请求体：**

```typescript
body: (model) => ({
  model,
  input: "讲一个简短的故事",
});
```

### 2. 数据库报错：`column "limit_5h_usd" does not exist`

**错误日志：**

```json
{
  "level": "error",
  "err": {
    "message": "Failed query: select ... limit_5h_usd ... from \"users\" ...",
    "query": "column \"limit_5h_usd\" does not exist"
  },
  "msg": "Failed to fetch user data:"
}
```

**根本原因：**

1. 数据库迁移 `0020_next_juggernaut.sql` 添加了新的用户配额列（`limit_5h_usd`, `limit_weekly_usd`, `limit_monthly_usd`, `limit_concurrent_sessions`）
2. 但在某些环境中，这些列可能尚未执行迁移（例如 Docker 容器重建后）
3. 代码直接查询这些列，导致 SQL 错误

**修复内容：**

#### 2.1 用户类型定义修正

- 文件：`src/types/user.ts`
- 将 `User` 接口中的配额字段从可选（`?`）改为必需但可为 null（`| null`）
- 确保类型定义与数据库 schema 一致

**修改前：**

```typescript
export interface User {
  // ...
  limit5hUsd?: number; // 可选
}
```

**修改后：**

```typescript
export interface User {
  // ...
  limit5hUsd: number | null; // 必需但可为 null
}
```

#### 2.2 用户转换函数完善

- 文件：`src/repository/_shared/transformers.ts`
- 在 `toUser` 函数中添加配额字段的转换逻辑

**修改前：**

```typescript
export function toUser(dbUser: any): User {
  return {
    ...dbUser,
    description: dbUser?.description || "",
    role: (dbUser?.role as User["role"]) || "user",
    rpm: dbUser?.rpm || 60,
    dailyQuota: dbUser?.dailyQuota ? parseFloat(dbUser.dailyQuota) : 0,
    providerGroup: dbUser?.providerGroup ?? null,
    createdAt: dbUser?.createdAt ? new Date(dbUser.createdAt) : new Date(),
    updatedAt: dbUser?.updatedAt ? new Date(dbUser.updatedAt) : new Date(),
  };
}
```

**修改后：**

```typescript
export function toUser(dbUser: any): User {
  return {
    ...dbUser,
    description: dbUser?.description || "",
    role: (dbUser?.role as User["role"]) || "user",
    rpm: dbUser?.rpm || 60,
    dailyQuota: dbUser?.dailyQuota ? parseFloat(dbUser.dailyQuota) : 0,
    providerGroup: dbUser?.providerGroup ?? null,
    limit5hUsd: dbUser?.limit5hUsd ? parseFloat(dbUser.limit5hUsd) : null,
    limitWeeklyUsd: dbUser?.limitWeeklyUsd ? parseFloat(dbUser.limitWeeklyUsd) : null,
    limitMonthlyUsd: dbUser?.limitMonthlyUsd ? parseFloat(dbUser.limitMonthlyUsd) : null,
    limitConcurrentSessions: dbUser?.limitConcurrentSessions ?? null,
    createdAt: dbUser?.createdAt ? new Date(dbUser.createdAt) : new Date(),
    updatedAt: dbUser?.updatedAt ? new Date(dbUser.updatedAt) : new Date(),
  };
}
```

#### 2.3 用户 Repository 动态列检测（向后兼容）

- 文件：`src/repository/user.ts`
- 实现了动态检测数据库列是否存在的机制
- 当列不存在时，返回 NULL 值而不是抛出错误
- 确保在迁移未完成时系统仍可正常运行

**核心实现：**

```typescript
// 检测 users 表中配额列是否存在
async function ensureUserQuotaColumnsAvailability(): Promise<boolean> {
  // 查询 information_schema.columns 检测列是否存在
  const result = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'users'
      AND column_name IN ('limit_5h_usd', 'limit_weekly_usd', 'limit_monthly_usd', 'limit_concurrent_sessions')
  `);

  const count = Number(result.rows?.[0]?.count ?? 0);
  const available = count === 4;

  if (!available) {
    logger.warn("User quota columns are missing. Please run migration 0020.");
  }

  return available;
}

// 根据列是否存在，动态构建 SELECT 语句
function buildUserSelection(includeQuotaColumns: boolean) {
  const baseSelection = { id: users.id, name: users.name /* ... */ };

  if (includeQuotaColumns) {
    return {
      ...baseSelection,
      limit5hUsd: users.limit5hUsd,
      // ...
    };
  }

  // 列不存在时，返回 NULL 值
  return {
    ...baseSelection,
    limit5hUsd: sql`NULL::numeric`.as("limit5hUsd"),
    // ...
  };
}
```

**降级策略：**

- 列存在：正常查询和更新
- 列不存在：返回 NULL 值，忽略更新操作，记录 warn 日志

#### 2.4 其他修复

- **文件：**`src/lib/auth.ts`
  - 在 Admin Token 用户对象中添加配额字段初始化（全部为 `null`）

- **文件：**`src/repository/key.ts`
  - 在 `validateApiKeyAndGetUser` 函数中添加用户配额字段查询

## 影响范围

### 已修复的文件

1. `src/actions/providers.ts` - OpenAI Responses API 测试修复
2. `src/types/user.ts` - User 类型定义修正
3. `src/repository/_shared/transformers.ts` - toUser 转换函数完善
4. `src/repository/user.ts` - 动态列检测和向后兼容
5. `src/lib/auth.ts` - Admin Token 用户对象修正
6. `src/repository/key.ts` - validateApiKeyAndGetUser 查询修正

### 测试建议

1. **供应商测试：**
   - 访问：设置 → 供应商管理 → 编辑供应商
   - 点击"测试连接"，选择"OpenAI Responses API"
   - 验证不再出现 `Unsupported parameter: max_tokens` 错误

2. **用户管理测试（迁移已执行）：**
   - 访问：仪表盘 → 用户管理
   - 验证用户列表正常加载
   - 验证用户配额字段正常显示和编辑

3. **用户管理测试（迁移未执行）：**
   - 在未执行 `0020_next_juggernaut` 迁移的环境中测试
   - 验证用户列表仍可正常加载（配额字段为 null）
   - 验证日志中出现警告："User quota columns are missing"

## 迁移说明

### 执行迁移（如果尚未执行）

**生产环境（Docker）：**

```bash
# 确保 AUTO_MIGRATE=true
docker compose restart app

# 或手动执行迁移
docker compose exec app bun run db:migrate
```

**开发环境：**

```bash
bun run db:migrate
# 或
bun run db:push
```

**验证迁移是否执行：**

```bash
# 连接数据库并检查列是否存在
docker compose exec postgres psql -U your_user -d your_db -c "\d users"

# 或使用 psql 查询
SELECT column_name FROM information_schema.columns
WHERE table_name = 'users'
AND column_name IN ('limit_5h_usd', 'limit_weekly_usd', 'limit_monthly_usd', 'limit_concurrent_sessions');
```

## 技术要点

### 1. API 参数兼容性

- 不同的 AI API 支持不同的参数集
- OpenAI Responses API 不支持 `max_tokens`
- 测试时应参考官方文档验证参数

### 2. 数据库迁移向后兼容

- 新增列时，应考虑向后兼容性
- 使用 nullable 或 default 值避免破坏旧数据
- Repository 层应检测列是否存在，提供降级逻辑

### 3. 类型定义一致性

- TypeScript 类型定义应与数据库 schema 一致
- 避免使用可选字段（`?`）表示数据库 nullable 列
- 应使用 `| null` 明确表示字段可为空

### 4. 错误处理策略

- 关键功能（如用户管理）应具备降级能力
- 数据库列缺失时，记录 warn 日志而不是抛出错误
- Fail Open 策略：优先保证服务可用性
