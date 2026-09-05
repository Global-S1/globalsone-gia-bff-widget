import express, { Express, Request, Response, NextFunction } from "express";
import cors from "cors";
import { pinoHttp } from "pino-http";
import { env } from "./entities/shared/infraestructure/config/environments";
import { AppError } from "./entities/shared/domain/error/app-error";
import { appConsole } from "./entities/shared/infraestructure/utils/app-console";
import { StatusCodes } from "./entities/shared/infraestructure/lib/http-status-codes";
import { correlationIdMiddleware } from "./api/middlewares/correlation-id.middleware";
import { CABECERA_DE_FOTOS } from "./api/controllers/fotos-en-cabecera";
import { CABECERA_DE_FICHEROS } from "./api/controllers/ficheros-en-cabecera";
import { api } from "./api/api";

export function server(): Express {
  const app = express();

  // Trust proxy for accurate IP detection behind load balancers
  app.set("trust proxy", true);

  // CORS configuration
  app.use(
    cors({
      origin: "*",
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-API-Key",
        "X-Correlation-ID",
        "X-Request-ID",
        "unique-tenant-token",
        "ip-address",
      ],
      // Sin esto, el navegador NO deja al widget leerlas: una cabecera de
      // respuesta que no se expone existe y es invisible desde el script.
      exposedHeaders: [
        "X-Correlation-ID",
        "X-BFF-Duration",
        "X-Partial-Failures",
        "Chat-Session-Id",
        // SPEC-167 · RF-020: la direccion del formulario del tenant, cuando
        // ms-leads derivo la conversacion.
        "Contact-Form-Url",
        // SPEC-183 · RF-021: las fotos que el agente senalo. El nombre sale del
        // modulo que las pone, no de un literal repetido: dos literales se
        // separan con el tiempo y la cabecera se volveria invisible sin error.
        CABECERA_DE_FOTOS,
        // SPEC-188 · RF-022: los ficheros que aparto, con su titulo y su llave.
        CABECERA_DE_FICHEROS,
      ],
    })
  );

  // Body parsing
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));

  // Correlation ID middleware (adds X-Correlation-ID to all requests)
  app.use(correlationIdMiddleware);

  // Request logging
  if (env.stage !== "TEST") {
    app.use(
      pinoHttp({
        level: env.stage === "DEV" ? "debug" : "info",
        transport:
          env.stage === "DEV"
            ? {
                target: "pino-pretty",
                options: {
                  colorize: true,
                  translateTime: "SYS:standard",
                  ignore: "pid,hostname",
                },
              }
            : undefined,
        customProps: (req: Request) => ({
          correlationId: req.headers["x-correlation-id"],
        }),
        redact: ["req.headers.authorization", "req.headers['x-api-key']"],
      })
    );
  }

  // Root health endpoint (used by container/orchestrator healthchecks)
  app.get("/health", (_req: Request, res: Response) => {
    res.status(StatusCodes.OK).json({
      status: "healthy",
      service: env.app.name,
      timestamp: new Date().toISOString(),
    });
  });

  // API routes
  app.use("/v1", api());

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(StatusCodes.NOT_FOUND).json({
      success: false,
      error: {
        code: "NOT_FOUND",
        message: "The requested resource was not found",
      },
    });
  });

  // Global error handler
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    const correlationId = req.headers["x-correlation-id"] as string;

    if (err instanceof AppError) {
      appConsole.warn(`[${correlationId}] AppError:`, err.message);
      return res.status(err.httpCode).json({
        success: false,
        error: {
          code: err.code || "ERROR",
          message: err.message,
          ...(env.stage === "DEV" && { stack: err.stack }),
        },
        correlationId,
      });
    }

    appConsole.error(`[${correlationId}] Unhandled error:`, err);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
        ...(env.stage === "DEV" && { stack: err.stack }),
      },
      correlationId,
    });
  });

  return app;
}
