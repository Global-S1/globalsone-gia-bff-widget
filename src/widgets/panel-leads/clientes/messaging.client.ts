import { BaseServiceClient } from "../../../bff/infrastructure/service-clients/base-service-client";
import { getServiceConfig, ServiceKeys } from "../../../bff/infrastructure/config/backend-services.config";
import type { IRequestContext } from "../../../bff/domain/interfaces/request-context.interface";
import type { IServiceResponse } from "../../../bff/domain/interfaces/service-response.interface";

/**
 * Cliente hacia ms-messaging (CA-019), sólo para saber **qué agente atiende
 * una cuenta de canal**: es el paso conversación → cuenta → agente que dice de
 * quién son los recursos y las consultas prestadas. Nada de credenciales ni
 * de altas: eso no pasa por el panel incrustado (SPEC-271).
 */
export interface ICuentaDeCanal {
  id: string;
  tenantId: string;
  canal: string;
  agenteId: string | null;
  estado: string;
}

export class MessagingServiceClient extends BaseServiceClient {
  constructor() {
    super(getServiceConfig(ServiceKeys.MESSAGING));
  }

  private internalHeaders(): Record<string, string> {
    const token = process.env.INTERNAL_SERVICE_TOKEN ?? "";
    return token ? { "x-internal-service-token": token } : {};
  }

  listarCuentas(context: IRequestContext): Promise<IServiceResponse<{ cuentas: ICuentaDeCanal[] }>> {
    return this.request({ method: "GET", path: "/v1/channels", headers: this.internalHeaders() }, context);
  }
}

let instancia: MessagingServiceClient | null = null;
export function getMessagingServiceClient(): MessagingServiceClient {
  if (instancia === null) instancia = new MessagingServiceClient();
  return instancia;
}
