import { Router, Request, Response } from "express";
import { StatusCodes } from "../entities/shared/infraestructure/lib/http-status-codes";
import { env } from "../entities/shared/infraestructure/config/environments";
import { getServicesHealth } from "../bff/infrastructure/config/backend-services.config";
import { chatRoutes } from "./routes/chat.routes";

export function api(): Router {
  const router = Router();

  // Health check endpoint - basic (no auth required)
  router.get("/health", (_req: Request, res: Response) => {
    const healthInfo = {
      status: "healthy",
      service: env.app.name,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        unit: "MB",
      },
    };

    res.status(StatusCodes.OK).json(healthInfo);
  });

  // Liveness probe (simple check for Kubernetes)
  router.get("/health/live", (_req: Request, res: Response) => {
    res.status(StatusCodes.OK).json({ status: "alive" });
  });

  // Readiness probe (checks backend services)
  router.get("/health/ready", async (_req: Request, res: Response) => {
    try {
      const servicesHealth = await getServicesHealth();
      const allHealthy = Object.values(servicesHealth).every(
        (service) => service.healthy
      );

      if (allHealthy) {
        res.status(StatusCodes.OK).json({
          status: "ready",
          services: servicesHealth,
        });
      } else {
        res.status(StatusCodes.SERVICE_UNAVAILABLE).json({
          status: "degraded",
          services: servicesHealth,
        });
      }
    } catch (error) {
      res.status(StatusCodes.SERVICE_UNAVAILABLE).json({
        status: "not_ready",
        error: "Health check failed",
      });
    }
  });

  // Detailed health endpoint (includes all backend services status)
  router.get("/health/detailed", async (_req: Request, res: Response) => {
    try {
      const servicesHealth = await getServicesHealth();
      const healthyCount = Object.values(servicesHealth).filter(
        (s) => s.healthy
      ).length;
      const totalCount = Object.keys(servicesHealth).length;

      const status =
        healthyCount === totalCount
          ? "healthy"
          : healthyCount > 0
            ? "degraded"
            : "unhealthy";

      res.status(StatusCodes.OK).json({
        status,
        service: env.app.name,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        backendServices: {
          healthy: healthyCount,
          total: totalCount,
          services: servicesHealth,
        },
        memory: {
          used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
          unit: "MB",
        },
      });
    } catch (error) {
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        status: "error",
        error: "Failed to aggregate health status",
      });
    }
  });

  // Chat del widget → ms-agents (streaming passthrough). Público: la identidad
  // de organización viaja en el header/body como unique-tenant-token.
  router.use("/chat", chatRoutes());

  return router;
}
