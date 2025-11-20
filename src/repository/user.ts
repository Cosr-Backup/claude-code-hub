"use server";

import { db } from "@/drizzle/db";
import { users } from "@/drizzle/schema";
import { eq, isNull, and, sql } from "drizzle-orm";
import type { User, CreateUserData, UpdateUserData } from "@/types/user";
import { toUser } from "./_shared/transformers";
import { logger } from "@/lib/logger";

const USER_QUOTA_COLUMNS = [
  "limit_5h_usd",
  "limit_weekly_usd",
  "limit_monthly_usd",
  "limit_concurrent_sessions",
] as const;

let userQuotaColumnsAvailable: boolean | null = null;
let checkingUserQuotaColumns: Promise<boolean> | null = null;

async function ensureUserQuotaColumnsAvailability(): Promise<boolean> {
  if (userQuotaColumnsAvailable !== null) {
    return userQuotaColumnsAvailable;
  }

  if (!checkingUserQuotaColumns) {
    checkingUserQuotaColumns = (async () => {
      try {
        const result = await db.execute<{ count: number }>(sql`
          SELECT COUNT(*)::int AS count
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'users'
            AND column_name IN (${sql.join(
              USER_QUOTA_COLUMNS.map((columnName) => sql`${columnName}`),
              sql`, `
            )})
        `);

        const rows = Array.from(result) as Array<{ count: number }>;
        const count = Number(rows[0]?.count ?? 0);
        const available = count === USER_QUOTA_COLUMNS.length;

        if (!available) {
          logger.warn(
            "User quota columns are missing in database. Please run the latest migrations (0020_next_juggernaut)."
          );
        }

        userQuotaColumnsAvailable = available;
        return available;
      } catch (error) {
        logger.error("Failed to determine user quota columns availability", {
          error,
        });
        userQuotaColumnsAvailable = false;
        return false;
      } finally {
        checkingUserQuotaColumns = null;
      }
    })();
  }

  return checkingUserQuotaColumns!;
}

function buildUserSelection(includeQuotaColumns: boolean) {
  const baseSelection = {
    id: users.id,
    name: users.name,
    description: users.description,
    role: users.role,
    rpm: users.rpmLimit,
    dailyQuota: users.dailyLimitUsd,
    providerGroup: users.providerGroup,
    createdAt: users.createdAt,
    updatedAt: users.updatedAt,
    deletedAt: users.deletedAt,
  };

  if (includeQuotaColumns) {
    return {
      ...baseSelection,
      limit5hUsd: users.limit5hUsd,
      limitWeeklyUsd: users.limitWeeklyUsd,
      limitMonthlyUsd: users.limitMonthlyUsd,
      limitConcurrentSessions: users.limitConcurrentSessions,
    };
  }

  return {
    ...baseSelection,
    limit5hUsd: sql<number | null>`NULL::numeric`.as("limit5hUsd"),
    limitWeeklyUsd: sql<number | null>`NULL::numeric`.as("limitWeeklyUsd"),
    limitMonthlyUsd: sql<number | null>`NULL::numeric`.as("limitMonthlyUsd"),
    limitConcurrentSessions: sql<number | null>`NULL::integer`.as("limitConcurrentSessions"),
  };
}

function buildInsertUserData(includeQuotaColumns: boolean, userData: CreateUserData) {
  const baseData = {
    name: userData.name,
    description: userData.description,
    rpmLimit: userData.rpm,
    dailyLimitUsd: userData.dailyQuota?.toString(),
    providerGroup: userData.providerGroup,
  } satisfies Record<string, unknown>;

  if (includeQuotaColumns) {
    return {
      ...baseData,
      limit5hUsd: userData.limit5hUsd?.toString(),
      limitWeeklyUsd: userData.limitWeeklyUsd?.toString(),
      limitMonthlyUsd: userData.limitMonthlyUsd?.toString(),
      limitConcurrentSessions: userData.limitConcurrentSessions ?? null,
    };
  }

  if (
    userData.limit5hUsd !== undefined ||
    userData.limitWeeklyUsd !== undefined ||
    userData.limitMonthlyUsd !== undefined ||
    userData.limitConcurrentSessions !== undefined
  ) {
    logger.warn(
      "User quota columns are not available in database. Quota-related fields will be ignored during user creation."
    );
  }

  return baseData;
}

function buildUpdateUserData(includeQuotaColumns: boolean, userData: UpdateUserData) {
  interface UpdateDbData {
    name?: string;
    description?: string;
    rpmLimit?: number;
    dailyLimitUsd?: string;
    providerGroup?: string | null;
    updatedAt?: Date;
    limit5hUsd?: string;
    limitWeeklyUsd?: string;
    limitMonthlyUsd?: string;
    limitConcurrentSessions?: number | null;
  }

  const dbData: UpdateDbData = {
    updatedAt: new Date(),
  };

  if (userData.name !== undefined) dbData.name = userData.name;
  if (userData.description !== undefined) dbData.description = userData.description;
  if (userData.rpm !== undefined) dbData.rpmLimit = userData.rpm;
  if (userData.dailyQuota !== undefined) dbData.dailyLimitUsd = userData.dailyQuota.toString();
  if (userData.providerGroup !== undefined) dbData.providerGroup = userData.providerGroup;

  if (includeQuotaColumns) {
    if (userData.limit5hUsd !== undefined) dbData.limit5hUsd = userData.limit5hUsd.toString();
    if (userData.limitWeeklyUsd !== undefined)
      dbData.limitWeeklyUsd = userData.limitWeeklyUsd.toString();
    if (userData.limitMonthlyUsd !== undefined)
      dbData.limitMonthlyUsd = userData.limitMonthlyUsd.toString();
    if (userData.limitConcurrentSessions !== undefined)
      dbData.limitConcurrentSessions = userData.limitConcurrentSessions ?? null;
  } else if (
    userData.limit5hUsd !== undefined ||
    userData.limitWeeklyUsd !== undefined ||
    userData.limitMonthlyUsd !== undefined ||
    userData.limitConcurrentSessions !== undefined
  ) {
    logger.warn(
      "User quota columns are not available in database. Quota-related fields will be ignored during user update."
    );
  }

  return dbData;
}

export async function createUser(userData: CreateUserData): Promise<User> {
  const includeQuotaColumns = await ensureUserQuotaColumnsAvailability();

  const dbData = buildInsertUserData(includeQuotaColumns, userData);

  const [user] = await db
    .insert(users)
    .values(dbData)
    .returning(buildUserSelection(includeQuotaColumns));

  return toUser(user);
}

export async function findUserList(limit: number = 50, offset: number = 0): Promise<User[]> {
  const includeQuotaColumns = await ensureUserQuotaColumnsAvailability();

  const result = await db
    .select(buildUserSelection(includeQuotaColumns))
    .from(users)
    .where(isNull(users.deletedAt))
    .orderBy(sql`CASE WHEN ${users.role} = 'admin' THEN 0 ELSE 1 END`, users.id)
    .limit(limit)
    .offset(offset);

  return result.map(toUser);
}

export async function findUserById(id: number): Promise<User | null> {
  const includeQuotaColumns = await ensureUserQuotaColumnsAvailability();

  const [user] = await db
    .select(buildUserSelection(includeQuotaColumns))
    .from(users)
    .where(and(eq(users.id, id), isNull(users.deletedAt)));

  if (!user) return null;

  return toUser(user);
}

export async function updateUser(id: number, userData: UpdateUserData): Promise<User | null> {
  if (Object.keys(userData).length === 0) {
    return findUserById(id);
  }

  const includeQuotaColumns = await ensureUserQuotaColumnsAvailability();
  const dbData = buildUpdateUserData(includeQuotaColumns, userData);

  const [user] = await db
    .update(users)
    .set(dbData)
    .where(and(eq(users.id, id), isNull(users.deletedAt)))
    .returning(buildUserSelection(includeQuotaColumns));

  if (!user) return null;

  return toUser(user);
}

export async function deleteUser(id: number): Promise<boolean> {
  const result = await db
    .update(users)
    .set({ deletedAt: new Date() })
    .where(and(eq(users.id, id), isNull(users.deletedAt)))
    .returning({ id: users.id });

  return result.length > 0;
}
