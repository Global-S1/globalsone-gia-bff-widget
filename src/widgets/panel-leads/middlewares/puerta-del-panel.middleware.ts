import type { NextFunction, Request, Response } from "express";

/**
 * SPEC-271 · ADR-046 — la puerta del panel sólo abre para su propio token.
 *
 * **El propósito del token es la primera comprobación, antes que los
 * permisos.** Un token del backoffice se rechaza por lo que es, no por lo que
 * le falta: así un permiso de más en el backoffice nunca abre esta puerta.
 *
 * El bearer se decodifica **sin verificar la firma**, a propósito: la firma la
 * comprobó ms-auth en el `auth_request` del gateway, que es quien inyectó las
 * cabeceras de sesión que este BFF lee. Verificarla otra vez aquí obligaría a
 * repartir la clave pública y no añadiría nada que el gateway no haya hecho ya.
 * Lo que sí se comprueba aquí es que el token que autorizó la petición es
 * **del panel**, que el origen desde el que llega es **el que lleva dentro**
 * (ADR-046 §8) y que la organización es la misma que el gateway resolvió.
 *
 * El origen se comprueba contra DOS cosas (SPEC-271): contra el token, aquí;
 * y contra la lista que el tenant tiene declarada HOY, en ms-auth, que la mira
 * en cada `validate`. Lo primero impide reutilizar el token en otra web; lo
 * segundo hace que retirar un dominio corte sin esperar a que caduque.
 */

/** Lo que este BFF lee del token del panel. */
export interface ClaimsDelPanel {
  purpose: "panel";
  origin: string;
  tenantId: string;
  userId: string;
  credentialId?: string;
}

/**
 * La misma regla que `normalizarOrigen` en ms-auth: esquema + host [+ puerto],
 * sin ruta, en minúsculas. `null` para lo que no es un origen.
 */
export function normalizarOrigen(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const texto = valor.trim();
  if (texto === "" || texto === "null") return null;
  try {
    const url = new URL(texto);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

/** Los claims de un JWS compacto, sin verificar. `null` si no tiene forma de JWS. */
export function decodificarClaims(bearer: string): Record<string, unknown> | null {
  const partes = bearer.split(".");
  if (partes.length !== 3) return null;
  try {
    const json = Buffer.from(partes[1]!, "base64url").toString("utf8");
    const claims = JSON.parse(json);
    return typeof claims === "object" && claims !== null ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function puertaDelPanel(req: Request, res: Response, next: NextFunction): void {
  const autorizacion = req.headers.authorization;
  if (typeof autorizacion !== "string" || !autorizacion.startsWith("Bearer ")) {
    rechazar(res, "Falta el token del panel");
    return;
  }

  const claims = decodificarClaims(autorizacion.slice("Bearer ".length).trim());
  if (claims === null || claims.purpose !== "panel") {
    // Por lo que el token ES: un access token del backoffice no entra aunque
    // traiga permisos de leads de sobra.
    rechazar(res, "Esta puerta sólo admite el token del panel incrustado");
    return;
  }

  const origenRecibido = normalizarOrigen(req.headers.origin);
  const origenDelToken = normalizarOrigen(claims.origin);
  if (origenRecibido === null || origenDelToken === null || origenRecibido !== origenDelToken) {
    rechazar(res, "El origen de la petición no es para el que se emitió la sesión");
    return;
  }

  const tenantDeLaSesion = req.headers["x-tenant-id"];
  if (typeof claims.tenantId !== "string" || claims.tenantId === "" || claims.tenantId !== tenantDeLaSesion) {
    rechazar(res, "La organización del token no es la de la sesión");
    return;
  }

  req.panel = {
    purpose: "panel",
    origin: origenDelToken,
    tenantId: claims.tenantId,
    userId: typeof claims.userId === "string" ? claims.userId : "",
    ...(typeof claims.credentialId === "string" ? { credentialId: claims.credentialId } : {}),
  };
  next();
}

function rechazar(res: Response, mensaje: string): void {
  res.status(401).json({ success: false, message: mensaje });
}
