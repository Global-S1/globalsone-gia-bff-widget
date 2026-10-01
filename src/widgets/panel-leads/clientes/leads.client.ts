import { BaseServiceClient } from "../../../bff/infrastructure/service-clients/base-service-client";
import { getServiceConfig, ServiceKeys } from "../../../bff/infrastructure/config/backend-services.config";
import type { IRequestContext } from "../../../bff/domain/interfaces/request-context.interface";
import type { IServiceResponse } from "../../../bff/domain/interfaces/service-response.interface";

/**
 * Cliente hacia ms-leads (CA-020), recortado a lo que el panel incrustado
 * sirve (SPEC-271): las cuatro vistas y sus acciones. **Sin catálogo, canales
 * ni ajustes como rutas propias**; el catálogo se lee sólo para componer la
 * lista de clases dentro de la ficha del lead.
 *
 * ms-leads no conoce usuarios ni permisos (ADR-020): se protege con el token
 * de servicio y saca la organización de `x-tenant-id`, que **pone la capa
 * base** desde la sesión. Aquí no se manda el tenant ni el usuario: repetir
 * una cabecera hace que Node las una con coma, y ms-leads guardaba
 * `"<uuid>, <uuid>"` como dueño de una conversación.
 */

export interface IDatoDeContacto {
  valor: string;
  origen: "modelo" | "persona";
  puestoEn: string;
}

export interface IContactoDelLead {
  nombre: IDatoDeContacto | null;
  correo: IDatoDeContacto | null;
  telefono: IDatoDeContacto | null;
}

export interface IContactoRegistrado {
  id: string;
  organizacionId: string;
  leadId: string;
  campo: "nombre" | "correo" | "telefono";
  valor: string | null;
  origen: "modelo" | "persona";
  actorId?: string | null;
  puestoEn: string;
}

export interface ILead {
  id: string;
  organizacionId: string;
  canal: string;
  identificadorEnCanal: string;
  clasificacion: string;
  contacto?: IContactoDelLead;
  /** Lo último que pasó con el lead (ms-leads lo añade al listado). */
  ultimaInteraccionEn?: string | null;
  ultimoMensajeDelLead?: { texto: string; enviadoEn: string } | null;
}

export interface IPlazoDeRespuesta {
  admite: boolean;
  hasta: string | null;
}

export interface IConversacion {
  id: string;
  organizacionId: string;
  leadId: string;
  estado: string;
  asignadaA: string | null;
  asignadaANombre?: string | null;
  agenteResponde: boolean;
  ultimoMensajeEn: string;
  tomadaEn: string | null;
  cuentaId?: string | null;
  canal?: string;
  derivadaEn?: string | null;
  motivoDeDerivacion?: "lo_pide" | "no_lo_se" | null;
  sesionDelAgente?: string | null;
}

export interface IMensaje {
  id: string;
  conversacionId: string;
  autor: string;
  texto: string;
  enviadoEn: string;
}

export interface IClase {
  id: string;
  nombre: string;
  descripcion: string;
  /** `#rrggbb`: lo elige el tenant y lo pintan la etiqueta de la lista y la columna del tablero. */
  color?: string;
  leads: number;
}

export interface IEventoDeAtencion {
  id: string;
  conversacionId: string;
  canal: string | null;
  tipo: string;
  /** La persona implicada, como id opaco: ms-leads no conoce personas. */
  actorId: string | null;
  motivo: string | null;
  en: string;
}

export interface IClasificacion {
  id: string;
  leadId: string;
  clase: string | null;
  explicacion: string;
  origen: "modelo" | "persona";
  registradaEn: string;
}

export type AccionDeBandeja = "tomar" | "liberar" | "devolver-al-agente";

export class LeadsServiceClient extends BaseServiceClient {
  constructor() {
    super(getServiceConfig(ServiceKeys.LEADS));
  }

  private internalHeaders(): Record<string, string> {
    const token = process.env.INTERNAL_SERVICE_TOKEN ?? "";
    return token ? { "x-internal-service-token": token } : {};
  }

  /**
   * Con qué nombre se presenta quien atiende delante del lead. El nombre real
   * lo resuelve el controlador contra ms-auth; el correo queda de repuesto.
   */
  private headersDeSupervisor(context: IRequestContext, nombre?: string): Record<string, string> {
    const cabeceras: Record<string, string> = { ...this.internalHeaders() };
    const presentable = (nombre ?? "").trim() || (context.userEmail ? nombreDe(context.userEmail) : "");
    if (presentable) cabeceras["x-user-name"] = presentable;
    return cabeceras;
  }

  listarLeads(context: IRequestContext): Promise<IServiceResponse<{ leads: ILead[] }>> {
    return this.request({ method: "GET", path: "/v1/leads", headers: this.internalHeaders() }, context);
  }

  historialDelLead(
    leadId: string,
    context: IRequestContext,
  ): Promise<
    IServiceResponse<{ lead: ILead; conversaciones: IConversacion[]; mensajes: IMensaje[]; contactos?: IContactoRegistrado[] }>
  > {
    return this.request(
      { method: "GET", path: `/v1/leads/${encodeURIComponent(leadId)}/historial`, headers: this.internalHeaders() },
      context,
    );
  }

  /** El historial de atención del lead: quién la tuvo, cuándo, y lo que hizo el sistema. */
  atencionDelLead(leadId: string, context: IRequestContext): Promise<IServiceResponse<{ eventos: IEventoDeAtencion[] }>> {
    return this.request(
      { method: "GET", path: `/v1/leads/${encodeURIComponent(leadId)}/atencion`, headers: this.internalHeaders() },
      context,
    );
  }

  bandeja(estado: string | undefined, context: IRequestContext): Promise<IServiceResponse<{ conversaciones: IConversacion[] }>> {
    const consulta = estado === undefined ? "" : `?estado=${encodeURIComponent(estado)}`;
    return this.request({ method: "GET", path: `/v1/conversaciones${consulta}`, headers: this.internalHeaders() }, context);
  }

  verConversacion(
    conversacionId: string,
    context: IRequestContext,
  ): Promise<IServiceResponse<{ conversacion: IConversacion; mensajes: IMensaje[]; plazo?: IPlazoDeRespuesta }>> {
    return this.request(
      { method: "GET", path: `/v1/conversaciones/${encodeURIComponent(conversacionId)}`, headers: this.internalHeaders() },
      context,
    );
  }

  accion(
    conversacionId: string,
    accion: AccionDeBandeja,
    context: IRequestContext,
    nombreDelSupervisor?: string,
  ): Promise<IServiceResponse<IConversacion>> {
    return this.request(
      {
        method: "POST",
        path: `/v1/conversaciones/${encodeURIComponent(conversacionId)}/${accion}`,
        headers: this.headersDeSupervisor(context, nombreDelSupervisor),
        retries: 0,
      },
      context,
    );
  }

  /** Sin reintentos: repetir un envío que quizá salió le duplicaría el mensaje al lead. */
  responder(conversacionId: string, texto: string, context: IRequestContext): Promise<IServiceResponse<IMensaje>> {
    return this.request(
      {
        method: "POST",
        path: `/v1/conversaciones/${encodeURIComponent(conversacionId)}/responder`,
        body: { texto },
        headers: this.headersDeSupervisor(context),
        retries: 0,
      },
      context,
    );
  }

  mandarRecurso(
    conversacionId: string,
    datos: { texto: string; documentoId: string; titulo: string },
    context: IRequestContext,
  ): Promise<IServiceResponse<IMensaje>> {
    return this.request(
      {
        method: "POST",
        path: `/v1/conversaciones/${encodeURIComponent(conversacionId)}/recursos`,
        body: datos,
        headers: this.headersDeSupervisor(context),
        retries: 0,
      },
      context,
    );
  }

  /** Sólo para componer las clases dentro de la ficha: no hay ruta de catálogo en esta puerta. */
  catalogo(context: IRequestContext): Promise<IServiceResponse<{ clases: IClase[] }>> {
    return this.request({ method: "GET", path: "/v1/catalogo", headers: this.internalHeaders() }, context);
  }

  clasificacionesDelLead(leadId: string, context: IRequestContext): Promise<IServiceResponse<{ clasificaciones: IClasificacion[] }>> {
    return this.request(
      { method: "GET", path: `/v1/leads/${encodeURIComponent(leadId)}/clasificaciones`, headers: this.internalHeaders() },
      context,
    );
  }

  corregirClase(
    leadId: string,
    cuerpo: { clase: string; explicacion?: string },
    context: IRequestContext,
  ): Promise<IServiceResponse<IClasificacion>> {
    return this.request(
      {
        method: "PUT",
        path: `/v1/leads/${encodeURIComponent(leadId)}/clase`,
        body: cuerpo,
        headers: this.headersDeSupervisor(context),
        retries: 0,
      },
      context,
    );
  }

  /** El cuerpo va tal como se recibió: ausente no toca, texto pone, nulo vacía (SPEC-173). */
  corregirContacto(
    leadId: string,
    cuerpo: { nombre?: string | null; correo?: string | null; telefono?: string | null },
    context: IRequestContext,
  ): Promise<IServiceResponse<ILead>> {
    return this.request(
      {
        method: "PUT",
        path: `/v1/leads/${encodeURIComponent(leadId)}/contacto`,
        body: cuerpo,
        headers: this.internalHeaders(),
        retries: 0,
      },
      context,
    );
  }
}

/** Del correo se saca algo presentable, de repuesto. Nunca el identificador. */
function nombreDe(correo: string): string {
  const local = correo.split("@")[0] ?? correo;
  const palabras = local.split(/[._-]+/).filter(Boolean);
  return palabras.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ") || correo;
}

let instancia: LeadsServiceClient | null = null;
export function getLeadsServiceClient(): LeadsServiceClient {
  if (instancia === null) instancia = new LeadsServiceClient();
  return instancia;
}
