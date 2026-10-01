import type { Request, Response } from "express";
import type { IRequestContext } from "../../../bff/domain/interfaces/request-context.interface";
import {
  getLeadsServiceClient,
  type AccionDeBandeja,
  type IContactoRegistrado,
  type IConversacion,
} from "../clientes/leads.client";
import { getMessagingServiceClient } from "../clientes/messaging.client";
import { getAgentsServiceClient } from "../clientes/agents.client";
import { getUsersServiceClient } from "../clientes/users.client";
import { componerVistaDeRecursos } from "./vista-de-recursos";
import { auditar } from "../auditoria/auditar";

/**
 * SPEC-271 · SPEC-275 — la API de las cuatro vistas del panel incrustado.
 *
 * Es la sección Leads de bff-backoffice, recortada a lo que el panel sirve y
 * con dos diferencias que no son cosméticas:
 *
 * **1 · No hay lógica de negocio nueva.** Los datos salen de ms-leads; esto es
 * una puerta. Duplicar reglas sería tener dos comportamientos que se separan.
 *
 * **2 · Todo lo que se lee queda auditado con su origen** (SPEC-273). En el
 * backoffice se auditan las acciones; aquí también abrir una ficha o una
 * conversación, porque lo que se está leyendo son datos personales de
 * terceros dentro de la página de un cliente.
 *
 * Y lo que se conserva de allí: la organización sale de la sesión, nunca de
 * la petición (RF-008); y un fallo parcial no tumba la pantalla.
 */

function contexto(req: Request): IRequestContext {
  return req.context!;
}

const CAMPOS_DE_CONTACTO = ["nombre", "correo", "telefono"] as const;

interface Degradado {
  readonly parte: string;
  readonly motivo: string;
}

export const leadsController = {
  /**
   * El panel: los leads con su clase vigente, **y las clases del tenant con su
   * color** para pintar las etiquetas y las columnas. **Sin las solicitudes de
   * borrado**: se gestionan en el backoffice de GIA, no desde un anfitrión.
   *
   * Si el catálogo no contesta, el panel se sirve igual —sin colores— y se dice
   * qué faltó: un panel que no abre por no saber un color es peor que uno gris.
   */
  async panel(req: Request, res: Response): Promise<void> {
    const ctx = contexto(req);
    const [leads, catalogo] = await Promise.all([
      getLeadsServiceClient().listarLeads(ctx),
      getLeadsServiceClient().catalogo(ctx).catch(() => null),
    ]);
    if (!leads.success) {
      res.status(leads.statusCode ?? 502).json({ success: false, message: "No se pudo obtener el panel de leads" });
      return;
    }
    const catalogoVino = catalogo?.success === true;
    res.json({
      success: true,
      data: {
        leads: leads.data?.leads ?? [],
        clases: catalogoVino ? (catalogo.data?.clases ?? []).map((c) => ({ id: c.id, nombre: c.nombre, color: c.color })) : [],
      },
      degradado: catalogoVino ? undefined : [{ parte: "clases", motivo: "el catálogo no respondió; las clases se ven sin su color" }],
    });
  },

  /**
   * La ficha del lead: su historial con el nombre de quien corrigió cada dato,
   * **y las clases del tenant** para poder corregir la suya. Las clases van
   * aquí y no en una ruta de catálogo porque esta puerta no sirve
   * configuración (SPEC-271): quien atiende necesita elegir una clase, no
   * administrarlas. Si el catálogo no contesta, la ficha se sirve igual y se
   * dice qué faltó.
   */
  /**
   * El historial de atención de un lead, con el nombre de cada persona.
   *
   * ms-leads guarda quién como un identificador opaco; aquí se traduce, igual
   * que en la ficha. **Un nombre que no se puede resolver no rompe nada**: la
   * línea llega sin nombre y la pantalla dice «una persona».
   */
  async atencion(req: Request, res: Response): Promise<void> {
    const ctx = contexto(req);
    const leadId = String(req.params.leadId);
    const respuesta = await getLeadsServiceClient().atencionDelLead(leadId, ctx);

    await auditar(req, { accion: "READ_ATTENTION_HISTORY", recurso: "lead", recursoId: leadId, resultado: respuesta });

    if (!respuesta.success) {
      reenviar(res, respuesta, "No se pudo obtener el historial de atención");
      return;
    }

    const eventos = respuesta.data?.eventos ?? [];
    const nombres = await nombresDe(eventos.map((e) => e.actorId ?? null), ctx);
    res.status(200).json({
      success: true,
      data: {
        eventos: eventos.map((e) => ({
          ...e,
          actorNombre: e.actorId === null || e.actorId === undefined ? null : (nombres.get(e.actorId) ?? null),
        })),
      },
    });
  },

  async historial(req: Request, res: Response): Promise<void> {
    const ctx = contexto(req);
    const leadId = String(req.params.leadId);
    const degradado: Degradado[] = [];

    const [respuesta, catalogo] = await Promise.all([
      getLeadsServiceClient().historialDelLead(leadId, ctx),
      getLeadsServiceClient().catalogo(ctx).catch(() => null),
    ]);

    await auditar(req, { accion: "READ_LEAD", recurso: "lead", recursoId: leadId, resultado: respuesta });

    if (!respuesta.success) {
      reenviar(res, respuesta, "No se pudo obtener la ficha del lead");
      return;
    }

    const clases = catalogo?.success === true ? (catalogo.data?.clases ?? []).map((c) => ({ id: c.id, nombre: c.nombre, color: c.color })) : [];
    if (catalogo === null || catalogo.success !== true) {
      degradado.push({ parte: "clases", motivo: "el catálogo no respondió; no se podrá corregir la clase hasta que vuelva" });
    }

    const vista = respuesta.data as { contactos?: IContactoRegistrado[] } | undefined;
    const contactos = vista?.contactos;
    const nombres = await nombresDe((contactos ?? []).map((c) => c.actorId ?? null), ctx);

    res.status(200).json({
      success: true,
      data: {
        ...(respuesta.data as object),
        ...(contactos === undefined
          ? {}
          : {
              contactos: contactos.map((entrada) => ({
                ...entrada,
                actorNombre:
                  entrada.actorId === null || entrada.actorId === undefined ? null : (nombres.get(entrada.actorId) ?? null),
              })),
            }),
        clases,
      },
      degradado: degradado.length > 0 ? degradado : undefined,
    });
  },

  /** La bandeja. El filtro por estado lo valida ms-leads, que es quien define la lista. */
  async bandeja(req: Request, res: Response): Promise<void> {
    const ctx = contexto(req);
    const estado = typeof req.query.estado === "string" ? req.query.estado : undefined;
    const respuesta = await getLeadsServiceClient().bandeja(estado, ctx);
    if (!respuesta.success) {
      reenviar(res, respuesta, "No se pudo obtener la bandeja");
      return;
    }
    const conversaciones = respuesta.data?.conversaciones ?? [];
    const nombres = await nombresDe(conversaciones.map((c) => c.asignadaA), ctx);
    res.status(200).json({ success: true, data: { conversaciones: conversaciones.map((c) => conNombre(c, nombres)) } });
  },

  /** La ficha de una conversación: el hilo, el lead, el consumo y el agente. Sólo el hilo es imprescindible. */
  async fichaDeConversacion(req: Request, res: Response): Promise<void> {
    const ctx = contexto(req);
    const conversacionId = String(req.params.conversacionId);

    const vista = await getLeadsServiceClient().verConversacion(conversacionId, ctx);
    await auditar(req, { accion: "READ_CONVERSATION", recurso: "lead_conversation", recursoId: conversacionId, resultado: vista });
    if (!vista.success) {
      reenviar(res, vista, "No se pudo obtener la conversación");
      return;
    }

    const conversacion = vista.data?.conversacion;
    const sesion = conversacion?.sesionDelAgente ?? null;

    const [lead, consumo] = await Promise.all([
      conversacion?.leadId === undefined
        ? Promise.resolve(null)
        : getLeadsServiceClient().historialDelLead(conversacion.leadId, ctx).catch(() => null),
      sesion === null ? Promise.resolve(null) : getAgentsServiceClient().consumoDeSesion(sesion, ctx).catch(() => null),
    ]);

    const nombres = await nombresDe([conversacion?.asignadaA], ctx);
    const agente = await agenteDeLaConversacion(conversacion, ctx);

    res.status(200).json({
      success: true,
      data: {
        ...(vista.data as object),
        ...(conversacion === undefined ? {} : { conversacion: conNombre(conversacion, nombres) }),
        lead: lead?.success === true ? ((lead.data as { lead?: unknown })?.lead ?? null) : null,
        consumo: consumo?.success === true ? consumo.data : null,
        agente,
      },
    });
  },

  async conversacion(req: Request, res: Response): Promise<void> {
    const ctx = contexto(req);
    const conversacionId = String(req.params.conversacionId);
    const respuesta = await getLeadsServiceClient().verConversacion(conversacionId, ctx);
    await auditar(req, { accion: "READ_CONVERSATION", recurso: "lead_conversation", recursoId: conversacionId, resultado: respuesta });
    if (!respuesta.success) {
      reenviar(res, respuesta, "No se pudo obtener la conversación");
      return;
    }
    const vista = respuesta.data;
    const nombres = await nombresDe([vista?.conversacion?.asignadaA], ctx);
    res.status(200).json({
      success: true,
      data: {
        ...(vista as object),
        ...(vista?.conversacion === undefined ? {} : { conversacion: conNombre(vista.conversacion, nombres) }),
      },
    });
  },

  /** Tomar, liberar y devolver. El 409 se reenvía con quién la tiene (RF-006). */
  accion(accion: AccionDeBandeja) {
    return async (req: Request, res: Response): Promise<void> => {
      const ctx = contexto(req);
      const nombres = accion === "tomar" ? await nombresDe([ctx.userId], ctx) : new Map<string, string>();
      const conversacionId = String(req.params.conversacionId);
      const respuesta = await getLeadsServiceClient().accion(
        conversacionId,
        accion,
        ctx,
        ctx.userId === undefined ? undefined : nombres.get(ctx.userId),
      );

      await auditar(req, { accion: ACCIONES_AUDITADAS[accion], recurso: "lead_conversation", recursoId: conversacionId, resultado: respuesta });

      if (!respuesta.success) {
        await reenviarConflicto(res, respuesta, "No se pudo completar la acción sobre la conversación", ctx);
        return;
      }
      const conversacion = respuesta.data;
      res.status(200).json({
        success: true,
        data: conversacion === undefined ? conversacion : conNombre(conversacion, await nombresDe([conversacion.asignadaA], ctx, nombres)),
      });
    };
  },

  async responder(req: Request, res: Response): Promise<void> {
    const conversacionId = String(req.params.conversacionId);
    const { texto } = req.body ?? {};
    if (typeof texto !== "string" || texto.trim().length === 0) {
      await auditar(req, {
        accion: "REPLY",
        recurso: "lead_conversation",
        recursoId: conversacionId,
        resultado: { success: false, statusCode: 400, data: { error: "El mensaje no puede ir vacío" } },
      });
      res.status(400).json({ success: false, message: "El mensaje no puede ir vacío" });
      return;
    }
    const ctx = contexto(req);
    const respuesta = await getLeadsServiceClient().responder(conversacionId, texto, ctx);
    // La longitud, nunca el texto: es contenido sobre una persona ajena.
    await auditar(req, {
      accion: "REPLY",
      recurso: "lead_conversation",
      recursoId: conversacionId,
      resultado: respuesta,
      extra: { longitud: texto.trim().length },
    });
    if (!respuesta.success) {
      await reenviarConflicto(res, respuesta, "No se pudo enviar el mensaje", ctx);
      return;
    }
    res.status(201).json({ success: true, data: respuesta.data });
  },

  async clasificaciones(req: Request, res: Response): Promise<void> {
    reenviar(
      res,
      await getLeadsServiceClient().clasificacionesDelLead(String(req.params.leadId), contexto(req)),
      "No se pudo obtener el historial de clasificaciones",
    );
  },

  async corregirClase(req: Request, res: Response): Promise<void> {
    const { clase, explicacion } = req.body ?? {};
    if (typeof clase !== "string" || clase.trim().length === 0) {
      res.status(400).json({ success: false, message: "Hace falta la clase a la que se corrige" });
      return;
    }
    const leadId = String(req.params.leadId);
    const respuesta = await getLeadsServiceClient().corregirClase(
      leadId,
      { clase: clase.trim(), ...(typeof explicacion === "string" && explicacion.trim().length > 0 ? { explicacion: explicacion.trim() } : {}) },
      contexto(req),
    );
    await auditar(req, { accion: "RECLASSIFY", recurso: "lead", recursoId: leadId, resultado: respuesta, extra: { clase: clase.trim() } });
    reenviar(res, respuesta, "No se pudo corregir la clase del lead");
  },

  /**
   * Corregir un dato de contacto (SPEC-171). Del cuerpo salen los tres campos
   * del contrato y nada más, y se reenvían las claves que VINIERON: ausente no
   * toca, texto pone, nulo vacía. En la auditoría van los campos, nunca los
   * valores.
   */
  async corregirContacto(req: Request, res: Response): Promise<void> {
    const cuerpo = (req.body ?? {}) as Record<string, unknown>;
    const correccion: Record<string, string | null> = {};
    for (const campo of CAMPOS_DE_CONTACTO) {
      if (!Object.prototype.hasOwnProperty.call(cuerpo, campo)) continue;
      const valor = cuerpo[campo];
      if (valor === null) correccion[campo] = null;
      else if (typeof valor === "string" && valor.trim().length > 0) correccion[campo] = valor.trim();
    }
    const campos = Object.keys(correccion);
    if (campos.length === 0) {
      res.status(400).json({
        success: false,
        message: "Hace falta al menos un dato de contacto que corregir: nombre, correo o teléfono",
      });
      return;
    }
    const leadId = String(req.params.leadId);
    const respuesta = await getLeadsServiceClient().corregirContacto(leadId, correccion, contexto(req));
    await auditar(req, { accion: "CORRECT_CONTACT", recurso: "lead", recursoId: leadId, resultado: respuesta, extra: { campos } });
    reenviar(res, respuesta, "No se pudo corregir el dato de contacto del lead");
  },

  /** Los recursos del agente que atiende ESTA conversación: el alcance lo impone el dato. */
  async recursosDeLaConversacion(req: Request, res: Response): Promise<void> {
    const ctx = contexto(req);
    const agente = await agenteDeEstaConversacion(String(req.params.conversacionId), ctx);
    if (agente === null) {
      res.status(409).json({ success: false, message: SIN_AGENTE });
      return;
    }
    const respuesta = await getAgentsServiceClient().recursosPrestados(agente.id, ctx);
    if (!respuesta.success) {
      reenviar(res, respuesta, "No se pudieron obtener los recursos del agente");
      return;
    }
    res.status(200).json({ success: true, data: await componerVistaDeRecursos(agente.id, ctx.tenantId, respuesta.data ?? []) });
  },

  async consultasDeLaConversacion(req: Request, res: Response): Promise<void> {
    const ctx = contexto(req);
    const agente = await agenteDeEstaConversacion(String(req.params.conversacionId), ctx);
    if (agente === null) {
      res.status(409).json({ success: false, message: SIN_AGENTE });
      return;
    }
    reenviar(res, await getAgentsServiceClient().consultasPrestadas(agente.id, ctx), "No se pudieron obtener las consultas del agente");
  },

  /** Manda un recurso del agente. El guardia: el recurso tiene que ser del agente de ESTA conversación. */
  async mandarRecurso(req: Request, res: Response): Promise<void> {
    const ctx = contexto(req);
    const conversacionId = String(req.params.conversacionId);
    const agente = await agenteDeEstaConversacion(conversacionId, ctx);
    if (agente === null) {
      res.status(409).json({ success: false, message: SIN_AGENTE });
      return;
    }
    const recursos = await getAgentsServiceClient().recursosPrestados(agente.id, ctx);
    if (!recursos.success) {
      reenviar(res, recursos, "No se pudieron obtener los recursos del agente");
      return;
    }
    const recurso = (recursos.data ?? []).find((r) => r.id === String(req.params.recursoId));
    if (recurso === undefined) {
      res.status(404).json({ success: false, message: "Ese recurso no es del agente que atiende esta conversación" });
      return;
    }
    if (recurso.documentServiceId === null) {
      res.status(409).json({ success: false, message: "Ese recurso no tiene ningún fichero: no se puede enviar" });
      return;
    }
    const texto = typeof req.body?.texto === "string" ? req.body.texto : "";
    const respuesta = await getLeadsServiceClient().mandarRecurso(
      conversacionId,
      { texto, documentoId: recurso.documentServiceId, titulo: recurso.title },
      ctx,
    );
    await auditar(req, {
      accion: "SEND_RESOURCE",
      recurso: "lead_conversation",
      recursoId: conversacionId,
      resultado: respuesta,
      extra: { recursoId: recurso.id },
    });
    reenviar(res, respuesta, "No se pudo enviar el recurso", 201);
  },

  /** Ejecuta una consulta del agente: lo devuelto vuelve a quien lo pidió, no al canal. */
  async ejecutarConsulta(req: Request, res: Response): Promise<void> {
    const ctx = contexto(req);
    const conversacionId = String(req.params.conversacionId);
    const agente = await agenteDeEstaConversacion(conversacionId, ctx);
    if (agente === null) {
      res.status(409).json({ success: false, message: SIN_AGENTE });
      return;
    }
    const consultas = await getAgentsServiceClient().consultasPrestadas(agente.id, ctx);
    if (!consultas.success) {
      reenviar(res, consultas, "No se pudieron obtener las consultas del agente");
      return;
    }
    const consultaId = String(req.params.consultaId);
    const suya = (consultas.data ?? []).some((c) => (c as { id?: string })?.id === consultaId);
    if (!suya) {
      res.status(404).json({ success: false, message: "Esa consulta no es del agente que atiende esta conversación" });
      return;
    }
    const respuesta = await getAgentsServiceClient().ejecutarConsultaPrestada(
      consultaId,
      (req.body ?? {}) as Record<string, unknown>,
      ctx,
    );
    await auditar(req, {
      accion: "RUN_QUERY",
      recurso: "lead_conversation",
      recursoId: conversacionId,
      resultado: respuesta,
      extra: { consultaId },
    });
    reenviar(res, respuesta, "No se pudo ejecutar la consulta");
  },
};

const ACCIONES_AUDITADAS: Record<AccionDeBandeja, string> = {
  tomar: "TAKE",
  liberar: "RELEASE",
  "devolver-al-agente": "RETURN_TO_AGENT",
};

const SIN_AGENTE =
  "No se sabe qué agente atiende esta conversación: puede que su cuenta de canal no tenga ninguno asignado";

/** Cómo se llaman estos identificadores. Nunca lanza: sin nombre se pinta el identificador. */
async function nombresDe(
  identificadores: Array<string | null | undefined>,
  contexto: IRequestContext,
  yaSabidos: Map<string, string> = new Map(),
): Promise<Map<string, string>> {
  const pendientes = [
    ...new Set(identificadores.filter((id): id is string => typeof id === "string" && id !== "" && !yaSabidos.has(id))),
  ];
  if (pendientes.length === 0) return yaSabidos;
  try {
    const respuesta = await getUsersServiceClient().nombresDeUsuarios(pendientes, contexto);
    if (!respuesta.success || !Array.isArray(respuesta.data)) return yaSabidos;
    const resueltos = new Map(yaSabidos);
    for (const { id, nombre } of respuesta.data) resueltos.set(id, nombre);
    return resueltos;
  } catch {
    return yaSabidos;
  }
}

function conNombre(conversacion: IConversacion, nombres: Map<string, string>): IConversacion {
  return {
    ...conversacion,
    asignadaANombre: conversacion.asignadaA === null ? null : (nombres.get(conversacion.asignadaA) ?? null),
  };
}

async function reenviarConflicto<T>(
  res: Response,
  respuesta: { success: boolean; data?: T; statusCode?: number; error?: unknown },
  mensajeDeFallo: string,
  contexto: IRequestContext,
): Promise<void> {
  const detalle = (respuesta.data ?? respuesta.error) as { laTiene?: string } | undefined;
  const laTiene = typeof detalle?.laTiene === "string" ? detalle.laTiene : undefined;
  const nombre = laTiene === undefined ? undefined : (await nombresDe([laTiene], contexto)).get(laTiene);
  res.status(respuesta.statusCode ?? 502).json({
    success: false,
    message: mensajeDeFallo,
    detalle: nombre === undefined ? detalle : { ...detalle, laTieneNombre: nombre },
  });
}

/** Reenvía conservando el código: un 403, un 409 y un 400 significan cosas distintas para la pantalla. */
function reenviar<T>(
  res: Response,
  respuesta: { success: boolean; data?: T; statusCode?: number; error?: unknown },
  mensajeDeFallo: string,
  codigoDeExito = 200,
): void {
  if (!respuesta.success) {
    res.status(respuesta.statusCode ?? 502).json({ success: false, message: mensajeDeFallo, detalle: respuesta.data ?? respuesta.error });
    return;
  }
  res.status(codigoDeExito).json({ success: true, data: respuesta.data });
}

/** Qué agente atiende: conversación → cuenta → agente. Ninguno lo declara el cliente. */
async function agenteDeEstaConversacion(
  conversacionId: string,
  ctx: IRequestContext,
): Promise<{ id: string; nombre: string | null } | null> {
  const vista = await getLeadsServiceClient().verConversacion(conversacionId, ctx);
  if (!vista.success) return null;
  return agenteDeLaConversacion(vista.data?.conversacion, ctx);
}

async function agenteDeLaConversacion(
  conversacion: IConversacion | undefined,
  ctx: IRequestContext,
): Promise<{ id: string; nombre: string | null } | null> {
  const cuentaId = conversacion?.cuentaId ?? null;
  if (cuentaId === null) return null;
  const cuentas = await getMessagingServiceClient().listarCuentas(ctx).catch(() => null);
  if (cuentas?.success !== true) return null;
  const cuenta = (cuentas.data?.cuentas ?? []).find((c) => c.id === cuentaId);
  const agenteId = cuenta?.agenteId ?? null;
  if (agenteId === null || agenteId === "") return null;
  const agente = await getAgentsServiceClient().getAgentById(agenteId, ctx).catch(() => null);
  const nombre = agente?.success === true ? ((agente.data as { name?: string } | undefined)?.name ?? null) : null;
  return { id: agenteId, nombre };
}
