/* eslint-disable @typescript-eslint/no-explicit-any */
import { createClient, RedisClientType } from "redis";
import {
  internalServerError,
  notFoundError,
} from "../../../../domain/error/handler-error";
import { env } from "../../../config/environments";
import { appConsole } from "../../../utils/app-console";
import { errorHandler } from "../../../../domain/error/error-handler";
import { DEFAULT_CACHE_TTL_SECONDS } from "../../../../constants/cache.enum";
import { Result } from "../../../../domain/dto/result.dto";
import { IDBDataItemRequired } from "../../../../domain/interfaces/db-response.interface";
import { ICacheService } from "../../../../domain/services/cache/cache-service.interface";
import {
  ISaveCacheBase,
  IUpdateCacheBase,
} from "../../../../domain/services/cache/cache.interface";

export class Redis implements ICacheService {
  private readonly client: RedisClientType;
  private connected: boolean = false;

  constructor() {
    const host = env.services.cache.redis?.host || "localhost";
    const port = process.env.REDIS_PORT || "6379";
    const url =
      host.startsWith("redis://") || host.startsWith("rediss://")
        ? host
        : `redis://${host}:${port}`;

    this.client = createClient({ url });
  }

  async connect(): Promise<void> {
    try {
      await this.client.connect();
      this.connected = true;
      appConsole.log("Redis client connected successfully");
    } catch (error: any) {
      appConsole.error("Redis connection error:", error);
      throw errorHandler(error);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async save(
    data: ISaveCacheBase
  ): Promise<IDBDataItemRequired<{ status: boolean }>> {
    try {
      const { key, value, ttl } = data;
      const ttlSeconds = ttl ?? DEFAULT_CACHE_TTL_SECONDS;
      const res = await this.client.set(key, JSON.stringify(value), {
        EX: ttlSeconds,
      });

      if (!res) {
        throw internalServerError(`Failed to save cache key: ${key}`);
      }

      return Result.Item({ status: true });
    } catch (error) {
      throw errorHandler(error);
    }
  }

  async update(
    data: IUpdateCacheBase
  ): Promise<IDBDataItemRequired<{ status: boolean }>> {
    try {
      const { key, value } = data;
      const exists = await this.client.exists(data.key);
      if (!exists) {
        throw notFoundError(`Cache key not found: ${data.key}`);
      }

      let ttl = await this.client.ttl(key);
      if (ttl < 0) ttl = 0;

      const res =
        ttl > 0
          ? await this.client.set(key, JSON.stringify(value), { EX: ttl })
          : await this.client.set(key, JSON.stringify(value));

      if (!res) {
        throw internalServerError(`Failed to update cache key: ${key}`);
      }

      return Result.Item({ status: true });
    } catch (error) {
      throw errorHandler(error);
    }
  }

  async get<T>(key: string): Promise<IDBDataItemRequired<T>> {
    try {
      const raw = await this.client.get(key);
      if (!raw) throw notFoundError(`Cache key not found: ${key}`);
      return Result.Item(JSON.parse(raw) as T);
    } catch (error) {
      throw errorHandler(error);
    }
  }

  async getOrNull<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(key);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (error) {
      throw errorHandler(error);
    }
  }

  async removeByPattern(pattern: string): Promise<void> {
    try {
      const keys = await this.client.keys(pattern);
      if (keys.length > 0) {
        await this.client.del(keys);
      }
    } catch (error) {
      throw errorHandler(error);
    }
  }

  async clear(): Promise<void> {
    try {
      await this.client.flushAll();
    } catch (error) {
      throw errorHandler(error);
    }
  }
}
