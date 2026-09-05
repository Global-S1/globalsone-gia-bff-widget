import { BaseServiceClient } from "./base-service-client";
import { getServiceConfig, ServiceKeys } from "../config/backend-services.config";
import { IRequestContext } from "../../domain/interfaces/request-context.interface";
import { IServiceConfig } from "../../domain/interfaces/service-client.interface";
import { env } from "../../../entities/shared/infraestructure/config/environments";
import type { Dispatcher } from "undici";

/**
 * Cliente HTTP hacia ms-documents: de donde salen los bytes de un recurso del
 * agente (ADR-026 · SPEC-187).
 *
 * **Este servicio es el proxy de esos bytes** (ADR-035). La ruta de
 * ms-documents no se abre a internet —sigue atendiendo sólo a servicios—, así
 * que quien va a buscarlos es quien ya conoce al visitante y tiene el token:
 * este BFF.
 *
 * ## La cabecera del token NO se llama como la de la casa
 *
 * `x-internal-token`, **sin «service»**. Es el nombre que exige ms-documents
 * —y ms-audit—, mientras el resto del sistema usa `x-internal-service-token`
 * (ADR-011 · ADR-016). La inconsistencia viene de antes, está anotada en
 * ms-leads (`src/recursos-http.ts`) y en el cliente de bff-backoffice, y
 * unificarla es otro trabajo. Mandar el nombre de la casa aquí da un 401 en
 * cada descarga, y quien escribe se queda mirando un enlace que no baja nada.
 *
 * Tiene su propia prueba, y no sólo este comentario: un comentario no se pone
 * rojo cuando alguien lo "arregla".
 */
export class DocumentsServiceClient extends BaseServiceClient {
  constructor(config?: IServiceConfig) {
    super(config ?? getServiceConfig(ServiceKeys.DOCUMENTS));
  }

  /**
   * Los bytes de un recurso del agente, **sin consumir el cuerpo**: se devuelve
   * la respuesta de undici tal cual para que el controlador la sirva según
   * llega. Un fichero puede pesar, y bufferizarlo aquí lo mete entero en la
   * memoria del BFF para nada: de aquí va directo al navegador.
   *
   * Por eso NO se usa `request()` de la clase base, que parsea JSON y se come
   * el cuerpo.
   *
   * `organizacionId` es **el que dijo la llave** y nunca otra cosa (SPEC-187):
   * ms-documents responde según la organización que recibe, y esa es toda la
   * razón por la que la cadena no tiene fuga aunque quien acuña la llave no
   * compruebe a quién pertenece el documento.
   */
  async obtenerFichero(
    params: { readonly organizacionId: string; readonly documentoId: string },
    context: IRequestContext
  ): Promise<Dispatcher.ResponseData> {
    const { request } = await import("undici");
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/v1/agent-resources/${encodeURIComponent(
      params.documentoId
    )}/file`;

    return request(url, {
      method: "GET",
      headers: {
        // Ver el comentario de la clase: SIN «service», a propósito.
        "x-internal-token": env.internalServiceToken ?? "",
        "x-tenant-id": params.organizacionId,
        "X-Correlation-ID": context.correlationId,
      },
      headersTimeout: this.config.timeout,
      // El cuerpo es un fichero y puede tardar bastante más que una cabecera:
      // el tope de la configuración es el de una lectura de JSON.
      bodyTimeout: 120000,
    });
  }
}

let instance: DocumentsServiceClient | null = null;

export function getDocumentsServiceClient(): DocumentsServiceClient {
  if (!instance) instance = new DocumentsServiceClient();
  return instance;
}
