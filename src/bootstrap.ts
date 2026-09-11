import { Redis } from "./entities/shared/infraestructure/services/cache/redis/redis";
import { appConsole } from "./entities/shared/infraestructure/utils/app-console";
import { server } from "./server";
import { loadBackendServicesConfig } from "./bff/infrastructure/config/backend-services.config";
import { escucharCambiosDeWidget } from "./bff/infrastructure/cache/suscripcion-a-cambios-de-widget";
import type { Express } from "express";

// Redis instance for BFF caching
export const redisCache = new Redis();

export async function bootstrap(): Promise<Express> {
  try {
    // Load backend services configuration
    loadBackendServicesConfig();
    appConsole.log("✅ Backend services configuration loaded");

    // Connect to Redis (required for aggregated response caching)
    await redisCache.connect();
    appConsole.log("✅ Redis connected");

    /*
     * SPEC-262 · ADR-044 — la escucha de cambios de widget. No se aborta el
     * arranque si no se abre: quedarse sin aviso cuesta inmediatez, y el
     * vencimiento por tiempo sigue debajo. Tumbar el BFF por esto dejaría sin
     * chat a todos los widgets para arreglarle el retraso a uno.
     */
    const escuchando = await escucharCambiosDeWidget();
    appConsole.log(
      escuchando
        ? "✅ Escuchando cambios de widget"
        : "⚠️  Sin escucha de cambios de widget: rige el vencimiento por tiempo"
    );

    // Return configured Express server
    return server();
  } catch (err) {
    appConsole.error("❌ Error during bootstrap:", err);
    process.exit(1);
  }
}
