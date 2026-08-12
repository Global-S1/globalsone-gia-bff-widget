import { BaseServiceClient } from "./base-service-client";
import { getServiceConfig, ServiceKeys } from "../config/backend-services.config";
import { IRequestContext } from "../../domain/interfaces/request-context.interface";
import { IServiceResponse } from "../../domain/interfaces/service-response.interface";
import { env } from "../../../entities/shared/infraestructure/config/environments";
import type { Dispatcher } from "undici";

export interface ICreateChatParams {
  message: string;
  /** Token de organización del widget (unique_organization_token). */
  uniqueToken: string;
  /** Agente entrenado al que apuntar en el primer turno. */
  agentId?: string;
  /** Sesión existente para encadenar memoria multi-turno. */
  chatPerUserId?: string;
  /** IP del usuario final (para rate-limit / auditoría en ms-agents). */
  ipAddress?: string;
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
  constructor() {
    super(getServiceConfig(ServiceKeys.AGENTS));
  }

  async getStats(context: IRequestContext): Promise<IServiceResponse<any>> {
    return this.request<any>(
      { method: "GET", path: "/v1/stats", retries: 0 },
      context
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
      "x-unique-token": params.uniqueToken,
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
