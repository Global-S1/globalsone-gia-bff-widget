import { Request, Response } from "express";
import { StatusCodes } from "../../entities/shared/infraestructure/lib/http-status-codes";
import { getAgentsServiceClient } from "../../bff/infrastructure/service-clients/agents-service.client";
import {
  getLeadsServiceClient,
  IRespuestaDeLeads,
} from "../../bff/infrastructure/service-clients/leads-service.client";
import { resolverWidget } from "../../bff/application/use-cases/widget-config.use-case";
import { apuntarOrigen } from "../../bff/application/use-cases/apuntar-origen.use-case";
import { decidirPorDominio } from "../../bff/application/use-cases/bloqueo-por-dominio.use-case";
import { dominioDelOrigen } from "../../bff/domain/dominio-del-origen";
import { IRequestContext } from "../../bff/domain/interfaces/request-context.interface";
import { IServiceResponse } from "../../bff/domain/interfaces/service-response.interface";
import { logger } from "../../entities/shared/infraestructure/utils/logger";
import { ficherosDeLaCabecera, fotosDeLaCabecera } from "./lo-que-vuelve-de-agents";
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
 * **Desde SPEC-196 esa misma resolución puede cerrar la puerta** (RF-025 ·
 * ADR-038): si el widget tiene el bloqueo encendido y el `Origin` no está entre
 * los dominios que su tenant registró, se contesta una frase y no se llama a
 * nadie — ni al modelo ni a la cuota. La decisión se toma **aquí dentro** y el
 * CORS se queda abierto a propósito.
 *
 * **Desde SPEC-221 el mensaje dice de quién es** (SPEC-220): al hablar con el
 * servicio del agente van, además, el widget ya resuelto y el identificador de
 * visitante. Los dos son datos que sólo este borde tiene delante y que hasta
 * hoy se tiraban aquí, y **por los dos caminos por igual** — el del agente y el
 * de leads—: si sólo atribuyera uno, encender la clasificación de leads
 * volvería un widget menos auditable que uno sin ella. Nada de esto cambia lo
 * que ve quien conversa.
 *
 * **Desde SPEC-227 también dice cuándo NO lo sabe** (SPEC-226): si resolver
 * tropieza, o si el fragmento es tan viejo que sólo trae el token de
 * organización, se declara que vino de un widget desconocido en vez de callar.
 * Callar aquí no es neutral —ms-agents guarda entonces su centinela de «no vino
 * de ningún widget»—, y este borde es el único que tiene las dos mitades de la
 * frase: sabe que entró por su puerta y sabe que no ha podido resolver cuál.
 * **Las dos señales nunca salen juntas**: el otro lado lo rechaza con un 400, y
 * un 400 aquí deja mudo un widget que está perfectamente bien.
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

/**
 * La tercera, y por el mismo motivo que las otras dos (SPEC-196).
 *
 * Quien la lee es el visitante, pero quien puede arreglarlo es quien instaló el
 * widget: aquí el arreglo es registrar el dominio, y ni «no existe» ni «está
 * apagado» le llevarían a mirar ahí.
 *
 * **No repite el dominio que vino.** El `Origin` lo pone quien llama y esto se
 * pinta en una página que no controlamos: devolverlo sería enseñar en el widget
 * de un tercero lo que un tercero mandó.
 *
 * Comparte el 403 con «no está disponible» y no estrena código: 403 es lo que
 * de verdad es esto —quien llama no está autorizado—, y elegir otro sólo para
 * distinguirlo obligaría a torcer el significado del código para repetir una
 * distinción que la frase ya lleva.
 */
const DOMINIO_NO_AUTORIZADO =
  "Este dominio no está autorizado para usar este asistente.";

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

  // **El widget al que atribuir la conversación** (SPEC-221 · SPEC-220).
  //
  // Sale de la resolución y **nunca del cuerpo**: `identificador` puede ser el
  // del agente —el fragmento antiguo—, y guardar ése metería un identificador
  // de agente en la columna del widget, dejando vacía para siempre la auditoría
  // del widget que de verdad atendió.
  //
  // Se queda sin valor cuando no se ha podido resolver, que es lo que pide el
  // SPEC: sin resolución no se dice ningún widget y se atiende como hasta ahora.
  let widgetAlQueAtribuir: string | undefined;

  // **Y que vino de un widget aunque no sepamos cuál** (SPEC-227 · SPEC-226).
  //
  // Este borde sirve a una superficie y a una sola (ADR-001), así que **toda
  // petición que entra aquí entró por la puerta del widget**, se resuelva o no.
  // Lo único que puede faltar es cuál — y las dos mitades de esa frase no las
  // tiene nadie más: ms-agents recibe un cuerpo sin `widgetId` y no puede
  // distinguir «no vino de ninguno» de «no se supo cuál».
  //
  // **Empieza declarado y sólo se apaga al resolver.** No decir nada no deja la
  // conversación sin widget: la deja con el centinela «ninguno» que ms-agents
  // escribe cuando no se le dice nada (SPEC-220), es decir, **afirmando algo
  // falso** que la borra de la auditoría del widget que sí la atendió y la
  // cuenta como si viniera de otro sitio.
  //
  // Empezando así, el fragmento antiguo que sólo trae el token de organización
  // queda cubierto sin una rama propia: no hay identificador que resolver, no
  // se le pregunta a nadie, y esto nunca se apaga. Que es exactamente lo que
  // hay que decir de él.
  let widgetDesconocido = true;

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
      widgetAlQueAtribuir = configuracion.widgetId;
      // **Sabemos cuál, así que se dice cuál y no se declara nada** (SPEC-227).
      //
      // Se apaga aquí, pegado a la línea que enciende la otra señal, y no en
      // otro sitio: son las dos mitades de una misma decisión, y separarlas es
      // lo que dejaría que un día salieran las dos a la vez — que del otro lado
      // es un 400, o sea, un widget sano que se queda mudo.
      widgetDesconocido = false;

      // **Desde dónde se está cargando** (RF-025 · ADR-038). Va aquí, en cuanto
      // se sabe de qué widget es, y **antes de mirar si está activo**: lo que
      // se observa es dónde está pegado el fragmento, y uno apagado sigue
      // estando pegado — que es justamente lo que el tenant necesita ver.
      //
      // No se espera: es una observación, no parte de contestar.
      const origen = req.headers.origin as string | undefined;
      apuntarOrigen(configuracion.widgetId, origen, context);

      // ── El bloqueo por dominio (SPEC-196 · RF-025 · ADR-038) ──────────────
      //
      // **Se decide aquí dentro y no en el CORS**, que se queda abierto: si se
      // rechazara en el borde, el navegador cortaría antes de que la página
      // pudiera leer la frase, y entregar la frase es el objetivo.
      //
      // Va **después de apuntar** —el intento queda constando igual, que es lo
      // que el tenant necesita ver— y **antes de las dos puertas**, que es lo
      // que hace que una petición bloqueada no gaste ni modelo ni cuota: el
      // tope diario lo aplica ms-agents sobre lo que le llega, así que lo que
      // no se le manda no se cuenta. Ese ahorro es el motivo entero de la
      // medida.
      //
      // Y antes de mirar si está activo, que es una decisión de aquí y no del
      // SPEC: a quien no está autorizado no se le cuenta en qué estado está el
      // widget de otro.
      if (decidirPorDominio(configuracion, origen) === "no-autorizado") {
        logger.warn("Un widget con el bloqueo encendido recibió un mensaje desde un dominio que no tiene registrado", {
          widgetId: configuracion.widgetId,
          // El dominio ya normalizado y nunca la cabecera en crudo: lo que se
          // registra no lo escribe quien llama.
          dominio: dominioDelOrigen(origen),
        });
        res
          .status(StatusCodes.FORBIDDEN)
          .json({ success: false, message: DOMINIO_NO_AUTORIZADO });
        return;
      }

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
            // **Los dos caminos atribuyen igual** (SPEC-221). Si sólo lo
            // hiciera el del agente, encender la clasificación de leads
            // volvería un widget MENOS auditable que uno sin ella, que es lo
            // contrario de lo que se busca.
            widgetId: configuracion.widgetId,
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
    // **De quién es este mensaje** (SPEC-221). Los dos se pasan cuando se
    // tienen y **no se inventan cuando no**: un identificador por defecto
    // convertiría a todos los visitantes desconocidos en el mismo, que es justo
    // el defecto que esto viene a corregir.
    ...(widgetAlQueAtribuir ? { widgetId: widgetAlQueAtribuir } : {}),
    // **Y cuando no se ha podido resolver, que vino de uno igual** (SPEC-227).
    // Es la única forma de que esta conversación no se grabe afirmando que no
    // vino de ningún widget.
    ...(widgetDesconocido ? { widgetDesconocido: true } : {}),
    ...(visitanteId ? { visitanteId } : {}),
  });
}

/**
 * El camino de hoy: ms-agents, servido según se escribe. **No cambia lo que
 * lee quien conversa**, y hay escenarios de SPEC-167 que lo exigen tal cual.
 *
 * Desde SPEC-221 lleva dos datos más sobre la conversación —el widget y el
 * visitante—, que ms-agents guarda al nacer y no devuelve a nadie por aquí.
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
    /** SPEC-221 — el widget resuelto, o nada si no se ha podido resolver. */
    widgetId?: string;
    /**
     * SPEC-227 — que vino de un widget del que no sabemos cuál. Va sin el
     * anterior y nunca con él.
     */
    widgetDesconocido?: boolean;
    /** SPEC-221 — quién escribe, o nada si el widget no lo mandó. */
    visitanteId?: string;
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
    /*
     * SPEC-253 · RF-033 — lo que el agente apartó, también por el camino corto.
     *
     * ms-agents lo devuelve en dos cabeceras propias y aquí se traducen a las
     * dos que el widget ya sabe leer, con sus mismas reservas de presupuesto.
     * **Una sola forma venga por donde venga**: quien escribe no puede notar por
     * qué camino entró su mensaje.
     */
    const ficheros = ficherosDeLaCabecera(upstream.headers["chat-resources"]);
    if (ficheros) {
      res.setHeader(CABECERA_DE_FICHEROS, ficheros);
    }
    const fotosDelAgente = fotosDeLaCabecera(upstream.headers["chat-photos"]);
    if (fotosDelAgente) {
      res.setHeader(CABECERA_DE_FOTOS, fotosDelAgente);
    }

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
    /** SPEC-221 — el widget resuelto, para que este camino atribuya igual. */
    widgetId?: string;
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
