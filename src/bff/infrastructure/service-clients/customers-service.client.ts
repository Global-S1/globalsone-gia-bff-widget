import { BaseServiceClient } from "./base-service-client";
import { getServiceConfig, ServiceKeys } from "../config/backend-services.config";
import { IRequestContext } from "../../domain/interfaces/request-context.interface";
import { IServiceResponse } from "../../domain/interfaces/service-response.interface";

/**
 * Cliente HTTP hacia ms-customers. Datos de cliente / tenant asociados a la
 * organización que embebe el widget.
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
