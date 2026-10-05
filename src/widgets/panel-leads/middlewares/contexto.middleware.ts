import type { NextFunction, Request, Response } from "express";
import type { IRequestContext } from "../../../bff/domain/interfaces/request-context.interface";

/**
 * El contexto de una petición del panel incrustado.
 *
 * El del chat (`request-context.middleware`) no lee organización ni permisos:
 * quien escribe por el widget es un visitante anónimo y no los tiene. Por el
 * panel entra una persona con sesión, y el gateway inyecta lo que ms-auth
 * resolvió en el `auth_request` de esa petición: `X-User-Id`, `X-Tenant-Id`,
 * `X-User-Role`, `X-User-Permissions`, `X-User-Email` (ADR-046 §6). Es lo que
 * los clientes de este módulo reenvían a ms-leads y compañía.
 *
 * Vive dentro del módulo a propósito: cambiar qué lee el panel no puede tocar
 * lo que lee el chat, ni al revés.
 */
export function contextoDelPanel(req: Request, _res: Response, next: NextFunction): void {
  const permisos = req.headers["x-user-permissions"];
  const rol = req.headers["x-user-role"];
  const tenantId = req.headers["x-tenant-id"];
  const userId = req.headers["x-user-id"];
  const email = req.headers["x-user-email"];

  const context: IRequestContext = {
    correlationId: req.headers["x-correlation-id"] as string,
    userId: typeof userId === "string" && userId !== "" ? userId : undefined,
    userEmail: typeof email === "string" && email !== "" ? email : undefined,
    userRoles: typeof rol === "string" && rol !== "" ? rol.split(",") : undefined,
    authorizationHeader: req.headers.authorization,
    timestamp: new Date(),
    clientIp: clientIp(req),
    userAgent: req.headers["user-agent"],
    tenantId: typeof tenantId === "string" && tenantId !== "" ? tenantId : undefined,
    userPermissions: typeof permisos === "string" && permisos !== "" ? permisos.split(",").map((p) => p.trim()) : undefined,
  };

  req.context = context;
  next();
}

function clientIp(req: Request): string | undefined {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const primero = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(",")[0];
    return primero?.trim();
  }
  const real = req.headers["x-real-ip"];
  if (typeof real === "string") return real;
  return req.socket.remoteAddress;
}
