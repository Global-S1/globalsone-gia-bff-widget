// Importados explícitamente, no por `globals: true`: el tsconfig de este repo
// restringe typeRoots, así que "vitest/globals" no resuelve como tipo.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { logger } from "../../../entities/shared/infraestructure/utils/logger";

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
      // SPEC-182: **siempre presente y vacía cuando no hay ninguna**, nunca
      // ausente y nunca nula. Verificado en `ms-leads/src/orquestador.ts`.
      fotos: [] as string[],
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

    await createChat(peticion({ agentId: AGENTE, visitanteId: VISITANTE }), comoRespuesta(res));

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

    await createChat(peticion({ agentId: AGENTE, visitanteId: VISITANTE }), comoRespuesta(res));

    expect(atenderMensajeDelWidget).toHaveBeenCalledTimes(1);
    expect(createChatStream).not.toHaveBeenCalled();
    await expect(res.cuerpo()).resolves.toBe("respuesta desde leads");
  });

  it("La organización sale de la configuración del agente, no del token", async () => {
    // El bff tiene un TOKEN de organización, no un identificador: quien lo
    // sabe es ms-agents, y lo dice en la misma consulta que el interruptor.
    getWidgetConfig.mockResolvedValue(configuracion(true));
    atenderMensajeDelWidget.mockResolvedValue(respuestaDeLeads());

    await createChat(peticion({ agentId: AGENTE, visitanteId: VISITANTE }), comoRespuesta(respuesta()));

    expect(atenderMensajeDelWidget).toHaveBeenCalledWith(
      expect.objectContaining({ organizacionId: ORGANIZACION }),
      expect.anything(),
    );
  });

  it("La configuración del agente no se pregunta en cada mensaje", async () => {
    getWidgetConfig.mockResolvedValue(configuracion(true));
    atenderMensajeDelWidget.mockResolvedValue(respuestaDeLeads());

    await createChat(peticion({ agentId: AGENTE, visitanteId: VISITANTE }), comoRespuesta(respuesta()));
    await createChat(peticion({ agentId: AGENTE, visitanteId: VISITANTE }), comoRespuesta(respuesta()));

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

    await createChat(peticion({ agentId: AGENTE, visitanteId: VISITANTE }), comoRespuesta(res));

    expect(createChatStream).toHaveBeenCalledTimes(1);
    expect(atenderMensajeDelWidget).not.toHaveBeenCalled();
    // Y el visitante recibe su respuesta.
    await expect(res.cuerpo()).resolves.toBe("respuesta del agente");
  });

  it("Si la consulta de la configuración revienta, se atiende como hoy", async () => {
    getWidgetConfig.mockRejectedValue(new Error("boom"));
    const res = respuesta();

    await createChat(peticion({ agentId: AGENTE, visitanteId: VISITANTE }), comoRespuesta(res));

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

    await createChat(peticion({ agentId: AGENTE, visitanteId: VISITANTE }), comoRespuesta(respuesta()));
    await createChat(peticion({ agentId: AGENTE, visitanteId: VISITANTE }), comoRespuesta(respuesta()));

    expect(getWidgetConfig).toHaveBeenCalledTimes(2);
    expect(atenderMensajeDelWidget).toHaveBeenCalledTimes(1);
  });

  it("El identificador de visitante viaja a ms-leads", async () => {
    getWidgetConfig.mockResolvedValue(configuracion(true));
    atenderMensajeDelWidget.mockResolvedValue(respuestaDeLeads());

    await createChat(peticion({ agentId: AGENTE, visitanteId: VISITANTE }), comoRespuesta(respuesta()));

    expect(atenderMensajeDelWidget).toHaveBeenCalledWith(
      expect.objectContaining({ visitanteId: VISITANTE, agenteId: AGENTE, texto: "hola" }),
      expect.anything(),
    );
  });

  it("La IP del visitante viaja a ms-leads", async () => {
    getWidgetConfig.mockResolvedValue(configuracion(true));
    atenderMensajeDelWidget.mockResolvedValue(respuestaDeLeads());

    await createChat(
      peticion({ agentId: AGENTE, visitanteId: VISITANTE }, { "ip-address": "203.0.113.9" }),
      comoRespuesta(respuesta()),
    );

    expect(atenderMensajeDelWidget).toHaveBeenCalledWith(
      expect.objectContaining({ ip: "203.0.113.9" }),
      expect.anything(),
    );
  });

  it("Un mensaje sin agente no entra por leads", async () => {
    const res = respuesta();

    await createChat(peticion({ visitanteId: VISITANTE }), comoRespuesta(res));

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

    await createChat(peticion({ agentId: AGENTE, visitanteId: VISITANTE }), comoRespuesta(res));

    expect(res.cabeceras["Contact-Form-Url"]).toBe("https://tenant.example/contacto");
    await expect(res.cuerpo()).resolves.toBe(
      "No sé responderte a eso; te dejo nuestro formulario.",
    );
  });

  it("Sin derivación no se ofrece ningún enlace", async () => {
    getWidgetConfig.mockResolvedValue(configuracion(true, "https://tenant.example/contacto"));
    atenderMensajeDelWidget.mockResolvedValue(respuestaDeLeads());
    const res = respuesta();

    await createChat(peticion({ agentId: AGENTE, visitanteId: VISITANTE }), comoRespuesta(res));

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

    await createChat(peticion({ agentId: AGENTE, visitanteId: VISITANTE }), comoRespuesta(res));

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

    await createChat(peticion({ agentId: AGENTE, visitanteId: VISITANTE }), comoRespuesta(res));

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

    await createChat(peticion({ agentId: AGENTE, visitanteId: VISITANTE }), comoRespuesta(res));

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

    await createChat(peticion({ agentId: AGENTE, visitanteId: VISITANTE }), comoRespuesta(res));

    expect(res.codigo).toBe(200);
    await expect(res.cuerpo()).resolves.toBe("");
  });
});


// ── SPEC-181 ────────────────────────────────────────────────────────────────

/** El token de organización que el widget lleva en su fragmento del embed. */
const TOKEN_DE_ORGANIZACION = "token-de-organizacion";

/** Lo que `getUserIP()` resuelve en el widget antes de componer el cuerpo. */
const IP_DEL_VISITANTE = "203.0.113.9";

/**
 * El cuerpo tal como lo compone el widget publicado.
 *
 * **Transcrito de** `globalsone-gia-widget/src/api.js`, función `sendQuestion`:
 * el `JSON.stringify(...)` del `fetch` a `/chat/create-chat`, con la misma
 * forma condicional de `agentId` y `chatSessionId` y el mismo
 * `const visitanteId = fields.visitanteId || getVisitorId()`.
 *
 * **No se inventa, y esto es el SPEC entero.** El fallo de producción no estaba
 * en el widget ni estaba aquí: estaba en la costura —el widget mandaba
 * `visitanteId` y este bff leía `visitorId`— y ninguna de las dos suites la
 * cruzaba, porque cada una escribía su propio cuerpo y por tanto sólo se
 * confirmaba a sí misma. Un cuerpo escrito a mano en este fichero volvería a
 * dejar el mismo hueco abierto.
 *
 * Si el widget cambia el nombre de un campo, esta copia se trae otra vez de
 * allí; no se ajusta a lo que el bff espera leer.
 */
function cuerpoDelWidgetPublicado(): Record<string, unknown> {
  // Lo que el componente `<chat-float>` le pasa a `sendQuestion`.
  const fields: {
    message: string;
    uniqueOrganizationToken: string;
    agentId?: string;
    chatSessionId?: string;
    visitanteId?: string;
  } = {
    message: "hola",
    uniqueOrganizationToken: TOKEN_DE_ORGANIZACION,
    agentId: AGENTE,
  };
  const userIp = IP_DEL_VISITANTE;
  const visitanteId = fields.visitanteId || VISITANTE; // `|| getVisitorId()`

  return {
    message: fields.message,
    uniqueTenantToken: fields.uniqueOrganizationToken,
    ...(fields.agentId && { agentId: fields.agentId }),
    ...(fields.chatSessionId && { chatSessionId: fields.chatSessionId }),
    ipAddress: userIp,
    visitanteId,
  };
}

/** Las cabeceras del mismo `fetch`, con el cuerpo que se le dé. */
function peticionDelWidget(cuerpo: Record<string, unknown>): Request {
  return {
    headers: {
      "content-type": "application/json",
      "unique-tenant-token": TOKEN_DE_ORGANIZACION,
      "ip-address": IP_DEL_VISITANTE,
    },
    body: cuerpo,
    ip: "10.0.0.1",
  } as unknown as Request;
}

describe("SPEC-181 · el identificador de visitante llega desde el widget", () => {
  let avisos: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    limpiarCacheDeConfiguracionDeWidget();
    createChatStream.mockResolvedValue(respuestaDeAgents());
    // Un agente con la clasificación de leads encendida.
    getWidgetConfig.mockResolvedValue(configuracion(true));
    atenderMensajeDelWidget.mockResolvedValue(respuestaDeLeads());
    avisos = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    avisos.mockRestore();
  });

  it("El cuerpo que manda el widget de verdad entra por ms-leads", async () => {
    const cuerpo = cuerpoDelWidgetPublicado();
    const res = respuesta();

    await createChat(peticionDelWidget(cuerpo), comoRespuesta(res));

    expect(atenderMensajeDelWidget).toHaveBeenCalledTimes(1);
    expect(createChatStream).not.toHaveBeenCalled();
    // Y el identificador que recibe ms-leads es el que venía EN EL CUERPO: se
    // lee de él, no de una constante del test, para que no pueda coincidir por
    // casualidad con lo que el bff creyera estar leyendo.
    expect(cuerpo.visitanteId).toBeTruthy();
    expect(atenderMensajeDelWidget).toHaveBeenCalledWith(
      expect.objectContaining({ visitanteId: cuerpo.visitanteId }),
      expect.anything(),
    );
    await expect(res.cuerpo()).resolves.toBe("respuesta desde leads");
  });

  it("Un cuerpo sin identificador sigue cayendo al camino de siempre", async () => {
    const cuerpo = cuerpoDelWidgetPublicado();
    delete cuerpo.visitanteId;
    const res = respuesta();

    await createChat(peticionDelWidget(cuerpo), comoRespuesta(res));

    expect(createChatStream).toHaveBeenCalledTimes(1);
    expect(atenderMensajeDelWidget).not.toHaveBeenCalled();
    // Y queda constancia: desde fuera, un agente encendido que no registra
    // leads se ve como una avería y hay que poder distinguirlo (SPEC-167).
    expect(avisos).toHaveBeenCalledWith(
      expect.stringContaining("visitanteId"),
      expect.objectContaining({ agentId: AGENTE }),
    );
    await expect(res.cuerpo()).resolves.toBe("respuesta del agente");
  });

  it("Un identificador en blanco cuenta como ausente", async () => {
    const cuerpo = cuerpoDelWidgetPublicado();
    cuerpo.visitanteId = "   ";
    const res = respuesta();

    await createChat(peticionDelWidget(cuerpo), comoRespuesta(res));

    expect(createChatStream).toHaveBeenCalledTimes(1);
    expect(atenderMensajeDelWidget).not.toHaveBeenCalled();
  });

  it("El nombre en inglés ya no se lee", async () => {
    // No es compatibilidad hacia atrás: ninguna versión publicada del widget lo
    // mandó nunca así. Admitir dos nombres para el mismo dato es exactamente lo
    // que dejó pasar este fallo, así que el viejo tiene que quedar muerto.
    const cuerpo = cuerpoDelWidgetPublicado();
    delete cuerpo.visitanteId;
    cuerpo.visitorId = VISITANTE;
    const res = respuesta();

    await createChat(peticionDelWidget(cuerpo), comoRespuesta(res));

    expect(createChatStream).toHaveBeenCalledTimes(1);
    expect(atenderMensajeDelWidget).not.toHaveBeenCalled();
  });
});


// ── SPEC-183 ────────────────────────────────────────────────────────────────

/** Lo que hará el widget con la cabecera. */
function fotosQueLeeElNavegador(res: RespuestaFalsa): string[] | undefined {
  const valor = res.cabeceras["Chat-Photos"];
  if (valor === undefined) return undefined;
  return JSON.parse(Buffer.from(valor, "base64").toString("utf8")) as string[];
}

const UNA_FOTO = "https://cdn.acme.example/catalogo/silla-roja.jpg";
const OTRA_FOTO = "https://cdn.acme.example/catalogo/silla-azul.jpg";

describe("SPEC-183 · las fotos hacia el navegador", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limpiarCacheDeConfiguracionDeWidget();
    createChatStream.mockResolvedValue(respuestaDeAgents());
    // Un agente con la clasificación de leads encendida.
    getWidgetConfig.mockResolvedValue(configuracion(true));
  });

  it("Las fotos llegan al widget", async () => {
    atenderMensajeDelWidget.mockResolvedValue(
      respuestaDeLeads({
        texto: "Tengo estas dos sillas.",
        fotos: [UNA_FOTO, OTRA_FOTO],
      }),
    );
    const res = respuesta();

    await createChat(peticion({ agentId: AGENTE, visitanteId: VISITANTE }), comoRespuesta(res));

    // Las dos direcciones, en su orden.
    expect(fotosQueLeeElNavegador(res)).toEqual([UNA_FOTO, OTRA_FOTO]);
    // Y el cuerpo sigue siendo SÓLO el texto del agente: lo que se meta ahí se
    // le pinta a quien escribe, así que no cabe nada más.
    await expect(res.cuerpo()).resolves.toBe("Tengo estas dos sillas.");
    expect(res.cabeceras["Content-Type"]).toBe("text/plain; charset=utf-8");
  });

  it("Sin fotos no se manda nada de esto", async () => {
    // ms-leads manda `fotos: []` —siempre presente, vacía cuando no hay
    // ninguna (SPEC-182)—, y una lista vacía NO es una cabecera vacía.
    atenderMensajeDelWidget.mockResolvedValue(respuestaDeLeads({ fotos: [] }));
    const res = respuesta();

    await createChat(peticion({ agentId: AGENTE, visitanteId: VISITANTE }), comoRespuesta(res));

    expect(res.cabeceras["Chat-Photos"]).toBeUndefined();
    await expect(res.cuerpo()).resolves.toBe("respuesta desde leads");
  });

  it("Una dirección que no es http o https no se entrega", async () => {
    atenderMensajeDelWidget.mockResolvedValue(
      respuestaDeLeads({ fotos: ["javascript:alert(1)", UNA_FOTO] }),
    );
    const res = respuesta();

    await createChat(peticion({ agentId: AGENTE, visitanteId: VISITANTE }), comoRespuesta(res));

    expect(fotosQueLeeElNavegador(res)).toEqual([UNA_FOTO]);
  });

  it("Una lista demasiado grande no rompe la respuesta", async () => {
    // Detrás hay un nginx que lee las cabeceras en un buffer fijo: pasarse
    // pierde la respuesta ENTERA, texto incluido. Antes menos fotos que nada.
    const larga = `https://cdn.acme.example/catalogo/${"a".repeat(300)}.jpg`;
    atenderMensajeDelWidget.mockResolvedValue(
      respuestaDeLeads({
        texto: "Mira el catálogo.",
        fotos: Array.from({ length: 40 }, (_, i) => `${larga}?n=${i}`),
      }),
    );
    const res = respuesta();

    await createChat(peticion({ agentId: AGENTE, visitanteId: VISITANTE }), comoRespuesta(res));

    const entregadas = fotosQueLeeElNavegador(res) as string[];
    expect(entregadas.length).toBeGreaterThan(0);
    expect(entregadas.length).toBeLessThan(40);
    // Y el texto sale igual.
    expect(res.codigo).toBe(200);
    await expect(res.cuerpo()).resolves.toBe("Mira el catálogo.");
  });

  it("Las fotos y el enlace del formulario caben en la misma respuesta", async () => {
    // Son dos cabeceras distintas y ninguna estorba a la otra: una conversación
    // derivada puede seguir enseñando lo que el agente señaló.
    atenderMensajeDelWidget.mockResolvedValue(
      respuestaDeLeads({
        derivada: true,
        formularioDeContacto: "https://tenant.example/contacto",
        fotos: [UNA_FOTO],
      }),
    );
    const res = respuesta();

    await createChat(peticion({ agentId: AGENTE, visitanteId: VISITANTE }), comoRespuesta(res));

    expect(res.cabeceras["Contact-Form-Url"]).toBe("https://tenant.example/contacto");
    expect(fotosQueLeeElNavegador(res)).toEqual([UNA_FOTO]);
  });

  it("El camino de siempre no cambia", async () => {
    // Un agente con la clasificación apagada: ni una cabecera nueva, y el
    // cuerpo se sigue sirviendo según se escribe.
    getWidgetConfig.mockResolvedValue(configuracion(false));
    const res = respuesta();

    await createChat(peticion({ agentId: AGENTE, visitanteId: VISITANTE }), comoRespuesta(res));

    expect(createChatStream).toHaveBeenCalledTimes(1);
    expect(res.cabeceras["Chat-Photos"]).toBeUndefined();
    expect(res.cabeceras["Chat-Session-Id"]).toBe("sesion-1");
    await expect(res.cuerpo()).resolves.toBe("respuesta del agente");
  });
});
