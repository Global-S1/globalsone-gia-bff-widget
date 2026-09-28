import { BaseServiceClient } from "../../../bff/infrastructure/service-clients/base-service-client";
import { getServiceConfig, ServiceKeys } from "../../../bff/infrastructure/config/backend-services.config";
import type { IRequestContext } from "../../../bff/domain/interfaces/request-context.interface";
import type { IServiceResponse } from "../../../bff/domain/interfaces/service-response.interface";

/**
 * Cliente hacia ms-agents, recortado a lo que el panel necesita: el consumo de
 * un hilo, el nombre del agente y **la superficie que ms-agents presta a los
 * servicios** (SPEC-104 · RF-013) para las herramientas de quien atiende.
 *
 * Esa superficie no es la puerta de usuario —que exige `agent:read`, y quien
 * atiende no lo tiene—: lo que autoriza es el secreto compartido, y quién puede
 * pedir qué en nombre de quién lo decide el controlador de Leads.
 */

export interface IAgentData {
  id: string;
  name?: string;
  [clave: string]: unknown;
}

export interface IRecursoDelAgente {
  id: string;
  agentId?: string;
  title: string;
  intention: string;
  documentServiceId: string | null;
  ficheros?: { id: string; documentServiceId: string }[];
  createdAt?: string;
}

export interface IConsumoDeSesion {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  interacciones: number;
  sinAnotar: number;
}

export class AgentsServiceClient extends BaseServiceClient {
  constructor() {
    super(getServiceConfig(ServiceKeys.AGENTS));
  }

  /** ms-agents identifica la organización por `x-organization-token`. */
  protected override buildHeaders(customHeaders: Record<string, string> | undefined, context: IRequestContext) {
    const headers = super.buildHeaders(customHeaders, context);
    if (context.tenantId) headers["x-organization-token"] = context.tenantId;
    return headers;
  }

  private cabecerasDeServicio(): Record<string, string> {
    const token = process.env["INTERNAL_SERVICE_TOKEN"];
    return token ? { "x-internal-service-token": token } : {};
  }

  /** Sin reintentos: es un dato de adorno en una ficha. */
  consumoDeSesion(sesionId: string, context: IRequestContext): Promise<IServiceResponse<IConsumoDeSesion>> {
    return this.request({ method: "GET", path: `/v1/chat/usage/${encodeURIComponent(sesionId)}`, retries: 0 }, context);
  }

  getAgentById(id: string, context: IRequestContext): Promise<IServiceResponse<IAgentData>> {
    return this.request(
      { method: "GET", path: `/v1/agent/find-agent-by-id/${encodeURIComponent(id)}`, headers: this.cabecerasDeServicio() },
      context,
    );
  }

  recursosPrestados(agentId: string, context: IRequestContext): Promise<IServiceResponse<IRecursoDelAgente[]>> {
    return this.request(
      { method: "GET", path: `/v1/agent-tools/${encodeURIComponent(agentId)}/recursos`, headers: this.cabecerasDeServicio() },
      context,
    );
  }

  consultasPrestadas(agentId: string, context: IRequestContext): Promise<IServiceResponse<unknown[]>> {
    return this.request(
      { method: "GET", path: `/v1/agent-tools/${encodeURIComponent(agentId)}/consultas`, headers: this.cabecerasDeServicio() },
      context,
    );
  }

  /** Sólo de lectura: quien lo impide es ms-agents. */
  ejecutarConsultaPrestada(
    id: string,
    argumentos: Record<string, unknown>,
    context: IRequestContext,
  ): Promise<IServiceResponse<{ devolvio: string }>> {
    return this.request(
      {
        method: "POST",
        path: `/v1/agent-tools/consultas/${encodeURIComponent(id)}/ejecutar`,
        body: argumentos,
        headers: this.cabecerasDeServicio(),
        retries: 0,
      },
      context,
    );
  }
}

let instancia: AgentsServiceClient | null = null;
export function getAgentsServiceClient(): AgentsServiceClient {
  if (instancia === null) instancia = new AgentsServiceClient();
  return instancia;
}
