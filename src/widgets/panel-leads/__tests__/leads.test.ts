/**
 * SPEC-271 · SPEC-273 · SPEC-275 — las cuatro vistas por la puerta del panel:
 * quién entra, qué permiso hace falta para cada cosa, cómo degrada, y que
 * todo queda auditado con su origen. Los servicios se sustituyen.
 */
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ORIGEN, cabecerasDeSesion, tokenDelBackoffice, tokenDelPanel } from "./token-del-panel";

const leads = vi.hoisted(() => ({
  listarLeads: vi.fn(),
  historialDelLead: vi.fn(),
  atencionDelLead: vi.fn(),
  catalogo: vi.fn(),
  bandeja: vi.fn(),
  verConversacion: vi.fn(),
  accion: vi.fn(),
  responder: vi.fn(),
  clasificacionesDelLead: vi.fn(),
  corregirClase: vi.fn(),
  corregirContacto: vi.fn(),
  mandarRecurso: vi.fn(),
}));
const usuarios = vi.hoisted(() => ({ nombresDeUsuarios: vi.fn() }));
const agentes = vi.hoisted(() => ({
  consumoDeSesion: vi.fn(),
  getAgentById: vi.fn(),
  recursosPrestados: vi.fn(),
  consultasPrestadas: vi.fn(),
  ejecutarConsultaPrestada: vi.fn(),
}));
const mensajeria = vi.hoisted(() => ({ listarCuentas: vi.fn() }));
const auditoria = vi.hoisted(() => ({ publishAudit: vi.fn(async (_evento: unknown): Promise<void> => {}) }));

vi.mock("../clientes/leads.client", () => ({ getLeadsServiceClient: () => leads }));
vi.mock("../clientes/users.client", () => ({ getUsersServiceClient: () => usuarios }));
vi.mock("../clientes/agents.client", () => ({ getAgentsServiceClient: () => agentes }));
vi.mock("../clientes/messaging.client", () => ({ getMessagingServiceClient: () => mensajeria }));
vi.mock("../clientes/documents.client", () => ({
  DocumentsServiceClient: { recursosDeAgente: async () => [{ id: "doc-1", fileName: "guia.pdf", mimeType: "application/pdf", fileSize: 10 }] },
}));
vi.mock("../auditoria/audit-publisher", () => auditoria);

import { server } from "../../../server";

const LEAD = { id: "l-1", organizacionId: "org-acme", canal: "widget", identificadorEnCanal: "v-1", clasificacion: "Caliente" };
const CONVERSACION = {
  id: "c-1",
  organizacionId: "org-acme",
  leadId: "l-1",
  estado: "esperando_persona",
  asignadaA: "user-otro",
  agenteResponde: false,
  ultimoMensajeEn: "2026-09-28T10:00:00.000Z",
  tomadaEn: null,
  cuentaId: "cuenta-1",
  sesionDelAgente: "ses-1",
};

function get(ruta: string, permisos?: string) {
  return request(server()).get(ruta).set(cabecerasDeSesion(permisos)).set("authorization", `Bearer ${tokenDelPanel()}`);
}
function post(ruta: string, permisos?: string) {
  return request(server()).post(ruta).set(cabecerasDeSesion(permisos)).set("authorization", `Bearer ${tokenDelPanel()}`);
}
function put(ruta: string, permisos?: string) {
  return request(server()).put(ruta).set(cabecerasDeSesion(permisos)).set("authorization", `Bearer ${tokenDelPanel()}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  auditoria.publishAudit.mockResolvedValue(undefined);
  leads.listarLeads.mockResolvedValue({ success: true, statusCode: 200, data: { leads: [LEAD] } });
  leads.historialDelLead.mockResolvedValue({
    success: true,
    statusCode: 200,
    data: { lead: LEAD, conversaciones: [], mensajes: [], contactos: [{ id: "k-1", campo: "nombre", valor: "Ana", origen: "persona", actorId: "user-otro", puestoEn: "x" }] },
  });
  leads.catalogo.mockResolvedValue({ success: true, statusCode: 200, data: { clases: [{ id: "cl-1", nombre: "Caliente", descripcion: "", color: "#8b5cf6", leads: 3 }] } });
  leads.bandeja.mockResolvedValue({ success: true, statusCode: 200, data: { conversaciones: [CONVERSACION] } });
  leads.verConversacion.mockResolvedValue({ success: true, statusCode: 200, data: { conversacion: CONVERSACION, mensajes: [] } });
  leads.accion.mockResolvedValue({ success: true, statusCode: 200, data: { ...CONVERSACION, asignadaA: "user-ana" } });
  leads.responder.mockResolvedValue({ success: true, statusCode: 201, data: { id: "m-1" } });
  usuarios.nombresDeUsuarios.mockResolvedValue({ success: true, statusCode: 200, data: [{ id: "user-otro", nombre: "Otro Supervisor" }, { id: "user-ana", nombre: "Ana" }] });
  agentes.consumoDeSesion.mockResolvedValue({ success: true, statusCode: 200, data: { totalTokens: 10 } });
  agentes.getAgentById.mockResolvedValue({ success: true, statusCode: 200, data: { id: "ag-1", name: "Vendedor" } });
  agentes.recursosPrestados.mockResolvedValue({
    success: true,
    statusCode: 200,
    data: [{ id: "r-1", title: "Guía", intention: "x", documentServiceId: "doc-1" }],
  });
  mensajeria.listarCuentas.mockResolvedValue({ success: true, statusCode: 200, data: { cuentas: [{ id: "cuenta-1", agenteId: "ag-1" }] } });
});

describe("Quién entra por la puerta del panel", () => {
  it("un token del backoffice no entra, aunque las cabeceras traigan permisos de leads", async () => {
    const r = await request(server()).get("/v1/panel/leads/panel").set(cabecerasDeSesion()).set("authorization", `Bearer ${tokenDelBackoffice()}`);
    expect(r.status).toBe(401);
    expect(leads.listarLeads).not.toHaveBeenCalled();
  });

  it("sin permiso no se atiende, aunque se lea", async () => {
    expect((await get("/v1/panel/leads/panel", "leads:read")).status).toBe(200);
    expect((await get("/v1/panel/leads/conversaciones", "leads:read")).status).toBe(200);

    const r = await post("/v1/panel/leads/conversaciones/c-1/responder", "leads:read").send({ texto: "hola" });
    expect(r.status).toBe(403);
    expect(r.body.permisoRequerido).toBe("leads:attend");
    expect(leads.responder).not.toHaveBeenCalled();
  });

  it("el comodín del backoffice no vale aquí", async () => {
    expect((await get("/v1/panel/leads/panel", "*")).status).toBe(403);
  });

  it("no hay catálogo, canales ni ajustes por esta puerta", async () => {
    for (const ruta of ["/v1/panel/leads/catalogo", "/v1/panel/leads/canales", "/v1/panel/leads/ajustes"]) {
      expect((await get(ruta)).status).toBe(404);
    }
  });
});

describe("Lo que sirve, y cómo degrada", () => {
  it("el panel llega en una respuesta, sólo con los leads: las solicitudes de borrado no salen por aquí", async () => {
    const r = await get("/v1/panel/leads/panel");

    expect(r.status).toBe(200);
    expect(r.body.data.leads).toHaveLength(1);
    expect(r.body.data).not.toHaveProperty("solicitudesDeBorrado");
    expect(r.body.degradado).toBeUndefined();
  });

  it("el panel trae las clases con su color, y sin catálogo se sirve igual y dice qué faltó", async () => {
    const con = await get("/v1/panel/leads/panel");
    expect(con.body.data.clases).toEqual([{ id: "cl-1", nombre: "Caliente", color: "#8b5cf6" }]);

    leads.catalogo.mockResolvedValue({ success: false, statusCode: 503 });
    const sin = await get("/v1/panel/leads/panel");
    expect(sin.status).toBe(200);
    expect(sin.body.data.clases).toEqual([]);
    expect(sin.body.degradado).toEqual([expect.objectContaining({ parte: "clases" })]);

    leads.catalogo.mockRejectedValue(new Error("caído"));
    const caido = await get("/v1/panel/leads/panel");
    expect(caido.status).toBe(200);
    expect(caido.body.degradado).toEqual([expect.objectContaining({ parte: "clases" })]);
  });

  it("ni lo pendiente ni ejecutar un borrado existen por esta puerta (404)", async () => {
    expect((await get("/v1/panel/leads/pendientes")).status).toBe(404);
    const r = await request(server()).delete("/v1/panel/leads/leads/l-1").set(cabecerasDeSesion()).set("authorization", `Bearer ${tokenDelPanel()}`);
    expect(r.status).toBe(404);
  });

  it("la ficha del lead trae las clases del tenant y el nombre de quien corrigió", async () => {
    const r = await get("/v1/panel/leads/leads/l-1/historial");

    expect(r.status).toBe(200);
    expect(r.body.data.clases).toEqual([{ id: "cl-1", nombre: "Caliente", color: "#8b5cf6" }]);
    expect(r.body.data.contactos[0].actorNombre).toBe("Otro Supervisor");
    expect(r.body.degradado).toBeUndefined();
  });

  it("si el catálogo no contesta, la ficha se sirve igual y dice qué faltó", async () => {
    leads.catalogo.mockResolvedValue({ success: false, statusCode: 503 });
    const r = await get("/v1/panel/leads/leads/l-1/historial");

    expect(r.status).toBe(200);
    expect(r.body.data.clases).toEqual([]);
    expect(r.body.degradado).toEqual([expect.objectContaining({ parte: "clases" })]);
  });

  it("la bandeja pone nombre a quien la tiene", async () => {
    const r = await get("/v1/panel/leads/conversaciones?estado=esperando_persona");
    expect(r.status).toBe(200);
    expect(r.body.data.conversaciones[0].asignadaANombre).toBe("Otro Supervisor");
    expect(leads.bandeja).toHaveBeenCalledWith("esperando_persona", expect.anything());
  });

  it("la ficha de conversación compone lead, consumo y agente, y ninguno de los tres la tumba", async () => {
    const r = await get("/v1/panel/leads/conversaciones/c-1/ficha");
    expect(r.status).toBe(200);
    expect(r.body.data.lead).toEqual(LEAD);
    expect(r.body.data.consumo).toEqual({ totalTokens: 10 });
    expect(r.body.data.agente).toEqual({ id: "ag-1", nombre: "Vendedor" });

    agentes.consumoDeSesion.mockRejectedValue(new Error("caído"));
    mensajeria.listarCuentas.mockRejectedValue(new Error("caído"));
    const r2 = await get("/v1/panel/leads/conversaciones/c-1/ficha");
    expect(r2.status).toBe(200);
    expect(r2.body.data.consumo).toBeNull();
    expect(r2.body.data.agente).toBeNull();
  });

  it("tomar se presenta con el nombre resuelto, y el 409 dice quién la tiene", async () => {
    const r = await post("/v1/panel/leads/conversaciones/c-1/tomar");
    expect(r.status).toBe(200);
    expect(leads.accion).toHaveBeenCalledWith("c-1", "tomar", expect.anything(), "Ana");

    leads.accion.mockResolvedValue({ success: false, statusCode: 409, data: { laTiene: "user-otro" } });
    const conflicto = await post("/v1/panel/leads/conversaciones/c-1/tomar");
    expect(conflicto.status).toBe(409);
    expect(conflicto.body.detalle).toEqual({ laTiene: "user-otro", laTieneNombre: "Otro Supervisor" });
  });

  it("responder vacío es un 400 sin gastar el viaje", async () => {
    const r = await post("/v1/panel/leads/conversaciones/c-1/responder").send({ texto: "  " });
    expect(r.status).toBe(400);
    expect(leads.responder).not.toHaveBeenCalled();
  });

  it("corregir el contacto reenvía sólo los tres campos, tal como vinieron", async () => {
    leads.corregirContacto.mockResolvedValue({ success: true, statusCode: 200, data: LEAD });
    const r = await put("/v1/panel/leads/leads/l-1/contacto").send({ nombre: " Marta ", correo: null, organizacionId: "otra", origen: "modelo" });
    expect(r.status).toBe(200);
    expect(leads.corregirContacto).toHaveBeenCalledWith("l-1", { nombre: "Marta", correo: null }, expect.anything());
  });

  it("los recursos son los del agente de ESTA conversación, y un id ajeno es un 404", async () => {
    const r = await get("/v1/panel/leads/conversaciones/c-1/recursos");
    expect(r.status).toBe(200);
    expect(r.body.data[0]).toMatchObject({ id: "r-1", fileName: "guia.pdf", falta: false });

    const ajeno = await post("/v1/panel/leads/conversaciones/c-1/recursos/r-de-otro").send({ texto: "toma" });
    expect(ajeno.status).toBe(404);
    expect(leads.mandarRecurso).not.toHaveBeenCalled();
  });
});

describe("El historial de atención (leads:history)", () => {
  const EVENTOS = [
    { id: "e2", conversacionId: "c-1", canal: "telegram", tipo: "liberada", actorId: "user-otro", motivo: null, en: "2026-09-30T10:05:00.000Z" },
    { id: "e1", conversacionId: "c-1", canal: "telegram", tipo: "iniciada", actorId: null, motivo: null, en: "2026-09-30T10:00:00.000Z" },
  ];

  it("sin el permiso es un 403 y ni se llama al servicio: ni leer ni atender lo dan", async () => {
    const r = await get("/v1/panel/leads/leads/l-1/atencion", "leads:read,leads:attend");
    expect(r.status).toBe(403);
    expect(r.body.permisoRequerido).toBe("leads:history");
    expect(leads.atencionDelLead).not.toHaveBeenCalled();
  });

  it("con el permiso llega con el nombre de cada persona, y la línea del sistema sin nombre", async () => {
    leads.atencionDelLead.mockResolvedValue({ success: true, statusCode: 200, data: { eventos: EVENTOS } });
    const r = await get("/v1/panel/leads/leads/l-1/atencion", "leads:history");
    expect(r.status).toBe(200);
    expect(r.body.data.eventos[0]).toMatchObject({ tipo: "liberada", actorNombre: "Otro Supervisor" });
    expect(r.body.data.eventos[1]).toMatchObject({ tipo: "iniciada", actorNombre: null });
    expect(leads.atencionDelLead).toHaveBeenCalledWith("l-1", expect.anything());
  });

  it("si no se puede resolver un nombre, la línea sale sin él y no se rompe nada", async () => {
    leads.atencionDelLead.mockResolvedValue({ success: true, statusCode: 200, data: { eventos: EVENTOS } });
    usuarios.nombresDeUsuarios.mockRejectedValue(new Error("ms-auth caído"));
    const r = await get("/v1/panel/leads/leads/l-1/atencion", "leads:history");
    expect(r.status).toBe(200);
    expect(r.body.data.eventos[0].actorNombre).toBeNull();
  });

  it("un servicio sin datos devuelve la lista vacía, y un fallo se reenvía", async () => {
    leads.atencionDelLead.mockResolvedValue({ success: true, statusCode: 200 });
    expect((await get("/v1/panel/leads/leads/l-1/atencion", "leads:history")).body.data.eventos).toEqual([]);
    leads.atencionDelLead.mockResolvedValue({ success: false, statusCode: 404 });
    expect((await get("/v1/panel/leads/leads/l-1/atencion", "leads:history")).status).toBe(404);
  });

  it("leerlo queda auditado: es saber quién atendió a quién", async () => {
    leads.atencionDelLead.mockResolvedValue({ success: true, statusCode: 200, data: { eventos: [] } });
    await get("/v1/panel/leads/leads/l-1/atencion", "leads:history");
    expect(auditoria.publishAudit).toHaveBeenCalledWith(
      expect.objectContaining({ service: "bff-widget", action: "READ_ATTENTION_HISTORY", resource: "lead", resourceId: "l-1", actorId: "user-ana" }),
    );
  });
});

describe("SPEC-273 · Todo queda auditado con su origen", () => {
  it("abrir una ficha deja rastro: quién, qué, desde dónde y por qué superficie", async () => {
    await get("/v1/panel/leads/leads/l-1/historial");

    expect(auditoria.publishAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "bff-widget",
        tenantId: "org-acme",
        actorId: "user-ana",
        action: "READ_LEAD",
        resource: "lead",
        resourceId: "l-1",
        payload: expect.objectContaining({ origen: ORIGEN, superficie: "panel-incrustado", credencialId: "cred-erp", resultado: "ok" }),
      }),
    );
  });

  it("responder registra la longitud y nunca el texto; y el rastro no lleva el token", async () => {
    await post("/v1/panel/leads/conversaciones/c-1/responder").send({ texto: "hola, soy Ana" });

    const evento = auditoria.publishAudit.mock.calls.at(-1)![0] as { action: string; payload: Record<string, unknown> };
    expect(evento.action).toBe("REPLY");
    expect(evento.payload.longitud).toBe(13);
    expect(JSON.stringify(evento)).not.toContain("hola, soy Ana");
    expect(JSON.stringify(evento)).not.toContain("firma-de-mentira");
  });

  it("que la auditoría falle no tumba el trabajo", async () => {
    auditoria.publishAudit.mockRejectedValue(new Error("bus caído"));
    const r = await get("/v1/panel/leads/conversaciones/c-1");
    expect(r.status).toBe(200);
  });

  it("y el intento rechazado también queda", async () => {
    leads.accion.mockResolvedValue({ success: false, statusCode: 409, data: { laTiene: "user-otro" } });
    await post("/v1/panel/leads/conversaciones/c-1/tomar");
    expect(auditoria.publishAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "TAKE", payload: expect.objectContaining({ resultado: "rechazado", codigo: 409 }) }),
    );
  });

});
