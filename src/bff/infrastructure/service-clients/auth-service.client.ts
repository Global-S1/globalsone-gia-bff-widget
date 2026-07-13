import { BaseServiceClient } from "./base-service-client";
import { getServiceConfig, ServiceKeys } from "../config/backend-services.config";
import { IRequestContext } from "../../domain/interfaces/request-context.interface";
import { IServiceResponse } from "../../domain/interfaces/service-response.interface";

export interface IValidateResult {
  userId: string;
  tenantId: string;
  userRole: string;
  userPermissions: string;
}

/**
 * Cliente HTTP hacia ms-auth. Valida el token de organización/tenant del
 * widget y resuelve identidad/RBAC.
 */
export class AuthServiceClient extends BaseServiceClient {
  constructor() {
    super(getServiceConfig(ServiceKeys.AUTH));
  }

  async validate(token: string, originalUri: string): Promise<IServiceResponse<IValidateResult>> {
    const context: IRequestContext = {
      correlationId: "",
      authorizationHeader: `Bearer ${token}`,
      timestamp: new Date(),
    };
    const response = await this.request<IValidateResult>(
      {
        method: "GET",
        path: "/v1/auth/validate",
        headers: { "X-Original-URI": originalUri },
      },
      context
    );
    // Identity data comes back in response headers, not body
    if (response.statusCode === 200 && response.headers) {
      response.data = {
        userId: response.headers["x-user-id"] || "",
        tenantId: response.headers["x-tenant-id"] || "",
        userRole: response.headers["x-user-role"] || "",
        userPermissions: response.headers["x-user-permissions"] || "",
      };
      response.success = true;
    }
    return response;
  }
}

let instance: AuthServiceClient | null = null;

export function getAuthServiceClient(): AuthServiceClient {
  if (!instance) instance = new AuthServiceClient();
  return instance;
}
