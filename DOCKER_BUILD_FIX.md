# Docker 构建错误修复

## 问题描述

Docker 构建过程中，在下载 PostgreSQL GPG 密钥时遇到网络错误：

```
curl: (18) HTTP/2 stream 1 was not closed cleanly before end of the underlying stream
gpg: no valid OpenPGP data found.
```

**错误位置：** `deploy/Dockerfile` 和 `deploy/Dockerfile.dev` 第 37-40 行（PostgreSQL 客户端安装步骤）

## 根本原因

1. **HTTP/2 协议问题**：PostgreSQL APT 仓库服务器在某些网络环境下可能不稳定地支持 HTTP/2
2. **网络波动**：构建服务器与 PostgreSQL 镜像服务器之间的网络连接不稳定
3. **缺少重试机制**：原始命令在首次失败后立即退出，没有重试

## 修复方案

### 修改内容

在两个 Dockerfile 中添加了 curl 重试机制和备用方案：

**修改前：**

```dockerfile
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/postgresql-archive-keyring.gpg
```

**修改后：**

```dockerfile
(curl --retry 3 --retry-delay 2 --max-time 30 --http1.1 -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/postgresql-archive-keyring.gpg || \
 curl --retry 3 --retry-delay 2 --max-time 30 -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/postgresql-archive-keyring.gpg)
```

### 修复细节

1. **重试机制**：
   - `--retry 3`：失败时最多重试 3 次
   - `--retry-delay 2`：每次重试之间等待 2 秒
   - `--max-time 30`：单次请求最长 30 秒超时

2. **协议降级**：
   - 第一次尝试：使用 `--http1.1` 强制使用 HTTP/1.1 协议
   - 第二次尝试（备用）：如果 HTTP/1.1 失败，尝试默认协议（包括 HTTP/2）

3. **错误处理**：
   - 使用 `( ... || ... )` 构造，确保有备用方案
   - 第一个 curl 命令失败时，自动执行第二个命令

### 受影响的文件

- ✅ `deploy/Dockerfile` - 生产环境 Dockerfile
- ✅ `deploy/Dockerfile.dev` - 开发环境 Dockerfile

## 为什么这样修复

### 1. HTTP/1.1 优先策略

HTTP/2 在某些网络环境下（特别是防火墙、代理、负载均衡器后）可能不稳定。强制使用 HTTP/1.1 可以避免这些问题：

- HTTP/2 的多路复用可能被中间设备干扰
- 某些 CDN 或镜像服务器的 HTTP/2 实现不完善
- HTTP/1.1 更加成熟稳定，兼容性更好

### 2. 重试机制

网络请求可能因为以下原因瞬时失败：

- 网络拥塞
- DNS 解析延迟
- 服务器临时过载
- 连接超时

添加重试可以自动处理这些瞬时故障。

### 3. 备用方案

使用 `||` 运算符提供备用方案：

- 如果 HTTP/1.1 连接在所有重试后仍然失败，则尝试默认协议
- 这确保了最大的兼容性和成功率

## 验证方法

### 本地测试

```bash
# 测试修复后的 Dockerfile
docker build -f deploy/Dockerfile -t claude-code-hub:test .

# 或使用 docker-compose
docker compose build
```

### 检查构建日志

成功的构建日志应该显示：

```
#XX [linux/amd64 runner 3/9] RUN apt-get update && ...
#XX XX.XX Setting up postgresql-client-18 ...
#XX XX.XX Processing triggers for ...
```

不应该再看到 `curl: (18)` 或 `gpg: no valid OpenPGP data found` 错误。

## 备选方案（如果修复仍然失败）

如果上述修复仍然失败，可以考虑以下备选方案：

### 方案 1：使用 Debian 自带的 PostgreSQL 客户端

```dockerfile
# 不添加 PostgreSQL APT 仓库，使用 Debian 自带版本（可能是 PostgreSQL 15 或 16）
RUN apt-get update && \
    apt-get install -y postgresql-client curl && \
    rm -rf /var/lib/apt/lists/*
```

**优点**：

- 不依赖外部网络请求
- 构建速度更快
- 更加稳定

**缺点**：

- PostgreSQL 客户端版本可能不是最新的（但通常足够使用）

### 方案 2：将 GPG 密钥内置到仓库

```dockerfile
# 将 ACCC4CF8.asc 文件放入 deploy/ 目录
COPY deploy/ACCC4CF8.asc /tmp/postgresql-key.asc
RUN apt-get update && \
    apt-get install -y gnupg curl ca-certificates && \
    cat /tmp/postgresql-key.asc | gpg --dearmor -o /usr/share/keyrings/postgresql-archive-keyring.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/postgresql-archive-keyring.gpg] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list && \
    apt-get update && \
    apt-get install -y postgresql-client-18 && \
    rm -rf /var/lib/apt/lists/*
```

**优点**：

- 完全避免网络请求
- 可重现的构建

**缺点**：

- 需要手动更新密钥文件
- 增加了仓库大小

### 方案 3：使用镜像源

如果在中国大陆或其他网络受限地区，可以使用镜像源：

```dockerfile
# 使用清华大学镜像源
RUN curl --retry 3 --retry-delay 2 --max-time 30 --http1.1 -fsSL \
    https://mirrors.tuna.tsinghua.edu.cn/postgresql/repos/apt/ACCC4CF8.asc | \
    gpg --dearmor -o /usr/share/keyrings/postgresql-archive-keyring.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/postgresql-archive-keyring.gpg] https://mirrors.tuna.tsinghua.edu.cn/postgresql/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list
```

## 总结

当前修复方案通过以下方式提高了 Docker 构建的可靠性：

1. ✅ 添加 3 次重试，每次间隔 2 秒
2. ✅ 设置 30 秒超时，避免无限等待
3. ✅ 优先使用 HTTP/1.1，避免 HTTP/2 问题
4. ✅ 提供备用方案，确保最大兼容性

这些改进应该能够解决绝大多数网络相关的构建失败问题。
