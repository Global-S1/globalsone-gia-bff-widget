import { BaseServiceClient } from "./base-service-client";
import { getServiceConfig, ServiceKeys } from "../config/backend-services.config";
import { IRequestContext } from "../../domain/interfaces/request-context.interface";
import { IServiceResponse } from "../../domain/interfaces/service-response.interface";
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
 * El chat del widget opera en el "modo API externa" de ms-agents: se envía la
 * identidad de organización por `x-unique-token` y NO se envía
 * `x-user-permissions`, con lo que el guard concede acceso completo dentro del
 * scope de la organización. La cuota se atribuye al usuario-servicio del widget
 * que ms-agents resuelve internamente a partir del token de organización + el
 * marcador de canal `x-channel: widget`.
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
      "x-unique-token": params.uniqueToken,
      // Marca de canal: ms-agents aplica el tope diario por usuario final (IP)
      // solo cuando el canal es widget.
      "x-channel": "widget",
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
