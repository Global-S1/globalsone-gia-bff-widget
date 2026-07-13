import { redisCache } from "../../../bootstrap";
import { env } from "../../../entities/shared/infraestructure/config/environments";
import { logger } from "../../../entities/shared/infraestructure/utils/logger";
import { BffCacheTTL, buildInvalidationPattern } from "./cache-keys.enum";
import * as crypto from "crypto";

/**
 * Service for caching aggregated BFF responses.
 * Features:
 * - Cache aggregated responses with TTL
 * - Tag-based invalidation
 * - Hash-based cache keys for complex parameters
 */
class AggregatedCacheService {
  /**
   * Get a cached value
   */
  async get<T>(key: string): Promise<T | null> {
    if (!env.bff.cacheEnabled) {
      return null;
    }

    try {
      const cached = await redisCache.getOrNull<T>(key);
      if (cached) {
        logger.debug("Cache hit", { key });
        return cached;
      }
      return null;
    } catch (error) {
      logger.warn("Cache get error", { key, error });
      return null;
    }
  }

  /**
   * Set a cached value
   */
  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    if (!env.bff.cacheEnabled) {
      return;
    }

    try {
      const cacheTtl = ttl ?? env.bff.cacheDefaultTtl;
      await redisCache.save({
        key,
        value,
        ttl: cacheTtl,
      });
      logger.debug("Cache set", { key, ttl: cacheTtl });
    } catch (error) {
      logger.warn("Cache set error", { key, error });
    }
  }

  /**
   * Invalidate a cached value
   */
  async invalidate(key: string): Promise<void> {
    try {
      await redisCache.remove(key);
      logger.debug("Cache invalidated", { key });
    } catch (error) {
      logger.warn("Cache invalidation error", { key, error });
    }
  }

  /**
   * Invalidate all cached values matching a pattern
   */
  async invalidatePattern(pattern: string): Promise<void> {
    try {
      await redisCache.removeByPattern(pattern);
      logger.debug("Cache pattern invalidated", { pattern });
    } catch (error) {
      logger.warn("Cache pattern invalidation error", { pattern, error });
    }
  }

  /**
   * Invalidate cache for a specific user
   */
  async invalidateUser(userId: string): Promise<void> {
    const patterns = [
      buildInvalidationPattern("bff:user_profile", userId),
      buildInvalidationPattern("bff:dashboard", userId),
    ];

    await Promise.all(patterns.map((p) => this.invalidatePattern(p)));
    logger.debug("User cache invalidated", { userId });
  }

  /**
   * Build a cache key with hash for complex parameters
   */
  buildHashedKey(prefix: string, params: Record<string, unknown>): string {
    const hash = crypto
      .createHash("md5")
      .update(JSON.stringify(params))
      .digest("hex")
      .substring(0, 8);

    return `${prefix}:${hash}`;
  }

  /**
   * Get or set a cached value using a factory function
   */
  async getOrSet<T>(
    key: string,
    factory: () => Promise<T>,
    ttl?: number
  ): Promise<T> {
    // Try to get from cache
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    // Generate new value
    const value = await factory();

    // Cache it
    await this.set(key, value, ttl);

    return value;
  }

  /**
   * Cache with tags for grouped invalidation
   * Tags are stored as a set of cache keys
   */
  async setWithTags<T>(
    key: string,
    value: T,
    tags: string[],
    ttl?: number
  ): Promise<void> {
    await this.set(key, value, ttl);

    // Register key with each tag
    for (const tag of tags) {
      const tagKey = `bff:tags:${tag}`;
      try {
        const taggedKeys = await this.get<string[]>(tagKey) || [];
        if (!taggedKeys.includes(key)) {
          taggedKeys.push(key);
          await this.set(tagKey, taggedKeys, BffCacheTTL.DEFAULT);
        }
      } catch {
        await this.set(tagKey, [key], BffCacheTTL.DEFAULT);
      }
    }
  }

  /**
   * Invalidate all keys with a specific tag
   */
  async invalidateTag(tag: string): Promise<void> {
    const tagKey = `bff:tags:${tag}`;
    try {
      const taggedKeys = await this.get<string[]>(tagKey);
      if (taggedKeys) {
        await Promise.all(taggedKeys.map((k) => this.invalidate(k)));
        await this.invalidate(tagKey);
      }
    } catch (error) {
      logger.warn("Tag invalidation error", { tag, error });
    }
  }
}

// Export singleton instance
export const aggregatedCacheService = new AggregatedCacheService();
