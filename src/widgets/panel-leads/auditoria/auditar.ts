import type { Request } from "express";
import { publishAudit } from "./audit-publisher";

/**
 * SPEC-273 — lo que pasa por el panel queda auditado **con su origen**.
 *
 * Se anota quién, qué, cuándo y desde dónde. El origen es el dato que esta
 * superficie añade y que el backoffice no necesitaba: el mismo lead leído
 * desde GIA y desde la página de un cliente no son el mismo hecho. Y
 * `superficie` dice que vino por el panel incrustado, para poder separarlo.
 *
 * **Se guarda la referencia, no el contenido.** Ni el token, ni los datos de
 * contacto que se leyeron: un registro que los copiara duplicaría el problema
 * que existe para vigilar.
 *
 * **Fire-and-forget con tope.** `publishAudit` se traga sus fallos, pero abre
 * y reintenta la conexión a Redis por dentro; sin el tope, con el bus caído
 * cada petición esperaría treinta segundos. Perder una línea de auditoría es
 * malo; dejar a quien atiende mirando una rueda porque el REGISTRO no está es
 * peor, y en la página de un tercero además parece que su producto se rompió.
 */
const TOPE_DE_AUDITORIA_MS = 1_000;
export const SERVICIO = "bff-widget";
export const SUPERFICIE = "panel-incrustado";

function venceEn(ms: number): Promise<void> {
  return new Promise((listo) => {
    const t = setTimeout(listo, ms);
    if (typeof t.unref === "function") t.unref();
  });
}

export async function auditar(
  req: Request,
  evento: {
    accion: string;
    recurso: "lead_conversation" | "lead";
    recursoId: string;
    resultado: { success: boolean; statusCode?: number; data?: unknown; error?: unknown };
    extra?: Record<string, unknown>;
  },
): Promise<void> {
  const ctx = req.context!;
  const { success, statusCode, data, error } = evento.resultado;
  const detalle = (data ?? error) as { error?: string; message?: string } | undefined;

  await Promise.race([
    // `publishAudit` ya se traga sus fallos; el `catch` de aquí es por si un
    // día deja de hacerlo: registrar nunca puede tumbar la petición.
    publishAudit({
      tenantId: ctx.tenantId ?? "",
      actorId: ctx.userId ?? "",
      actorRole: ctx.userRoles?.[0],
      actorEmail: ctx.userEmail,
      action: evento.accion,
      resource: evento.recurso,
      resourceId: evento.recursoId,
      payload: {
        superficie: SUPERFICIE,
        origen: req.panel?.origin ?? null,
        credencialId: req.panel?.credentialId ?? null,
        resultado: success ? "ok" : "rechazado",
        ...(success ? {} : { codigo: statusCode ?? 502, motivo: detalle?.error ?? detalle?.message ?? "sin motivo" }),
        ...(evento.extra ?? {}),
      },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
      correlationId: ctx.correlationId,
      service: SERVICIO,
    }).catch((error: unknown) => console.error("[audit] no se pudo registrar:", error)),
    venceEn(TOPE_DE_AUDITORIA_MS),
  ]);
}
