import { LANG } from "../../domain/services/lang.service";
import { IEnvironments } from "../interfaces/environments.interface";

export const env: IEnvironments = {
  stage: process.env.NODE_ENV === "production" ? "PROD" : "DEV",
  app: {
    name: process.env.APP_NAME || "BFF-WIDGET",
    port: Number(process.env.APP_PORT ?? 3000),
    defaultLang: (process.env.APP_DEFAULT_LANG as LANG) || LANG.ES,
  },
  services: {
    cache: {
      redis: {
        host: String(process.env.REDIS_HOST || "redis://localhost:6379"),
      },
    },
  },
  bff: {
    jwtSecret: String(process.env.BFF_JWT_SECRET || "change-me"),
    cacheEnabled: process.env.BFF_CACHE_ENABLED === "true",
    cacheDefaultTtl: Number(process.env.BFF_CACHE_DEFAULT_TTL || 300),
  },
  internalServiceToken: process.env.INTERNAL_SERVICE_TOKEN,
};
