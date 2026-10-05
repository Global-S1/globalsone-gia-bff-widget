import { BaseServiceClient } from "../../../bff/infrastructure/service-clients/base-service-client";
import { getServiceConfig, ServiceKeys } from "../../../bff/infrastructure/config/backend-services.config";
import type { IRequestContext } from "../../../bff/domain/interfaces/request-context.interface";
import type { IServiceResponse } from "../../../bff/domain/interfaces/service-response.interface";

/**
 * SPEC-268 · ADR-047 — el canje del panel incrustado, en ms-auth.
 *
 * Las tres rutas viven en `/v1/auth/internal/panel/*` y sólo abren con el
 * token de servicio: quien autentica no es una sesión, es la aserción firmada
 * por el anfitrión (o el vale que salió de ella). Este cliente **no manda las
 * cabeceras de sesión** —no las hay— y **no reintenta nunca**: el vale es de
 * un solo uso y el `jti` de la aserción también; un segundo intento de una
 * llamada que quizá llegó se contestaría como repetición.
 */

export interface IValeEmitido {
  vale: string;
  expiraEn: number;
}

export interface ISesionDelPanel {
  token: string;
  expiresIn: number;
  tenantId: string;
  /** El id de esta persona EN GIA: es el que ms-leads apunta en `asignadaA`. */
  userId: string;
  role: string;
  permissions: string[];
  persona: { id: string; nombre: string };
}

export class AuthPanelClient extends BaseServiceClient {
  constructor() {
    super(getServiceConfig(ServiceKeys.AUTH));
  }

  private cabeceras(): Record<string, string> {
    const token = process.env.INTERNAL_SERVICE_TOKEN ?? "";
    return token ? { "x-internal-service-token": token } : {};
  }

  canjear(asercion: unknown, context: IRequestContext): Promise<IServiceResponse<IValeEmitido>> {
    return this.request<IValeEmitido>(
      { method: "POST", path: "/v1/auth/internal/panel/canje", body: { asercion }, headers: this.cabeceras(), retries: 0 },
      context,
    );
  }

  abrirSesion(vale: unknown, context: IRequestContext): Promise<IServiceResponse<ISesionDelPanel>> {
    return this.request<ISesionDelPanel>(
      { method: "POST", path: "/v1/auth/internal/panel/sesion", body: { vale }, headers: this.cabeceras(), retries: 0 },
      context,
    );
  }

  darDeBaja(asercion: unknown, context: IRequestContext): Promise<IServiceResponse<null>> {
    return this.request<null>(
      { method: "POST", path: "/v1/auth/internal/panel/bajas", body: { asercion }, headers: this.cabeceras(), retries: 0 },
      context,
    );
  }
}

// Instancia perezosa: `getServiceConfig` lanza si la configuración no se
// cargó todavía, y se carga en el bootstrap, después de resolver los imports.
let instancia: AuthPanelClient | null = null;
export function getAuthPanelClient(): AuthPanelClient {
  if (instancia === null) instancia = new AuthPanelClient();
  return instancia;
}
