import { Request, Response } from "express";
import { StatusCodes } from "../../entities/shared/infraestructure/lib/http-status-codes";
import { getAgentsServiceClient } from "../../bff/infrastructure/service-clients/agents-service.client";
import {
  getLeadsServiceClient,
  IRespuestaDeLeads,
} from "../../bff/infrastructure/service-clients/leads-service.client";
import { resolverWidget } from "../../bff/application/use-cases/widget-config.use-case";
import { apuntarOrigen } from "../../bff/application/use-cases/apuntar-origen.use-case";
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
 * **Desde SPEC-195 la puerta se entiende con un widget** (ADR-037), que ya es
 * una entidad y no una faceta del agente: el cuerpo gana `widgetId`, y de
 * resolverlo salen su agente, su organización, si está activo y su interruptor
 * de leads. Un mensaje **sin** `widgetId` se resuelve por el agente, que es lo
 * que sostiene los fragmentos ya pegados en webs de clientes.
 *
 * Entrada (widget):
 *   headers: `unique-tenant-token` (sólo compatibilidad), `ip-address`,
 *            `Origin` (lo pone el navegador; se apunta su dominio, RF-025)
 *   body:    { message, widgetId?, uniqueTenantToken, agentId?, chatSessionId?,
 *              ipAddress?, visitanteId? }
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

/**
 * Las dos frases de SPEC-195, y **son dos a propósito**.
 *
 * Las lee quien conversa, pero quien tiene que actuar es quien instaló el
 * widget: «lo apagaste» y «te equivocaste de identificador» son dos problemas
 * con dos arreglos distintos, y una sola frase para ambos convierte diez
 * minutos de revisión en una tarde. Van con códigos distintos por lo mismo.
 *
 * Ninguna cuenta nada de dentro: ni el identificador, ni el agente, ni la
 * organización, ni lo que dijo ms-agents.
 */
const NO_EXISTE = "No he podido encontrar este asistente.";
const NO_ESTA_DISPONIBLE = "Este asistente no está disponible en este momento.";

export async function createChat(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as {
    message?: string;
    /**
     * SPEC-195 · ADR-037 — la entidad que atiende. Con él dejan de hacer falta
     * el agente y la organización: los dos salen de resolverlo.
     */
    widgetId?: string;
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
  const { message, widgetId, agentId, chatSessionId } = body;

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

  // **Hace falta con qué identificar la organización, y ya hay dos formas**
  // (SPEC-195): el identificador del widget, del que se resuelve todo, o el
  // token de organización del fragmento antiguo. Sin ninguno de los dos no hay
  // a quién imputar la conversación ni contra qué cuota contarla.
  if (!uniqueToken && !widgetId) {
    res.status(StatusCodes.UNAUTHORIZED).json({
      success: false,
      message: "widgetId o unique-tenant-token es requerido",
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
  //
  // **El widget manda sobre el agente cuando vienen los dos** (SPEC-195): el
  // widget es la entidad y el agente del cuerpo es el dato viejo que se está
  // retirando. Sin ninguno de los dos no hay a quién resolver y se atiende por
  // el camino de siempre, que sabe sacar el agente del token: es el fragmento
  // más antiguo de todos y sigue funcionando.
  const identificador = widgetId || agentId;

  // El agente al que apuntar. Sale de la resolución en cuanto la haya, porque
  // con sólo `widgetId` el cuerpo no lo trae.
  let agenteDelWidget = agentId;
  // Y la organización, que es la señal con la que se habla con ms-agents en
  // cuanto sabemos quién es el widget (SPEC-203).
  let organizacionDelWidget: string | undefined;

  if (identificador) {
    const resolucion = await resolverWidget(identificador, context);

    if (resolucion.tipo === "no-existe") {
      // Y no se llama a nadie más: no hay agente al que preguntar.
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ success: false, message: NO_EXISTE });
      return;
    }

    if (resolucion.tipo === "resuelto") {
      const configuracion = resolucion.config;
      agenteDelWidget = configuracion.agentId;
      organizacionDelWidget = configuracion.organizationId;

      // **Desde dónde se está cargando** (RF-025 · ADR-038). Va aquí, en cuanto
      // se sabe de qué widget es, y **antes de mirar si está activo**: lo que
      // se observa es dónde está pegado el fragmento, y uno apagado sigue
      // estando pegado — que es justamente lo que el tenant necesita ver.
      //
      // No se espera: es una observación, no parte de contestar.
      apuntarOrigen(
        configuracion.widgetId,
        req.headers.origin as string | undefined,
        context
      );

      if (!configuracion.active) {
        // Un widget apagado no gasta modelo: se contesta antes de las dos
        // puertas, no dentro de una.
        logger.warn("Un widget desactivado recibió un mensaje", {
          widgetId: configuracion.widgetId,
        });
        res
          .status(StatusCodes.FORBIDDEN)
          .json({ success: false, message: NO_ESTA_DISPONIBLE });
        return;
      }

      if (configuracion.leadsEnabled) {
        if (visitanteId) {
          await atenderPorLeads(res, context, {
            organizacionId: configuracion.organizationId,
            agenteId: configuracion.agentId,
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
          { agentId: configuracion.agentId }
        );
      }
    }
    // `no-se-sabe` cae aquí sin más: se atiende como hoy (SPEC-167).
  }

  await atenderPorAgents(res, {
    message,
    // Una señal y no dos (SPEC-203): la organización resuelta manda, y el token
    // sólo se usa cuando no hemos podido resolver el widget.
    ...(organizacionDelWidget
      ? { organizacionId: organizacionDelWidget }
      : { uniqueToken }),
    agentId: agenteDelWidget,
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
    organizacionId?: string;
    uniqueToken?: string;
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
