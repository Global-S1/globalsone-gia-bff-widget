// Importados explícitamente, no por `globals: true`: el tsconfig de este repo
// restringe typeRoots, así que "vitest/globals" no resuelve como tipo.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough, Readable } from "stream";
import type { Request, Response } from "express";

/**
 * SPEC-167 — la puerta del mensaje del widget.
 *
 * Cada `it` de este fichero es un escenario del Gherkin del SPEC, con su nombre.
 * Lo que se prueba es **por dónde sale el mensaje**, no lo que hace el servicio
 * al otro lado: ms-agents y ms-leads están dobles.
 */

const createChatStream = vi.fn();
const getWidgetConfig = vi.fn();
const atenderMensajeDelWidget = vi.fn();

vi.mock("../../../bff/infrastructure/service-clients/agents-service.client", () => ({
  getAgentsServiceClient: () => ({ createChatStream, getWidgetConfig }),
}));

vi.mock("../../../bff/infrastructure/service-clients/leads-service.client", () => ({
  getLeadsServiceClient: () => ({ atenderMensajeDelWidget }),
}));

import { createChat } from "../chat.controller";
import { limpiarCacheDeConfiguracionDeWidget } from "../../../bff/infrastructure/cache/widget-config.cache";

const AGENTE = "agente-1";
const ORGANIZACION = "org-1";
const VISITANTE = "visitante-abc";

function peticion(
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Request {
  return {
    headers: { "unique-tenant-token": "token-de-organizacion", ...headers },
    body: { message: "hola", ...body },
    ip: "10.0.0.1",
  } as unknown as Request;
}

/**
 * Una respuesta que de verdad se puede escribir: el camino de hoy hace
 * `upstream.body.pipe(res)`, y un objeto con `vi.fn()` no es un destino válido
 * para un stream. Sobre un PassThrough sí, y además deja leer lo que se escribió.
 */
type RespuestaFalsa = PassThrough & {
  cabeceras: Record<string, string>;
  codigo: number | undefined;
  headersSent: boolean;
  setHeader: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  cuerpo: () => Promise<string>;
};

function respuesta(): RespuestaFalsa {
  const res = new PassThrough() as RespuestaFalsa;
  const escrito: Buffer[] = [];
  res.on("data", (t: Buffer) => escrito.push(t));

  res.cabeceras = {};
  res.codigo = undefined;
  res.headersSent = false;
  res.setHeader = vi.fn((nombre: string, valor: unknown) => {
    res.cabeceras[nombre] = String(valor);
    return res;
  });
  res.status = vi.fn((codigo: number) => {
    res.codigo = codigo;
    return res;
  });
  res.json = vi.fn((cuerpo: unknown) => {
    escrito.push(Buffer.from(JSON.stringify(cuerpo)));
    res.end();
    return res;
  });
  res.cuerpo = () =>
    new Promise<string>((resolve) => {
      const devolver = () => resolve(Buffer.concat(escrito).toString("utf8"));
      res.on("end", devolver);
      res.on("finish", devolver);
    });
  return res;
}

/** El controlador espera un `Response` de express; aquí sólo se usa lo que toca. */
function comoRespuesta(res: RespuestaFalsa): Response {
  return res as unknown as Response;
}

/** Lo que ms-agents devuelve hoy: cabeceras + un cuerpo que se sirve según llega. */
function respuestaDeAgents(texto = "respuesta del agente") {
  return {
    statusCode: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "chat-session-id": "sesion-1",
    },
    body: Readable.from([texto]),
  };
}

function configuracion(leadsEnabled: boolean, contactFormUrl: string | null = null) {
  return {
    success: true,
    statusCode: 200,
    duration: 1,
    data: { agentId: AGENTE, organizationId: ORGANIZACION, leadsEnabled, contactFormUrl },
  };
}

function respuestaDeLeads(extra: Record<string, unknown> = {}) {
  return {
    success: true,
    statusCode: 200,
    duration: 1,
    data: {
      conversacionId: "conv-1",
      texto: "respuesta desde leads",
      clase: null,
      porque: null,
      contacto: { nombre: null, correo: null, telefono: null },
      derivada: false,
      formularioDeContacto: null,
      ...extra,
    },
  };
}

describe("SPEC-167 · la puerta del mensaje del widget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limpiarCacheDeConfiguracionDeWidget();
    createChatStream.mockResolvedValue(respuestaDeAgents());
  });

  it("Un agente sin leads sigue como hoy", async () => {
    getWidgetConfig.mockResolvedValue(configuracion(false));
    const res = respuesta();

    await createChat(peticion({ agentId: AGENTE, visitorId: VISITANTE }), comoRespuesta(res));

    expect(createChatStream).toHaveBeenCalledTimes(1);
    expect(atenderMensajeDelWidget).not.toHaveBeenCalled();
    // Y la respuesta se sirve según se escribe, como hasta ahora.
    expect(res.cabeceras["Content-Type"]).toBe("text/plain; charset=utf-8");
    expect(res.cabeceras["Chat-Session-Id"]).toBe("sesion-1");
    await expect(res.cuerpo()).resolves.toBe("respuesta del agente");
  });

  it("Un agente con leads entra por ms-leads", async () => {
    getWidgetConfig.mockResolvedValue(configuracion(true));
    atenderMensajeDelWidget.mockResolvedValue(respuestaDeLeads());
    const res = respuesta();

    await createChat(peticion({ agentId: AGENTE, visitorId: VISITANTE }), comoRespuesta(res));

    expect(atenderMensajeDelWidget).toHaveBeenCalledTimes(1);
    expect(createChatStream).not.toHaveBeenCalled();
    await expect(res.cuerpo()).resolves.toBe("respuesta desde leads");
  });

  it("La organización sale de la configuración del agente, no del token", async () => {
    // El bff tiene un TOKEN de organización, no un identificador: quien lo
    // sabe es ms-agents, y lo dice en la misma consulta que el interruptor.
    getWidgetConfig.mockResolvedValue(configuracion(true));
    atenderMensajeDelWidget.mockResolvedValue(respuestaDeLeads());

    await createChat(peticion({ agentId: AGENTE, visitorId: VISITANTE }), comoRespuesta(respuesta()));

    expect(atenderMensajeDelWidget).toHaveBeenCalledWith(
      expect.objectContaining({ organizacionId: ORGANIZACION }),
      expect.anything(),
    );
  });

  it("La configuración del agente no se pregunta en cada mensaje", async () => {
    getWidgetConfig.mockResolvedValue(configuracion(true));
    atenderMensajeDelWidget.mockResolvedValue(respuestaDeLeads());

    await createChat(peticion({ agentId: AGENTE, visitorId: VISITANTE }), comoRespuesta(respuesta()));
    await createChat(peticion({ agentId: AGENTE, visitorId: VISITANTE }), comoRespuesta(respuesta()));

    expect(atenderMensajeDelWidget).toHaveBeenCalledTimes(2);
    expect(getWidgetConfig).toHaveBeenCalledTimes(1);
  });

  it("Si no se puede saber la configuración, se atiende como hoy", async () => {
    getWidgetConfig.mockResolvedValue({
      success: false,
      statusCode: 503,
      duration: 1,
      error: { code: "CONNECTION_ERROR", message: "no hay nadie", service: "ms-agents" },
    });
    const res = respuesta();

    await createChat(peticion({ agentId: AGENTE, visitorId: VISITANTE }), comoRespuesta(res));

    expect(createChatStream).toHaveBeenCalledTimes(1);
    expect(atenderMensajeDelWidget).not.toHaveBeenCalled();
    // Y el visitante recibe su respuesta.
    await expect(res.cuerpo()).resolves.toBe("respuesta del agente");
  });

  it("Si la consulta de la configuración revienta, se atiende como hoy", async () => {
    getWidgetConfig.mockRejectedValue(new Error("boom"));
    const res = respuesta();

    await createChat(peticion({ agentId: AGENTE, visitorId: VISITANTE }), comoRespuesta(res));

    expect(createChatStream).toHaveBeenCalledTimes(1);
    await expect(res.cuerpo()).resolves.toBe("respuesta del agente");
  });

  it("Un fallo de la configuración no se queda cacheado", async () => {
    getWidgetConfig.mockResolvedValueOnce({
      success: false,
      statusCode: 503,
      duration: 1,
      error: { code: "CONNECTION_ERROR", message: "no hay nadie", service: "ms-agents" },
    });
    getWidgetConfig.mockResolvedValue(configuracion(true));
    atenderMensajeDelWidget.mockResolvedValue(respuestaDeLeads());

    await createChat(peticion({ agentId: AGENTE, visitorId: VISITANTE }), comoRespuesta(respuesta()));
    await createChat(peticion({ agentId: AGENTE, visitorId: VISITANTE }), comoRespuesta(respuesta()));

    expect(getWidgetConfig).toHaveBeenCalledTimes(2);
    expect(atenderMensajeDelWidget).toHaveBeenCalledTimes(1);
  });

  it("El identificador de visitante viaja a ms-leads", async () => {
    getWidgetConfig.mockResolvedValue(configuracion(true));
    atenderMensajeDelWidget.mockResolvedValue(respuestaDeLeads());

    await createChat(peticion({ agentId: AGENTE, visitorId: VISITANTE }), comoRespuesta(respuesta()));

    expect(atenderMensajeDelWidget).toHaveBeenCalledWith(
      expect.objectContaining({ visitanteId: VISITANTE, agenteId: AGENTE, texto: "hola" }),
      expect.anything(),
    );
  });

  it("La IP del visitante viaja a ms-leads", async () => {
    getWidgetConfig.mockResolvedValue(configuracion(true));
    atenderMensajeDelWidget.mockResolvedValue(respuestaDeLeads());

    await createChat(
      peticion({ agentId: AGENTE, visitorId: VISITANTE }, { "ip-address": "203.0.113.9" }),
      comoRespuesta(respuesta()),
    );

    expect(atenderMensajeDelWidget).toHaveBeenCalledWith(
      expect.objectContaining({ ip: "203.0.113.9" }),
      expect.anything(),
    );
  });

  it("Un mensaje sin agente no entra por leads", async () => {
    const res = respuesta();

    await createChat(peticion({ visitorId: VISITANTE }), comoRespuesta(res));

    expect(getWidgetConfig).not.toHaveBeenCalled();
    expect(atenderMensajeDelWidget).not.toHaveBeenCalled();
    expect(createChatStream).toHaveBeenCalledTimes(1);
    await expect(res.cuerpo()).resolves.toBe("respuesta del agente");
  });

  it("Un mensaje sin identificador de visitante se atiende por el camino de siempre", async () => {
    // ms-leads exige `visitanteId` —es la identidad del lead en este canal— y
    // sin él devolvería 422. Quedarse mudo por eso sería peor que atender.
    getWidgetConfig.mockResolvedValue(configuracion(true));
    const res = respuesta();

    await createChat(peticion({ agentId: AGENTE }), comoRespuesta(res));

    expect(atenderMensajeDelWidget).not.toHaveBeenCalled();
    expect(createChatStream).toHaveBeenCalledTimes(1);
    await expect(res.cuerpo()).resolves.toBe("respuesta del agente");
  });

  it("El enlace del formulario llega al widget", async () => {
    getWidgetConfig.mockResolvedValue(configuracion(true, "https://tenant.example/contacto"));
    atenderMensajeDelWidget.mockResolvedValue(
      respuestaDeLeads({
        derivada: true,
        formularioDeContacto: "https://tenant.example/contacto",
        texto: "No sé responderte a eso; te dejo nuestro formulario.",
      }),
    );
    const res = respuesta();

    await createChat(peticion({ agentId: AGENTE, visitorId: VISITANTE }), comoRespuesta(res));

    expect(res.cabeceras["Contact-Form-Url"]).toBe("https://tenant.example/contacto");
    await expect(res.cuerpo()).resolves.toBe(
      "No sé responderte a eso; te dejo nuestro formulario.",
    );
  });

  it("Sin derivación no se ofrece ningún enlace", async () => {
    getWidgetConfig.mockResolvedValue(configuracion(true, "https://tenant.example/contacto"));
    atenderMensajeDelWidget.mockResolvedValue(respuestaDeLeads());
    const res = respuesta();

    await createChat(peticion({ agentId: AGENTE, visitorId: VISITANTE }), comoRespuesta(res));

    expect(res.cabeceras["Contact-Form-Url"]).toBeUndefined();
  });

  it("Un enlace que no es una dirección http no se pone en la cabecera", async () => {
    // `setHeader` con un salto de línea dentro reventaría la respuesta entera:
    // el borde que da a un navegador ajeno no se fía de lo que le llega.
    getWidgetConfig.mockResolvedValue(configuracion(true));
    atenderMensajeDelWidget.mockResolvedValue(
      respuestaDeLeads({ derivada: true, formularioDeContacto: "javascript:alert(1)" }),
    );
    const res = respuesta();

    await createChat(peticion({ agentId: AGENTE, visitorId: VISITANTE }), comoRespuesta(res));

    expect(res.cabeceras["Contact-Form-Url"]).toBeUndefined();
    expect(res.codigo).toBe(200);
  });

  it("El error de ms-leads se traduce a algo que el widget pueda enseñar", async () => {
    getWidgetConfig.mockResolvedValue(configuracion(true));
    atenderMensajeDelWidget.mockResolvedValue({
      success: false,
      statusCode: 502,
      duration: 1,
      error: {
        code: "502",
        message: "Request failed",
        service: "ms-leads",
        details: {
          error: "No he podido responderte ahora mismo. Vuelve a intentarlo en un momento.",
        },
      },
    });
    const res = respuesta();

    await createChat(peticion({ agentId: AGENTE, visitorId: VISITANTE }), comoRespuesta(res));

    expect(res.codigo).toBe(502);
    // El widget lee `kindMessage || message`; aquí va en `message`.
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: "No he podido responderte ahora mismo. Vuelve a intentarlo en un momento.",
    });
    // Y NO se reintenta por el otro camino: la conversación tiene un solo dueño.
    expect(createChatStream).not.toHaveBeenCalled();
  });

  it("Un error de configuración de ms-leads no se le enseña al visitante", async () => {
    // 403 «falta el token de servicio» es nuestro, no suyo: se registra y se le
    // dice al visitante lo único que le sirve.
    getWidgetConfig.mockResolvedValue(configuracion(true));
    atenderMensajeDelWidget.mockResolvedValue({
      success: false,
      statusCode: 403,
      duration: 1,
      error: {
        code: "403",
        message: "Request failed",
        service: "ms-leads",
        details: { error: "Esta ruta es interna: falta el token de servicio o no coincide" },
      },
    });
    const res = respuesta();

    await createChat(peticion({ agentId: AGENTE, visitorId: VISITANTE }), comoRespuesta(res));

    expect(res.codigo).toBe(502);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: expect.not.stringContaining("token de servicio"),
    });
  });

  it("Una conversación en la que el bot calla no pinta un globo vacío", async () => {
    // `texto: null` es un estado terminal de ms-leads, no un fallo.
    getWidgetConfig.mockResolvedValue(configuracion(true));
    atenderMensajeDelWidget.mockResolvedValue(respuestaDeLeads({ texto: null }));
    const res = respuesta();

    await createChat(peticion({ agentId: AGENTE, visitorId: VISITANTE }), comoRespuesta(res));

    expect(res.codigo).toBe(200);
    await expect(res.cuerpo()).resolves.toBe("");
  });
});
