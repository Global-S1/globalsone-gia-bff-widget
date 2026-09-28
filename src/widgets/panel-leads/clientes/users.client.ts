import { BaseServiceClient } from "../../../bff/infrastructure/service-clients/base-service-client";
import { getServiceConfig, ServiceKeys } from "../../../bff/infrastructure/config/backend-services.config";
import type { IRequestContext } from "../../../bff/domain/interfaces/request-context.interface";
import type { IServiceResponse } from "../../../bff/domain/interfaces/service-response.interface";

/**
 * Lo único que este BFF le pide a ms-auth sobre personas: cómo se llaman unos
 * identificadores (SPEC-059). Va con el token de servicio y no con `user:list`,
 * que quien atiende no tiene ni debe tener sólo para leer un nombre.
 */
export class UsersServiceClient extends BaseServiceClient {
  constructor() {
    super(getServiceConfig(ServiceKeys.AUTH));
  }

  nombresDeUsuarios(ids: string[], context: IRequestContext): Promise<IServiceResponse<Array<{ id: string; nombre: string }>>> {
    const token = process.env.INTERNAL_SERVICE_TOKEN ?? "";
    return this.request(
      {
        method: "POST",
        path: "/v1/rbac/users/nombres",
        body: { ids },
        headers: token ? { "x-internal-service-token": token } : {},
        // Dato decorativo: si no llega, se pinta el identificador y se sigue.
        retries: 0,
        timeout: 2000,
      },
      context,
    );
  }
}

let instancia: UsersServiceClient | null = null;
export function getUsersServiceClient(): UsersServiceClient {
  if (instancia === null) instancia = new UsersServiceClient();
  return instancia;
}
