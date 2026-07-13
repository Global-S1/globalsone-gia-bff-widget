import { Request, Response } from "express";
import { StatusCodes } from "../../entities/shared/infraestructure/lib/http-status-codes";
import { getAgentsServiceClient } from "../../bff/infrastructure/service-clients/agents-service.client";
import { logger } from "../../entities/shared/infraestructure/utils/logger";

/**
 * POST /v1/chat/create-chat
 *
 * Endpoint que consume el widget (`<chat-float>`). Traduce el contrato público
 * del widget al de ms-agents y hace passthrough del streaming de texto para
 * conservar el efecto "typing".
 *
 * Entrada (widget):
 *   headers: `unique-tenant-token`, `ip-address`
 *   body:    { message, uniqueTenantToken, agentId?, chatSessionId?, ipAddress? }
 *
 * Salida:
 *   200 text/plain en streaming + header `Chat-Session-Id` (para multi-turno).
 *   4xx/5xx: se propaga el status y cuerpo de error de ms-agents (JSON).
 */
export async function createChat(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as {
    message?: string;
    uniqueTenantToken?: string;
    agentId?: string;
    chatSessionId?: string;
    ipAddress?: string;
  };

  const uniqueToken =
    (req.headers["unique-tenant-token"] as string) || body.uniqueTenantToken;
  const ipAddress =
    (req.headers["ip-address"] as string) || body.ipAddress || req.ip;
  const { message, agentId, chatSessionId } = body;

  if (!uniqueToken) {
    res.status(StatusCodes.UNAUTHORIZED).json({
      success: false,
      message: "unique-tenant-token es requerido",
    });
    return;
  }

  if (!message || !message.trim()) {
    res.status(StatusCodes.BAD_REQUEST).json({
      success: false,
      message: "message es requerido",
    });
    return;
  }

  try {
    const upstream = await getAgentsServiceClient().createChatStream({
      message,
      uniqueToken,
      agentId,
      chatPerUserId: chatSessionId,
      ipAddress,
    });

    // Propaga la sesión para encadenar memoria multi-turno en el widget.
    const sessionHeader = upstream.headers["chat-session-id"];
    const sessionId = Array.isArray(sessionHeader)
      ? sessionHeader[0]
      : sessionHeader;
    if (sessionId) {
      res.setHeader("Chat-Session-Id", sessionId);
    }

    // Reenvía el content-type real de ms-agents (text/plain en éxito,
    // application/json en error) y desactiva buffering de proxies para streaming.
    const contentType = upstream.headers["content-type"];
    res.setHeader(
      "Content-Type",
      (Array.isArray(contentType) ? contentType[0] : contentType) ||
        "text/plain; charset=utf-8"
    );
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.status(upstream.statusCode);

    // Passthrough del streaming sin bufferizar.
    upstream.body.on("error", (err: Error) => {
      logger.error("Widget chat upstream stream error", err);
      if (!res.headersSent) {
        res.status(StatusCodes.BAD_GATEWAY);
      }
      res.end();
    });

    upstream.body.pipe(res);
  } catch (error) {
    logger.error("Widget chat request failed", error);
    if (!res.headersSent) {
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        success: false,
        message: "Error de conexión con el servicio de agentes",
      });
    } else {
      res.end();
    }
  }
}
