import * as fs from "fs";
import * as path from "path";
import { IServiceConfig } from "../../domain/interfaces/service-client.interface";
import { logger } from "../../../entities/shared/infraestructure/utils/app-console";

interface IBackendServicesJson {
  services: {
    [key: string]: {
      name: string;
      baseUrl: string;
      timeout: number;
      retries: number;
      healthPath: string;
    };
  };
}

interface IServicesHealth {
  [key: string]: {
    healthy: boolean;
    lastCheck: string;
  };
}

// Loaded configuration
let servicesConfig: Map<string, IServiceConfig> = new Map();

/**
 * Load backend services configuration from JSON file
 */
export function loadBackendServicesConfig(): void {
  try {
    const configPath = path.resolve(
      process.cwd(),
      "config",
      "backend-services.json"
    );
    const configContent = fs.readFileSync(configPath, "utf-8");
    const config: IBackendServicesJson = JSON.parse(configContent);

    for (const [key, service] of Object.entries(config.services)) {
      // Replace environment variable placeholders
      const baseUrl = resolveEnvVariables(service.baseUrl);

      servicesConfig.set(key, {
        name: service.name,
        baseUrl,
        timeout: service.timeout,
        retries: service.retries,
        healthPath: service.healthPath,
      });

      logger.info(`Loaded service config: ${key} -> ${baseUrl}`);
    }
  } catch (error) {
    logger.error("Failed to load backend services config:", error);
    throw error;
  }
}

/**
 * Replace ${VAR_NAME} placeholders with environment variable values
 */
function resolveEnvVariables(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    return process.env[varName] || "";
  });
}

/**
 * Get service configuration by key
 */
export function getServiceConfig(serviceKey: string): IServiceConfig {
  const config = servicesConfig.get(serviceKey);
  if (!config) {
    throw new Error(`Service configuration not found: ${serviceKey}`);
  }
  return config;
}

/**
 * Get all service configurations
 */
export function getAllServiceConfigs(): Map<string, IServiceConfig> {
  return servicesConfig;
}

/**
 * Check health of all backend services
 */
export async function getServicesHealth(): Promise<IServicesHealth> {
  const { request } = await import("undici");
  const health: IServicesHealth = {};

  const checks = Array.from(servicesConfig.entries()).map(
    async ([key, config]) => {
      try {
        const url = `${config.baseUrl}${config.healthPath}`;
        const response = await request(url, {
          method: "GET",
          headersTimeout: 3000,
          bodyTimeout: 3000,
        });

        health[key] = {
          healthy: response.statusCode >= 200 && response.statusCode < 300,
          lastCheck: new Date().toISOString(),
        };
      } catch {
        health[key] = {
          healthy: false,
          lastCheck: new Date().toISOString(),
        };
      }
    }
  );

  await Promise.all(checks);
  return health;
}

/**
 * Service keys enum for type safety
 */
export const ServiceKeys = {
  AUTH: "auth",
  AGENTS: "agents",
  CUSTOMERS: "customers",
  /**
   * SPEC-167 · ADR-034 — la segunda puerta del mensaje del widget. Sólo se usa
   * para los agentes con la clasificación de leads encendida; el resto sigue
   * yendo a AGENTS.
   */
  LEADS: "leads",
  /**
   * SPEC-187 · ADR-035 — de donde salen los bytes de un recurso del agente.
   * Sólo lo usa el proxy del fichero: su ruta no se abre a internet, y este
   * servicio es quien va a buscarlos con el token de servicio.
   */
  DOCUMENTS: "documents",
} as const;

export type ServiceKey = (typeof ServiceKeys)[keyof typeof ServiceKeys];
