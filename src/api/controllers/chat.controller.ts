import { Request, Response } from "express";
import { StatusCodes } from "../../entities/shared/infraestructure/lib/http-status-codes";
import { getAgentsServiceClient } from "../../bff/infrastructure/service-clients/agents-service.client";
import {
  getLeadsServiceClient,
  IRespuestaDeLeads,
} from "../../bff/infrastructure/service-clients/leads-service.client";
import { obtenerConfiguracionDeWidget } from "../../bff/application/use-cases/widget-config.use-case";
import { IRequestContext } from "../../bff/domain/interfaces/request-context.interface";
import { IServiceResponse } from "../../bff/domain/interfaces/service-response.interface";
import { logger } from "../../entities/shared/infraestructure/utils/logger";
import {
  CABECERA_DE_FOTOS,
  codificarFotos,
} from "./fotos-en-cabecera";
import {
  CABECERA_DE_FICHEROS,
  codificarFicheros,
} from "./ficheros-en-cabecera";

/**
 * POST /v1/chat/create-chat
 *
 * Endpoint que consume el widget (`<chat-float>`).
 *
 * **Desde SPEC-167 hay dos puertas y no una** (ADR-034). Antes de atender se
 * mira la configuración de widget del agente (SPEC-162): si tiene encendida la
 * clasificación de leads, el mensaje entra por ms-leads —que lo atiende con la
 * misma máquina de estados que un mensaje de Telegram y contesta en la misma
 * petición—; si no, sigue yendo a ms-agents exactamente como hasta hoy.
 *
 * Entrada (widget):
 *   headers: `unique-tenant-token`, `ip-address`
 *   body:    { message, uniqueTenantToken, agentId?, chatSessionId?, ipAddress?,
 *              visitanteId? }
 *
 * Salida, **la misma forma por las dos puertas**: `200 text/plain` con el texto
 * de la respuesta. Por el camino de ms-agents se sirve según se escribe, para
 * conservar el efecto de escritura; por el de ms-leads llega entero y se
 * escribe de una vez —la ruta de campos necesita el objeto completo antes de
 * poder decir nada (ADR-034)— pero lo que el widget lee es idéntico.
 *   · `Chat-Session-Id`: sólo por el camino de ms-agents; es SU sesión.
 *   · `Contact-Form-Url`: sólo cuando ms-leads derivó y el tenant tiene
 *     formulario configurado (RF-020).
 *   · `Chat-Photos`: las fotos que el agente señaló, codificadas (SPEC-183).
 *     Sólo por el camino de ms-leads y sólo cuando hay alguna.
 *   · `Chat-Files`: los ficheros que apartó, con su título y su llave, también
 *     codificados (SPEC-188). Mismas condiciones.
 *   · 4xx/5xx: JSON `{ success, message }` — `message` es lo que el widget
 *     enseña a quien escribe.
 */

/**
 * Lo que se le dice a quien escribe cuando no hemos podido atenderle.
 *
 * Escrito aquí y no traído del error: lo que devuelve un servicio interno puede
 * traer dentro detalles de nuestra configuración, y esto se pinta en una página
 * que no controlamos.
 */
const NO_TE_PUEDO_ATENDER =
  "No he podido responderte ahora mismo. Vuelve a intentarlo en un momento.";

export async function createChat(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as {
    message?: string;
    uniqueTenantToken?: string;
    agentId?: string;
    chatSessionId?: string;
    ipAddress?: string;
    visitanteId?: string;
  };

  const uniqueToken =
    (req.headers["unique-tenant-token"] as string) || body.uniqueTenantToken;
  const ipAddress =
    (req.headers["ip-address"] as string) || body.ipAddress || req.ip;
  const { message, agentId, chatSessionId } = body;

  // La identidad del lead en este canal (RF-018 · GLO-013): el identificador
  // que el widget conserva en el navegador. Sólo lo puede saber el navegador,
  // así que llega en el cuerpo; sin él no se puede entrar por leads.
  //
  // Se llama `visitanteId` **y sólo así** (SPEC-181): es el nombre con el que
  // el widget lo manda (SPEC-168) y con el que ms-leads lo espera (SPEC-164).
  // El nombre en inglés que había aquí no lo mandó nunca nadie, así que no hay
  // compatibilidad que guardar; y admitir dos nombres para el mismo dato es
  // justo lo que dejó pasar este fallo hasta producción.
  const visitanteId =
    typeof body.visitanteId === "string" ? body.visitanteId.trim() : "";

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

  const context: IRequestContext = {
    correlationId: (req.headers["x-correlation-id"] as string) || "",
    timestamp: new Date(),
  };

  // ── La puerta ────────────────────────────────────────────────────────────
  // Sin agente no hay a quién preguntarle nada: se atiende por el camino de
  // siempre, que es el que sabe resolver el agente desde el token.
  if (agentId) {
    const configuracion = await obtenerConfiguracionDeWidget(agentId, context);

    if (configuracion?.leadsEnabled) {
      if (visitanteId) {
        await atenderPorLeads(res, context, {
          organizacionId: configuracion.organizationId,
          agenteId: agentId,
          visitanteId,
          texto: message,
          ...(ipAddress ? { ip: ipAddress } : {}),
        });
        return;
      }

      // El interruptor está encendido pero el widget no manda identidad de
      // visitante. Se atiende igual —quedarse mudo sería peor— y queda
      // constancia, porque desde fuera esto se ve como «los leads no entran».
      logger.warn(
        "Agente con leads encendido y mensaje sin visitanteId: se atiende por ms-agents",
        { agentId }
      );
    }
  }

  await atenderPorAgents(res, {
    message,
    uniqueToken,
    agentId,
    chatPerUserId: chatSessionId,
    ipAddress,
  });
}

/**
 * El camino de hoy: ms-agents, servido según se escribe. **No cambia.** Hay
 * escenarios de SPEC-167 que lo exigen tal cual.
 */
async function atenderPorAgents(
  res: Response,
  params: {
    message: string;
    uniqueToken: string;
    agentId?: string;
    chatPerUserId?: string;
    ipAddress?: string;
  }
): Promise<void> {
  try {
    const upstream = await getAgentsServiceClient().createChatStream(params);

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

/**
 * La puerta de Gia Leads (SPEC-164 · ADR-034).
 *
 * **Si ms-leads falla NO se reintenta por ms-agents.** La conversación tiene un
 * solo dueño: contestar por el otro camino dejaría fuera de la conversación un
 * turno que el visitante sí vio, que es justo lo que ADR-034 decidió evitar.
 */
async function atenderPorLeads(
  res: Response,
  context: IRequestContext,
  mensaje: {
    organizacionId: string;
    agenteId: string;
    visitanteId: string;
    texto: string;
    ip?: string;
  }
): Promise<void> {
  let respuesta: IServiceResponse<IRespuestaDeLeads>;
  try {
    respuesta = await getLeadsServiceClient().atenderMensajeDelWidget(
      mensaje,
      context
    );
  } catch (error) {
    logger.error("Widget leads request failed", error);
    res
      .status(StatusCodes.BAD_GATEWAY)
      .json({ success: false, message: NO_TE_PUEDO_ATENDER });
    return;
  }

  if (!respuesta.success || !respuesta.data) {
    logger.error("ms-leads no atendió el mensaje del widget", {
      agenteId: mensaje.agenteId,
      statusCode: respuesta.statusCode,
      error: respuesta.error,
    });
    res.status(StatusCodes.BAD_GATEWAY).json({
      success: false,
      message: fraseParaElVisitante(respuesta),
    });
    return;
  }

  const enlace = enlaceQueSePuedeOfrecer(respuesta.data.formularioDeContacto);
  // SPEC-183 · RF-021: las fotos van FUERA del cuerpo, porque el cuerpo es el
  // texto que lee quien escribe. Si no cabe ninguna se manda el texto sin
  // ellas: antes menos fotos que dejar al visitante sin respuesta.
  const fotos = codificarFotos(respuesta.data.fotos);
  // SPEC-188: y sus hermanos, los ficheros. Cada cabecera tiene su reserva del
  // presupuesto compartido, así que un turno con muchas fotos no puede apagar
  // en silencio el fichero que el agente acaba de prometer.
  const ficheros = codificarFicheros(respuesta.data.ficheros);

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  if (enlace) {
    res.setHeader("Contact-Form-Url", enlace);
  }
  if (fotos) {
    res.setHeader(CABECERA_DE_FOTOS, fotos);
  }
  if (ficheros) {
    res.setHeader(CABECERA_DE_FICHEROS, ficheros);
  }
  res.status(StatusCodes.OK);
  // `texto: null` es un estado terminal de la conversación, no un fallo: ahí no
  // habla nadie, y un texto vacío en su lugar le pintaría al visitante un globo
  // en blanco que parece una avería del widget.
  res.end(respuesta.data.texto ?? "");
}

/**
 * Qué se le enseña a quien escribe cuando ms-leads no atendió.
 *
 * **Sólo el 502 trae una frase suya**, escrita a propósito para un visitante
 * (SPEC-164). Lo demás —403 sin token interno, 400 sin tenant, 422 con datos
 * incompletos, 503 sin cablear— son fallos de configuración NUESTROS: enseñarle
 * eso a un visitante no le sirve de nada y cuenta cómo está montado esto por
 * dentro. El motivo de verdad se queda en el registro.
 */
function fraseParaElVisitante(
  respuesta: IServiceResponse<IRespuestaDeLeads>
): string {
  if (respuesta.statusCode === StatusCodes.BAD_GATEWAY) {
    const detalles = respuesta.error?.details as
      | { error?: unknown }
      | undefined;
    if (typeof detalles?.error === "string" && detalles.error.trim()) {
      return detalles.error;
    }
  }
  return NO_TE_PUEDO_ATENDER;
}

/**
 * El enlace del formulario, normalizado, o nada.
 *
 * ms-agents ya rechaza al guardarlo lo que no sea `http`/`https` (SPEC-162),
 * pero esto es el borde que da a un navegador ajeno: un salto de línea dentro
 * de un valor de cabecera hace que `setHeader` reviente la respuesta entera, y
 * ahí el visitante se queda sin la que ya estaba escrita.
 */
function enlaceQueSePuedeOfrecer(url: string | null): string | null {
  if (!url) return null;
  try {
    const analizada = new URL(url);
    if (analizada.protocol !== "http:" && analizada.protocol !== "https:") {
      return null;
    }
    // `href` y no el original: el analizador quita los caracteres de control
    // que el original podría llevar dentro.
    return analizada.href;
  } catch {
    return null;
  }
}
