import type { Request, Response } from "express";
import { getAuthPanelClient } from "../clientes/auth-panel.client";
import type { IServiceResponse } from "../../../bff/domain/interfaces/service-response.interface";

/**
 * SPEC-268 — las tres rutas públicas del canje. Esta capa es una puerta: lo
 * que ms-auth conteste —código y cuerpo— se reenvía **tal cual**. Traducirlo
 * aquí daría dos vocabularios para el mismo rechazo, y el de ms-auth ya está
 * pensado para no distinguir por qué no se emitió una sesión.
 */
export const canjeController = {
  async canjear(req: Request, res: Response): Promise<void> {
    reenviar(res, await getAuthPanelClient().canjear(req.body?.asercion, req.context!));
  },

  async abrirSesion(req: Request, res: Response): Promise<void> {
    reenviar(res, await getAuthPanelClient().abrirSesion(req.body?.vale, req.context!));
  },

  async darDeBaja(req: Request, res: Response): Promise<void> {
    reenviar(res, await getAuthPanelClient().darDeBaja(req.body?.asercion, req.context!));
  },
};

/**
 * El cuerpo de ms-auth viene desenvuelto por la capa base (`data`) cuando fue
 * bien, y con `details` (el sobre entero) cuando no. Se vuelve a montar el
 * sobre `{success, data|message}` con el mismo código para que el anfitrión y
 * el componente vean lo mismo que verían hablando con ms-auth.
 */
function reenviar<T>(res: Response, respuesta: IServiceResponse<T>): void {
  if (respuesta.success) {
    res.status(respuesta.statusCode).json({ success: true, data: respuesta.data });
    return;
  }
  const detalle = respuesta.error?.details as { kindMessage?: string; message?: string } | undefined;
  res.status(respuesta.statusCode || 502).json({
    success: false,
    message: detalle?.kindMessage ?? detalle?.message ?? respuesta.error?.message ?? "No se pudo completar el canje",
  });
}
