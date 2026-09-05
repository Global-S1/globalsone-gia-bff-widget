import { BaseServiceClient } from "./base-service-client";
import { getServiceConfig, ServiceKeys } from "../config/backend-services.config";
import { IRequestContext } from "../../domain/interfaces/request-context.interface";
import { IServiceConfig } from "../../domain/interfaces/service-client.interface";
import { IServiceResponse } from "../../domain/interfaces/service-response.interface";
import { env } from "../../../entities/shared/infraestructure/config/environments";

/** Lo que ms-leads necesita para atender un mensaje del widget (SPEC-164). */
export interface IMensajeDelWidget {
  /**
   * La organización del agente. Viaja en `x-tenant-id` y NUNCA en el cuerpo:
   * es la señal que el llamante no controla (RF-008), y lo que llegue en el
   * cuerpo ms-leads lo ignora en silencio.
   *
   * Este BFF no la sabe por sí mismo —tiene un TOKEN de organización, que
   * identifica pero no dice cuál es— así que sale de la configuración de
   * widget del agente (SPEC-162), que es quien la publica.
   */
  readonly organizacionId: string;
  readonly agenteId: string;
  /** La identidad del lead en este canal: el id que el widget guarda en el navegador. */
  readonly visitanteId: string;
  readonly texto: string;
  /** Desde dónde escribe, para que el tope diario por IP de ms-agents siga vivo. */
  readonly ip?: string;
}

/**
 * La respuesta de la entrada del widget (SPEC-164). Sus campos están
 * **siempre**, con su valor vacío cuando no hay nada que decir.
 */
export interface IRespuestaDeLeads {
  readonly conversacionId: string;
  /** Lo que el agente escribió, o `null` cuando en ese estado no habla nadie. */
  readonly texto: string | null;
  readonly clase: string | null;
  readonly porque: string | null;
  readonly contacto: {
    readonly nombre: string | null;
    readonly correo: string | null;
    readonly telefono: string | null;
  };
  /**
   * Las fotos que el agente señaló, **en el orden en que las señaló**
   * (SPEC-182 · RF-021 · ADR-035).
   *
   * Son **direcciones y no ficheros**: una foto que el agente señala no es algo
   * nuestro, es una `https` que ya vivía en internet —la del catálogo del
   * tenant— y la pinta el navegador de quien escribe. Sus bytes no pasan por
   * aquí, y traerlos por dentro nos costaría ancho de banda para no mejorar
   * nada (ADR-035).
   *
   * **Siempre presente y vacía cuando no hay ninguna**, nunca ausente y nunca
   * nula: verificado en `ms-leads/src/orquestador.ts`.
   */
  readonly fotos: readonly string[];
  /**
   * Los ficheros que el agente apartó, **en el orden en que los apartó**
   * (SPEC-186 · RF-022 · ADR-035).
   *
   * Cada uno con el `titulo` con el que el tenant lo dio de alta —que es lo que
   * va a leer quien escribe— y una `llave` con la que se piden sus bytes al
   * proxy (SPEC-187). **La llave no es el identificador del documento**, y ésa
   * es toda la razón de que exista: con el identificador interno, cualquiera
   * que lo tuviera se descargaría el recurso de cualquier tenant.
   *
   * El peso no viaja: sólo se sabría descargando el fichero entero.
   *
   * **Siempre presente y vacía cuando no hay ninguno**: verificado en
   * `ms-leads/src/orquestador.ts`.
   */
  readonly ficheros: readonly { readonly titulo: string; readonly llave: string }[];
  readonly derivada: boolean;
  /** La dirección del formulario del tenant, sólo cuando hay derivación (RF-020). */
  readonly formularioDeContacto: string | null;
}

/**
 * De quién es la llave con la que sale un fichero del widget (SPEC-186).
 *
 * **Sólo dice a qué organización y a qué documento pertenece.** Los bytes los
 * sirve este BFF (SPEC-187): la ruta de ms-documents no se abre a internet.
 */
export interface ILlaveDeFichero {
  readonly organizacionId: string;
  readonly documentoId: string;
}

/**
 * Cliente HTTP hacia ms-leads. La segunda puerta del widget (ADR-034).
 *
 * Lo que autoriza es el mismo secreto compartido que ya usa el camino de
 * ms-agents (ADR-011): quien escribe por el widget es un anónimo sin sesión, y
 * ms-leads sólo admite esta ruta a servicios de la casa.
 */
export class LeadsServiceClient extends BaseServiceClient {
  constructor(config?: IServiceConfig) {
    super(config ?? getServiceConfig(ServiceKeys.LEADS));
  }

  async atenderMensajeDelWidget(
    params: IMensajeDelWidget,
    context: IRequestContext
  ): Promise<IServiceResponse<IRespuestaDeLeads>> {
    return this.request<IRespuestaDeLeads>(
      {
        method: "POST",
        path: "/v1/widget/mensaje",
        // **Sin reintentos, y no por prudencia genérica**: este POST guarda el
        // mensaje del visitante y llama al modelo. Un reintento duplicaría su
        // turno en la conversación y pagaría la pasada dos veces. Un fallo se
        // traduce y se enseña; no se repite.
        retries: 0,
        // El de la configuración del servicio (5 s) es el de una lectura. Aquí
        // al otro lado hay una llamada al modelo, que es lo que tarda.
        timeout: 120000,
        headers: {
          "x-internal-service-token": env.internalServiceToken ?? "",
          "x-tenant-id": params.organizacionId,
        },
        body: {
          agenteId: params.agenteId,
          visitanteId: params.visitanteId,
          texto: params.texto,
          ...(params.ip ? { ip: params.ip } : {}),
        },
      },
      // **El contexto se poda a propósito.** El cliente base añade `X-User-ID`
      // cuando el contexto trae `userId`, y ms-leads rechaza con 400 una
      // petición con esa cabecera repetida —Node une las repetidas con comas y
      // una conversación con dueño «uuid, uuid» queda atrapada—. Quien escribe
      // por el widget no es un usuario del tenant: no hay identidad que mandar.
      { correlationId: context.correlationId, timestamp: context.timestamp }
    );
  }

  /**
   * SPEC-186 · SPEC-187 — de quién es esta llave.
   *
   * **Es la única ruta de ms-leads que NO lleva** `**x-tenant-id**`, y no por
   * descuido: quien presenta una llave viene justo a preguntar de qué
   * organización es, así que exigirle ese dato sería pedirle el que viene a
   * buscar. El token interno sí va, igual que en todas.
   *
   * Y no distingue «no existe» de «no es tuya», porque no hay tuya: la llave es
   * la autorización, y una que no está es un 404 para todo el mundo.
   */
  async resolverLlaveDeFichero(
    llave: string,
    context: IRequestContext
  ): Promise<IServiceResponse<ILlaveDeFichero>> {
    return this.request<ILlaveDeFichero>(
      {
        method: "GET",
        path: `/v1/widget/fichero/${encodeURIComponent(llave)}`,
        // Una lectura, y va delante de una descarga que alguien espera: un
        // reintento por si el primero se cruza con un reinicio, y no más.
        retries: 1,
        timeout: 3000,
        headers: {
          "x-internal-service-token": env.internalServiceToken ?? "",
        },
      },
      // Podado igual que el mensaje del widget: quien pide un fichero por su
      // llave no es un usuario del tenant, y `X-User-ID` duplicada rompe.
      { correlationId: context.correlationId, timestamp: context.timestamp }
    );
  }
}

let instance: LeadsServiceClient | null = null;

export function getLeadsServiceClient(): LeadsServiceClient {
  if (!instance) instance = new LeadsServiceClient();
  return instance;
}
