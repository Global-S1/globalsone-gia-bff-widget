import { BaseServiceClient } from "./base-service-client";
import { getServiceConfig, ServiceKeys } from "../config/backend-services.config";
import { IRequestContext } from "../../domain/interfaces/request-context.interface";
import { IServiceResponse } from "../../domain/interfaces/service-response.interface";

/**
 * Cliente HTTP hacia ms-customers. Datos de cliente / tenant asociados a la
 * organización que embebe el widget.
 *
 * ⚠️ HOY NADIE LO USA: no lo importa ningún fichero de este repositorio.
 *
 * Y si mañana alguien lo cablea tal cual, fallará con 403. Desde SPEC-020
 * ms-customers exige dos cabeceras que este cliente NO manda:
 *
 *   - `x-internal-service-token`, con el valor de INTERNAL_SERVICE_TOKEN;
 *   - `x-tenant-id`, con la organización de la petición.
 *
 * El problema de fondo para este BFF en concreto: su canal es ANÓNIMO. La
 * identidad que maneja es `unique-tenant-token`, que NO es el uuid de la
 * organización, así que antes de usar esto hay que decidir de dónde sale ese
 * uuid. En bff-backoffice y bff-frontoffice sale del token ya validado, y aquí
 * no hay token de sesión que valga.
 *
 * Ver el cliente equivalente de bff-backoffice para el patrón de cabeceras.
 */
export class CustomersServiceClient extends BaseServiceClient {
  constructor() {
    super(getServiceConfig(ServiceKeys.CUSTOMERS));
  }

  async getCustomer(customerId: string, context: IRequestContext): Promise<IServiceResponse<any>> {
    return this.request<any>(
      { method: "GET", path: `/v1/customers/${customerId}` },
      context
    );
  }
}

let instance: CustomersServiceClient | null = null;

export function getCustomersServiceClient(): CustomersServiceClient {
  if (!instance) instance = new CustomersServiceClient();
  return instance;
}
