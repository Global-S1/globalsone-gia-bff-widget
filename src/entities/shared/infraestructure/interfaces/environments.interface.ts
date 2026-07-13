import { IEnvApp } from "./env-application.interface";

interface IEnvCacheService {
  redis?: {
    host: string;
  };
}

interface IEnvServices {
  cache: IEnvCacheService;
}

interface IEnvBff {
  jwtSecret: string;
  cacheEnabled: boolean;
  cacheDefaultTtl: number;
}

export interface IEnvironments {
  stage: string;
  app: IEnvApp;
  services: IEnvServices;
  bff: IEnvBff;
  internalServiceToken?: string;
}
