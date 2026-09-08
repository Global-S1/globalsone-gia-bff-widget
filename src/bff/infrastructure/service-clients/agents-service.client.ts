import { BaseServiceClient } from "./base-service-client";
import { getServiceConfig, ServiceKeys } from "../config/backend-services.config";
import { IRequestContext } from "../../domain/interfaces/request-context.interface";
import { IServiceResponse } from "../../domain/interfaces/service-response.interface";
import { IServiceConfig } from "../../domain/interfaces/service-client.interface";
import { env } from "../../../entities/shared/infraestructure/config/environments";
import { IWidgetConfig } from "../../domain/interfaces/widget-config.interface";
import type { Dispatcher } from "undici";

export interface ICreateChatParams {
  message: string;
  /**
   * La organización, cuando se ha resuelto el widget (SPEC-195 · SPEC-203).
   *
   * **Es la preferida**: el ámbito sale de una señal que el llamante no
   * controla (RF-008), que es la regla de la casa y como ya se identifican
   * ms-documents, ms-customers, ms-messaging y ms-leads.
   */
  organizacionId?: string;
  /**
   * Token de organización del widget (unique_organization_token). El camino de
   * compatibilidad: lo manda el fragmento antiguo, y se usa **sólo** cuando no
   * hemos podido resolver el widget.
   */
  uniqueToken?: string;
  /** Agente entrenado al que apuntar en el primer turno. */
  agentId?: string;
  /** Sesión existente para encadenar memoria multi-turno. */
  chatPerUserId?: string;
  /** IP del usuario final (para rate-limit / auditoría en ms-agents). */
  ipAddress?: string;
  /**
   * SPEC-221 · SPEC-220 — **el widget ya resuelto** por el que entra el mensaje.
   *
   * Nunca el identificador que vino en el cuerpo: un fragmento antiguo manda el
   * del agente, y guardar ése metería un agente en la columna del widget. Sale
   * de la resolución o no va.
   */
  widgetId?: string;
  /**
   * SPEC-227 · SPEC-226 — **«vino por un widget y no sé cuál».**
   *
   * El tercer estado de la columna de SPEC-220, y **el borde es el único que lo
   * puede decir**: sabe que la petición entró por la puerta del widget aunque
   * no haya podido resolverlo. Sin esto, esa conversación se graba con el
   * centinela «no vino de ningún widget» y desaparece de la auditoría de su
   * widget contada como si fuera de otro sitio.
   *
   * Viaja como `widgetUnknown` en el cuerpo —la traducción se hace aquí, igual
   * que la de `visitanteId`— y **sólo cuando no se manda `widgetId`**: los dos
   * juntos son un 400 de ms-agents, y un 400 en esta llamada deja sin respuesta
   * a quien está conversando.
   */
  widgetDesconocido?: boolean;
  /**
   * SPEC-221 — quién escribe: el identificador que el widget conserva en el
   * navegador. Se llama `visitanteId` de este lado (SPEC-181) y `visitorId` en
   * el cuerpo que espera ms-agents; la traducción se hace aquí, que es donde
   * vive ese contrato.
   */
  visitanteId?: string;
}

/**
 * Un identificador que se puede mandar, o nada.
 *
 * ms-agents responde **400 nombrando el campo** a un `widgetId` o un
 * `visitorId` vacío o de sólo espacios (SPEC-220), y un 400 en esta llamada
 * deja sin respuesta a quien está conversando. Ausente significa «no lo sé» y
 * se atiende igual; vacío no significa nada y rompe.
 */
function identificadorQueSePuedeMandar(valor: string | undefined): string | null {
  const limpio = typeof valor === "string" ? valor.trim() : "";
  return limpio === "" ? null : limpio;
}

/**
 * Cliente HTTP hacia ms-agents. Backend principal del widget: chatbot / IA.
 *
 * El chat del widget es un canal ANÓNIMO: sus visitantes no tienen usuario, así
 * que no hay `x-user-permissions` que enviar. Lo que autoriza la llamada es
 * `x-internal-service-token` —un secreto compartido entre servicios— junto al
 * marcador de canal `x-channel: widget`. Ver `chat-access.middleware.ts` en
 * ms-agents.
 *
 * Antes esto no enviaba nada de eso y funcionaba porque el guard de ms-agents
 * concedía acceso completo al ámbito de la organización cuando llegaba un
 * `x-unique-token` sin permisos. Ese atajo se quitó en S7 / ADR 006 paso 3
 * porque era explotable por cualquier usuario autenticado sin permisos, y su
 * retirada dejó el widget devolviendo 403. `x-unique-token` sigue siendo sólo
 * identidad de organización: no autoriza nada por sí solo.
 *
 * La cuota se atribuye al usuario-servicio del widget que ms-agents resuelve a
 * partir del token de organización + el canal.
 */
export class AgentsServiceClient extends BaseServiceClient {
  /**
   * La configuración se puede inyectar, igual que en los clientes de ms-leads y
   * ms-documents. Sin eso, este cliente sólo es construible con el fichero de
   * servicios cargado, y sus rutas —que es lo que más se equivoca— quedan sin
   * poder probarse.
   */
  constructor(config?: IServiceConfig) {
    super(config ?? getServiceConfig(ServiceKeys.AGENTS));
  }

  async getStats(context: IRequestContext): Promise<IServiceResponse<any>> {
    return this.request<any>(
      { method: "GET", path: "/v1/stats", retries: 0 },
      context
    );
  }

  /**
   * SPEC-195 · ADR-037 — quién es este widget: su agente, su organización, si
   * está activo y por qué puerta entra su visitante (SPEC-167 · ADR-034).
   *
   * **La ruta es la del widget y ya no la del agente.** El widget es una
   * entidad desde SPEC-192, y `:id` vale como identificador de widget **o** de
   * agente: cuando es un agente, ms-agents devuelve su widget por defecto —el
   * más antiguo—, que es lo que sostiene los fragmentos ya pegados en webs de
   * clientes. La vieja `/v1/agents/:id/widget-config` comparte manejador y no
   * difiere en nada, así que este cambio no puede alterar comportamiento; se
   * deja de usar aquí porque su retirada es de este SPEC.
   *
   * Trae `organizationId`, y eso es lo que la hace imprescindible: este BFF
   * tiene un TOKEN de organización, que identifica pero no dice cuál es, y
   * ms-leads exige la organización en `x-tenant-id`.
   *
   * Ruta interna: lo que autoriza es el secreto compartido (ADR-011), no el
   * token del widget. Sin él, 403.
   */
  async getWidgetConfig(
    identificador: string,
    context: IRequestContext
  ): Promise<IServiceResponse<IWidgetConfig>> {
    return this.request<IWidgetConfig>(
      {
        method: "GET",
        path: `/v1/widgets/${encodeURIComponent(identificador)}/config`,
        // Un reintento y no dos: esta consulta va DELANTE de la respuesta al
        // visitante, y su fallo no le deja sin contestar —se cae al camino de
        // hoy—, así que esperar de más aquí sólo alarga el silencio.
        retries: 1,
        timeout: 3000,
        headers: {
          "x-internal-service-token": env.internalServiceToken ?? "",
        },
      },
      context
    );
  }

  /**
   * SPEC-202 · RF-025 · ADR-038 — apunta desde dónde se cargó este widget.
   *
   * Se le manda **el dominio ya extraído**, aunque la ruta admita también una
   * dirección completa: lo que sale de este servicio es lo que se va a guardar,
   * y no hay razón para que cruce la red un camino o una consulta que allí se
   * van a tirar.
   *
   * `anotado` dice si escribió o si lo frenó — **el freno vive allí**
   * (SPEC-202), que es el único que sabe cuándo se escribió por última vez.
   *
   * **Sin reintentos y con poca espera**: es una observación que nadie está
   * mirando, y va en el mismo camino por el que alguien espera una respuesta.
   */
  async apuntarVisto(
    widgetId: string,
    dominio: string,
    context: IRequestContext
  ): Promise<IServiceResponse<{ anotado: boolean }>> {
    return this.request<{ anotado: boolean }>(
      {
        method: "POST",
        path: `/v1/widgets/${encodeURIComponent(widgetId)}/visto`,
        retries: 0,
        timeout: 3000,
        headers: {
          "x-internal-service-token": env.internalServiceToken ?? "",
        },
        body: { origin: dominio },
      },
      { correlationId: context.correlationId, timestamp: context.timestamp }
    );
  }

  /**
   * Inicia/continúa una conversación contra ms-agents y devuelve la respuesta
   * undici SIN consumir el body, para que el controller pueda hacer passthrough
   * del streaming (text/plain) directamente al widget y leer el header
   * `chat-session-id`.
   */
  async createChatStream(
    params: ICreateChatParams
  ): Promise<Dispatcher.ResponseData> {
    const { request } = await import("undici");
    const url = `${this.config.baseUrl}/v1/chat/create-chat`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/plain",
      // Identity translation: el token del widget identifica la organización.
      // OJO: identifica, no autoriza. Ver el comentario de la clase.
      // Marca de canal: ms-agents aplica el tope diario por usuario final (IP)
      // solo cuando el canal es widget, y es una de las tres condiciones que
      // `chat-access.middleware.ts` exige para admitir un visitante anónimo.
      "x-channel": "widget",
      // La llave que de verdad autoriza este canal. Un secreto, no una cabecera
      // declarativa: cualquiera que alcance ms-agents por la red compartida
      // podría enviarse `x-user-permissions`, pero no este valor. Tiene que
      // coincidir con el INTERNAL_SERVICE_TOKEN de ms-agents.
      "x-internal-service-token": env.internalServiceToken ?? "",
    };

    // **El ámbito de organización: una señal y no dos** (SPEC-203).
    //
    // ms-agents admite `x-tenant-id` (preferido) o `x-unique-token`, y se le
    // manda UNA. Mandar las dos es lo que hasta hoy devolvía un 200 con la
    // segunda ignorada en silencio y ahora se rechaza si discrepan — y aquí
    // pueden discrepar de verdad: el token lo pega una persona en el HTML de su
    // web y la organización sale de resolver el widget. Cuando hemos resuelto,
    // la buena es la resuelta.
    if (params.organizacionId) {
      headers["x-tenant-id"] = params.organizacionId;
    } else if (params.uniqueToken) {
      headers["x-unique-token"] = params.uniqueToken;
    }

    if (params.ipAddress) {
      headers["ip-address"] = params.ipAddress;
    }

    // Identidad del widget: los visitantes son anónimos, así que el agentId
    // (público, ya viaja en el snippet) hace de x-user-id. ms-agents no valida
    // este id contra ms-auth; sin membership, la cuota se rige por el límite de
    // la organización + el tope por-IP del agente. El aislamiento de memoria lo
    // da el chatSessionId (UUID por conversación), no la identidad.
    if (params.agentId) {
      headers["x-user-id"] = params.agentId;
    }

    // Primer turno: se ata el agente entrenado. Turnos siguientes: se encadena
    // la sesión existente (el agentId ya quedó ligado a la sesión en ms-agents).
    const payload: Record<string, unknown> = { message: params.message };
    if (params.chatPerUserId) {
      payload.chatPerUserId = params.chatPerUserId;
    } else if (params.agentId) {
      payload.agentId = params.agentId;
    }

    // **De qué widget viene y quién escribe** (SPEC-221 · SPEC-220).
    //
    // Van en el CUERPO y no en una cabecera porque es donde ms-agents los
    // declara, en el validador que comparten la ruta corriente y la de
    // respuesta estructurada. Ese validador **descarta en silencio lo que no
    // conoce**: un nombre equivocado aquí no da error en ningún sitio, sólo
    // deja la columna vacía para siempre y la auditoría del widget en blanco.
    //
    // `x-user-id` **no se toca**, aunque sea lo que hoy hace que todas las
    // conversaciones de un widget parezcan la misma persona: de esa cabecera
    // cuelgan el guard de canal anónimo de ms-agents y a quién se le imputa la
    // cuota. Quién escribió se dice por el cuerpo, que es donde SPEC-220 lo
    // pide, y así esto no cambia nada de lo que ya funciona.
    //
    // Se mandan también al continuar: ms-agents marca las columnas **al nacer**
    // y no las reescribe, así que mandarlas siempre no puede alterar lo ya
    // guardado — y no mandarlas obligaría a este borde a adivinar cuál es el
    // primer turno, que es justo lo que `chatPerUserId` no dice con certeza.
    //
    // **Y cuándo no se sabe cuál** (SPEC-227 · SPEC-226): `widgetUnknown` es el
    // tercer estado, el que separa «no vino de ningún widget» de «no sabemos de
    // cuál vino». Sin él, ms-agents escribe el centinela de «ninguno» y la
    // conversación desaparece de la auditoría de su widget.
    //
    // **La exclusión es estructural y se decide aquí**, en el único sitio por
    // el que pasan todos los llamantes: un `else if` y no dos `if`. Las dos
    // señales en el mismo cuerpo son un **400** del otro lado —una
    // contradicción, y la rechaza con razón—, y un 400 en esta llamada deja sin
    // respuesta a quien está conversando con un widget sano. Garantizarlo donde
    // se arma el cuerpo, y no confiarlo a quien llama, es lo que hace que
    // ninguna rama futura del controlador pueda provocar ese 400.
    //
    // Y se decide sobre **lo que de verdad se manda**, no sobre lo que llegó.
    // Un `widgetId` de sólo espacios no se manda —sería otro 400 (SPEC-221)—,
    // así que mirar el parámetro en vez del cuerpo dejaría ese caso sin
    // ninguna de las dos señales: afirmando «ninguno» otra vez. Hoy el
    // controlador no puede producir esa combinación —apaga la declaración en la
    // misma línea en que resuelve el widget—, y por eso esto es una condición
    // de la garantía y no un caso de negocio: la sostiene sin depender de que
    // quien llama siga comportándose como se comporta hoy.
    //
    // `false` no se manda nunca: del otro lado ausente, nulo y `false` son la
    // misma cosa (SPEC-226), así que mandarlo sería un campo de más en el cable
    // que no distingue nada.
    const widget = identificadorQueSePuedeMandar(params.widgetId);
    if (widget) {
      payload.widgetId = widget;
    } else if (params.widgetDesconocido) {
      payload.widgetUnknown = true;
    }
    const visitante = identificadorQueSePuedeMandar(params.visitanteId);
    if (visitante) {
      payload.visitorId = visitante;
    }

    return request(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      headersTimeout: 30000,
      bodyTimeout: 120000,
    });
  }
}

let instance: AgentsServiceClient | null = null;

export function getAgentsServiceClient(): AgentsServiceClient {
  if (!instance) instance = new AgentsServiceClient();
  return instance;
}
