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

const apuntarOrigen = vi.fn();
vi.mock("../../../bff/application/use-cases/apuntar-origen.use-case", () => ({
  apuntarOrigen: (...args: unknown[]) => apuntarOrigen(...args),
}));

import { createChat } from "../chat.controller";
import { limpiarCacheDeConfiguracionDeWidget } from "../../../bff/infrastructure/cache/widget-config.cache";
import { logger } from "../../../entities/shared/infraestructure/utils/logger";
import { PRESUPUESTO_DE_CABECERAS } from "../apartados-en-cabecera";

const AGENTE = "agente-1";
const ORGANIZACION = "org-1";
const VISITANTE = "visitante-abc";
const WIDGET = "widget-1";

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

/** Como `peticion`, pero sin token de organización: el fragmento nuevo. */
function peticionSinToken(body: Record<string, unknown> = {}): Request {
  return {
    headers: {},
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

function configuracion(
  leadsEnabled: boolean,
  contactFormUrl: string | null = null,
  extra: Record<string, unknown> = {},
) {
  return {
    success: true,
    statusCode: 200,
    duration: 1,
    data: {
      // SPEC-195 · ADR-037: el widget ya es una entidad, así que la resolución
      // trae su identificador y si está activo, además del agente y la
      // organización. Verificado en `ms-agents/src/application/widgets/
      // widgets.service.ts` (`configuracionInterna`).
      widgetId: WIDGET,
      agentId: AGENTE,
      organizationId: ORGANIZACION,
      active: true,
      leadsEnabled,
      contactFormUrl,
      // SPEC-205: los dos campos salen SIEMPRE por la ruta interna, y
      // `allowedDomains` también cuando está vacía —quien compara necesita
      // distinguir «no hay lista» de «no me lo contó»—. Así nace un widget:
      // sin dominios declarados y con el bloqueo apagado.
      allowedDomains: [] as string[],
      domainBlockingEnabled: false,
      ...extra,
    },
  };
}

/** Lo que ms-agents contesta cuando `:id` no resuelve ni a widget ni a agente. */
function noResuelve() {
  return {
    success: false,
    statusCode: 404,
    duration: 1,
    error: {
      code: "404",
      message: "Request failed",
      service: "ms-agents",
      details: {
        success: false,
        kindMessage: "No existe ningún widget con ese identificador ni el de su agente",
      },
    },
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
      // SPEC-186: igual — siempre presente, vacía cuando no hay ninguno.
      ficheros: [] as { titulo: string; llave: string }[],
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


// ── SPEC-188 ────────────────────────────────────────────────────────────────

/** Lo que hará el widget con la cabecera hermana de `Chat-Photos`. */
function ficherosQueLeeElNavegador(
  res: RespuestaFalsa,
): { titulo: string; llave: string }[] | undefined {
  const valor = res.cabeceras["Chat-Files"];
  if (valor === undefined) return undefined;
  return JSON.parse(Buffer.from(valor, "base64").toString("utf8"));
}

/** 43 caracteres de `[A-Za-z0-9_-]`: 256 bits en base64url (SPEC-186). */
const UNA_LLAVE = "3pQ7x1Kb9vZ2mN4tR8sL0dF6hJ5wY7cA1eG3iU9oP2k";
const OTRA_LLAVE = "Zm9vYmFyYmF6cXV4MDEyMzQ1Njc4OWFiY2RlZmdoaWo";

describe("SPEC-188 · los ficheros hacia el navegador", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limpiarCacheDeConfiguracionDeWidget();
    createChatStream.mockResolvedValue(respuestaDeAgents());
    // Un agente con la clasificación de leads encendida.
    getWidgetConfig.mockResolvedValue(configuracion(true));
  });

  it("Los ficheros llegan al widget", async () => {
    atenderMensajeDelWidget.mockResolvedValue(
      respuestaDeLeads({
        texto: "Te dejo las tarifas y el catálogo.",
        ficheros: [
          { titulo: "Tarifas 2026", llave: UNA_LLAVE },
          { titulo: "Catálogo", llave: OTRA_LLAVE },
        ],
      }),
    );
    const res = respuesta();

    await createChat(peticion({ agentId: AGENTE, visitanteId: VISITANTE }), comoRespuesta(res));

    // Los dos, con su título y su llave, en su orden.
    expect(ficherosQueLeeElNavegador(res)).toEqual([
      { titulo: "Tarifas 2026", llave: UNA_LLAVE },
      { titulo: "Catálogo", llave: OTRA_LLAVE },
    ]);
    // Y el cuerpo sigue siendo sólo el texto del agente.
    await expect(res.cuerpo()).resolves.toBe("Te dejo las tarifas y el catálogo.");
    expect(res.cabeceras["Content-Type"]).toBe("text/plain; charset=utf-8");
  });

  it("Sin ficheros no se manda nada de esto", async () => {
    atenderMensajeDelWidget.mockResolvedValue(respuestaDeLeads({ ficheros: [] }));
    const res = respuesta();

    await createChat(peticion({ agentId: AGENTE, visitanteId: VISITANTE }), comoRespuesta(res));

    expect(res.cabeceras["Chat-Files"]).toBeUndefined();
    await expect(res.cuerpo()).resolves.toBe("respuesta desde leads");
  });

  it("Un título con acentos llega entero", async () => {
    // El título lo escribe el tenant, así que esto es el caso normal y no el
    // raro: una «ñ» cruda en una cabecera hace que Node rechace la respuesta
    // entera, y quien escribe se quedaría sin texto por culpa de un adjunto.
    atenderMensajeDelWidget.mockResolvedValue(
      respuestaDeLeads({
        ficheros: [{ titulo: "Catálogo de otoño", llave: UNA_LLAVE }],
      }),
    );
    const res = respuesta();

    await createChat(peticion({ agentId: AGENTE, visitanteId: VISITANTE }), comoRespuesta(res));

    expect(ficherosQueLeeElNavegador(res)).toEqual([
      { titulo: "Catálogo de otoño", llave: UNA_LLAVE },
    ]);
    expect(res.codigo).toBe(200);
  });

  it("Una lista demasiado grande no rompe la respuesta", async () => {
    const titulo = "Catálogo de otoño ".repeat(20);
    atenderMensajeDelWidget.mockResolvedValue(
      respuestaDeLeads({
        texto: "Ahí van.",
        ficheros: Array.from({ length: 30 }, (_, i) => ({
          titulo: `${titulo}${i}`,
          llave: UNA_LLAVE,
        })),
      }),
    );
    const res = respuesta();

    await createChat(peticion({ agentId: AGENTE, visitanteId: VISITANTE }), comoRespuesta(res));

    const entregados = ficherosQueLeeElNavegador(res)!;
    expect(entregados.length).toBeGreaterThan(0);
    expect(entregados.length).toBeLessThan(30);
    // Y el texto sale igual.
    expect(res.codigo).toBe(200);
    await expect(res.cuerpo()).resolves.toBe("Ahí van.");
  });

  it("Las fotos y los ficheros a la vez no se pasan del presupuesto", async () => {
    // **Esto es lo que cambia respecto a SPEC-183**: antes había UNA cabecera
    // que podía crecer, ahora hay dos. El límite que importa no es el de cada
    // una, es el bloque entero: el nginx de en medio no recorta, tira la
    // respuesta con un 502.
    const largo = `https://cdn.acme.example/catalogo/${"a".repeat(300)}.jpg`;
    const titulo = "Catálogo de otoño ".repeat(20);
    atenderMensajeDelWidget.mockResolvedValue(
      respuestaDeLeads({
        texto: "Todo junto.",
        fotos: Array.from({ length: 40 }, (_, i) => `${largo}?n=${i}`),
        ficheros: Array.from({ length: 30 }, (_, i) => ({
          titulo: `${titulo}${i}`,
          llave: UNA_LLAVE,
        })),
      }),
    );
    const res = respuesta();

    await createChat(peticion({ agentId: AGENTE, visitanteId: VISITANTE }), comoRespuesta(res));

    const juntas =
      res.cabeceras["Chat-Photos"]!.length + res.cabeceras["Chat-Files"]!.length;
    expect(juntas).toBeLessThanOrEqual(PRESUPUESTO_DE_CABECERAS);
    // Y ninguna de las dos se queda a cero por culpa de la otra: cada una tiene
    // su reserva, así que un turno con muchas fotos no apaga los ficheros.
    expect(ficherosQueLeeElNavegador(res)!.length).toBeGreaterThan(0);
    expect(fotosQueLeeElNavegador(res)!.length).toBeGreaterThan(0);
    await expect(res.cuerpo()).resolves.toBe("Todo junto.");
  });

  it("El camino de siempre no cambia", async () => {
    getWidgetConfig.mockResolvedValue(configuracion(false));
    const res = respuesta();

    await createChat(peticion({ agentId: AGENTE, visitanteId: VISITANTE }), comoRespuesta(res));

    expect(createChatStream).toHaveBeenCalledTimes(1);
    expect(res.cabeceras["Chat-Files"]).toBeUndefined();
    expect(res.cabeceras["Chat-Photos"]).toBeUndefined();
    await expect(res.cuerpo()).resolves.toBe("respuesta del agente");
  });
});


// ── SPEC-195 ────────────────────────────────────────────────────────────────

describe("SPEC-195 · la puerta del widget con identidad propia", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limpiarCacheDeConfiguracionDeWidget();
    createChatStream.mockResolvedValue(respuestaDeAgents());
    atenderMensajeDelWidget.mockResolvedValue(respuestaDeLeads());
  });

  it("Un mensaje con identificador de widget", async () => {
    // Ni el agente ni la organización vienen en la petición: los dos salen de
    // resolver el widget (ADR-037).
    getWidgetConfig.mockResolvedValue(configuracion(true));
    const res = respuesta();

    await createChat(
      peticion({ widgetId: WIDGET, visitanteId: VISITANTE }),
      comoRespuesta(res),
    );

    expect(getWidgetConfig).toHaveBeenCalledWith(WIDGET, expect.anything());
    expect(atenderMensajeDelWidget).toHaveBeenCalledWith(
      expect.objectContaining({ organizacionId: ORGANIZACION, agenteId: AGENTE }),
      expect.anything(),
    );
    await expect(res.cuerpo()).resolves.toBe("respuesta desde leads");
  });

  it("El agente resuelto es el del widget, no el que venga en el cuerpo", async () => {
    // Si los dos vienen, manda el widget: es la entidad, y el agente del cuerpo
    // es el dato viejo que se está retirando.
    getWidgetConfig.mockResolvedValue(configuracion(true, null, { agentId: "agente-del-widget" }));

    await createChat(
      peticion({ widgetId: WIDGET, agentId: "agente-del-cuerpo", visitanteId: VISITANTE }),
      comoRespuesta(respuesta()),
    );

    expect(getWidgetConfig).toHaveBeenCalledWith(WIDGET, expect.anything());
    expect(atenderMensajeDelWidget).toHaveBeenCalledWith(
      expect.objectContaining({ agenteId: "agente-del-widget" }),
      expect.anything(),
    );
  });

  it("Un fragmento antiguo sigue funcionando", async () => {
    // Sin `widgetId` se resuelve por el agente, y ms-agents devuelve el widget
    // por defecto: el más antiguo de los suyos.
    getWidgetConfig.mockResolvedValue(configuracion(true));
    const res = respuesta();

    await createChat(
      peticion({ agentId: AGENTE, visitanteId: VISITANTE }),
      comoRespuesta(res),
    );

    expect(getWidgetConfig).toHaveBeenCalledWith(AGENTE, expect.anything());
    expect(atenderMensajeDelWidget).toHaveBeenCalledTimes(1);
    await expect(res.cuerpo()).resolves.toBe("respuesta desde leads");
  });

  it("Un identificador que no existe", async () => {
    getWidgetConfig.mockResolvedValue(noResuelve());
    const res = respuesta();

    await createChat(peticion({ widgetId: "inventado" }), comoRespuesta(res));

    // Una frase que el widget pueda enseñar: la lee de `message`.
    expect(res.codigo).toBe(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: expect.stringContaining("asistente"),
    });
    // Y no se llama a nadie más.
    expect(createChatStream).not.toHaveBeenCalled();
    expect(atenderMensajeDelWidget).not.toHaveBeenCalled();
  });

  it("Un identificador que no existe no cuenta nada de dentro", async () => {
    getWidgetConfig.mockResolvedValue(noResuelve());
    const res = respuesta();

    await createChat(peticion({ widgetId: "inventado" }), comoRespuesta(res));

    const cuerpo = await res.cuerpo();
    expect(cuerpo).not.toContain("ms-agents");
    expect(cuerpo).not.toContain("widget con ese identificador");
  });

  it("Un widget desactivado no atiende", async () => {
    getWidgetConfig.mockResolvedValue(configuracion(true, null, { active: false }));
    const res = respuesta();

    await createChat(
      peticion({ widgetId: WIDGET, visitanteId: VISITANTE }),
      comoRespuesta(res),
    );

    expect(res.codigo).toBe(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: expect.stringContaining("no está disponible"),
    });
    // Ni por una puerta ni por la otra: un widget apagado no gasta modelo.
    expect(createChatStream).not.toHaveBeenCalled();
    expect(atenderMensajeDelWidget).not.toHaveBeenCalled();
  });

  it("Un widget desactivado se distingue de uno que no existe", async () => {
    // Dos frases distintas y dos códigos distintos: para quien instala el
    // widget, «lo apagaste» y «te equivocaste de identificador» son dos
    // problemas con dos arreglos.
    getWidgetConfig.mockResolvedValue(configuracion(true, null, { active: false }));
    const apagado = respuesta();
    await createChat(peticion({ widgetId: WIDGET }), comoRespuesta(apagado));

    limpiarCacheDeConfiguracionDeWidget();
    getWidgetConfig.mockResolvedValue(noResuelve());
    const inexistente = respuesta();
    await createChat(peticion({ widgetId: "otro" }), comoRespuesta(inexistente));

    expect(apagado.codigo).not.toBe(inexistente.codigo);
    await expect(apagado.cuerpo()).resolves.not.toBe(await inexistente.cuerpo());
  });

  it("Si no se puede saber quién es el widget, se atiende como hoy", async () => {
    // La regla de SPEC-167 sigue en pie y NO se confunde con «no existe»: un
    // tropiezo de ms-agents no puede dejar mudo el chat de un cliente, y un
    // 404 no puede disimularse como si fuera un tropiezo.
    getWidgetConfig.mockResolvedValue({
      success: false,
      statusCode: 503,
      duration: 1,
      error: { code: "CONNECTION_ERROR", message: "no hay nadie", service: "ms-agents" },
    });
    const res = respuesta();

    await createChat(
      peticion({ widgetId: WIDGET, visitanteId: VISITANTE }),
      comoRespuesta(res),
    );

    expect(createChatStream).toHaveBeenCalledTimes(1);
    await expect(res.cuerpo()).resolves.toBe("respuesta del agente");
  });

  it("Un mensaje sin ningún identificador sigue yendo por el token", async () => {
    // El fragmento más viejo de todos: sólo el token de organización, y es
    // ms-agents quien resuelve el agente a partir de él.
    const res = respuesta();

    await createChat(peticion({}), comoRespuesta(res));

    expect(getWidgetConfig).not.toHaveBeenCalled();
    expect(createChatStream).toHaveBeenCalledTimes(1);
    await expect(res.cuerpo()).resolves.toBe("respuesta del agente");
  });

  it("El agente del widget viaja a ms-agents cuando leads está apagado", async () => {
    // Con sólo `widgetId`, el camino de siempre tiene que saber a qué agente
    // entrenado apuntar: sale de la resolución, no del cuerpo.
    getWidgetConfig.mockResolvedValue(configuracion(false));

    await createChat(peticion({ widgetId: WIDGET }), comoRespuesta(respuesta()));

    expect(createChatStream).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: AGENTE }),
    );
  });

  it("La resolución no se pregunta en cada mensaje", async () => {
    getWidgetConfig.mockResolvedValue(configuracion(true));

    await createChat(
      peticion({ widgetId: WIDGET, visitanteId: VISITANTE }),
      comoRespuesta(respuesta()),
    );
    await createChat(
      peticion({ widgetId: WIDGET, visitanteId: VISITANTE }),
      comoRespuesta(respuesta()),
    );

    expect(getWidgetConfig).toHaveBeenCalledTimes(1);
    expect(atenderMensajeDelWidget).toHaveBeenCalledTimes(2);
  });
});


// ── SPEC-195 · segunda vuelta ───────────────────────────────────────────────

describe("SPEC-195 · el origen y el ámbito, con las dos rutas ya abiertas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limpiarCacheDeConfiguracionDeWidget();
    createChatStream.mockResolvedValue(respuestaDeAgents());
    atenderMensajeDelWidget.mockResolvedValue(respuestaDeLeads());
    getWidgetConfig.mockResolvedValue(configuracion(false));
  });

  it("Se apunta desde dónde se cargó", async () => {
    await createChat(
      peticion({ widgetId: WIDGET }, { origin: "https://tienda.example" }),
      comoRespuesta(respuesta()),
    );

    expect(apuntarOrigen).toHaveBeenCalledWith(
      WIDGET,
      "https://tienda.example",
      expect.anything(),
    );
  });

  it("se apunta contra el widget resuelto, no contra lo que vino en el cuerpo", async () => {
    // Un fragmento antiguo manda el agente; lo observado cuelga del widget.
    getWidgetConfig.mockResolvedValue(configuracion(false, null, { widgetId: "w-resuelto" }));

    await createChat(
      peticion({ agentId: AGENTE }, { origin: "https://tienda.example" }),
      comoRespuesta(respuesta()),
    );

    expect(apuntarOrigen).toHaveBeenCalledWith(
      "w-resuelto",
      "https://tienda.example",
      expect.anything(),
    );
  });

  it("Una petición sin origen se atiende igual", async () => {
    const res = respuesta();

    await createChat(peticion({ widgetId: WIDGET }), comoRespuesta(res));

    await expect(res.cuerpo()).resolves.toBe("respuesta del agente");
  });

  it("no se apunta lo que no se ha podido resolver", async () => {
    // Sin widget al que colgarlo no hay nada que apuntar.
    getWidgetConfig.mockResolvedValue(noResuelve());

    await createChat(
      peticion({ widgetId: "inventado" }, { origin: "https://tienda.example" }),
      comoRespuesta(respuesta()),
    );

    expect(apuntarOrigen).not.toHaveBeenCalled();
  });

  it("un widget apagado se sigue apuntando", async () => {
    // Es justo la señal que interesa: el fragmento sigue pegado en esa página
    // aunque el tenant lo haya apagado (ADR-038).
    getWidgetConfig.mockResolvedValue(configuracion(false, null, { active: false }));

    await createChat(
      peticion({ widgetId: WIDGET }, { origin: "https://tienda.example" }),
      comoRespuesta(respuesta()),
    );

    expect(apuntarOrigen).toHaveBeenCalled();
  });

  it("El token de organización ya no hace falta", async () => {
    // Con `widgetId` no viene ninguno, y se atiende igual: la organización sale
    // de resolver el widget (SPEC-203).
    const res = respuesta();

    await createChat(
      peticionSinToken({ widgetId: WIDGET, message: "hola" }),
      comoRespuesta(res),
    );

    expect(createChatStream).toHaveBeenCalledWith(
      expect.objectContaining({ organizacionId: ORGANIZACION }),
    );
    await expect(res.cuerpo()).resolves.toBe("respuesta del agente");
  });

  it("y no se manda además el token: las dos señales juntas se rechazan", async () => {
    // SPEC-203: la discrepancia devolvía 200 y se ignoraba en silencio; ahora
    // se rechaza. Con el widget resuelto, la organización es la buena.
    await createChat(peticion({ widgetId: WIDGET }), comoRespuesta(respuesta()));

    const [params] = createChatStream.mock.calls[0] as [Record<string, unknown>];
    expect(params.organizacionId).toBe(ORGANIZACION);
    expect(params.uniqueToken).toBeUndefined();
  });

  it("un fragmento sin identificador ninguno sigue yendo por el token", async () => {
    await createChat(peticion({}), comoRespuesta(respuesta()));

    const [params] = createChatStream.mock.calls[0] as [Record<string, unknown>];
    expect(params.uniqueToken).toBe("token-de-organizacion");
    expect(params.organizacionId).toBeUndefined();
  });

  it("sin token y sin nada que resolver no se puede atender", async () => {
    const res = respuesta();

    await createChat(peticionSinToken({ message: "hola" }), comoRespuesta(res));

    expect(res.codigo).toBe(401);
    expect(createChatStream).not.toHaveBeenCalled();
  });

  it("si no se pudo resolver el widget, se atiende con el token que vino", async () => {
    // La regla de SPEC-167 otra vez: un tropiezo no deja mudo a nadie, y para
    // eso hace falta el token que el fragmento todavía manda.
    getWidgetConfig.mockResolvedValue({
      success: false,
      statusCode: 503,
      duration: 1,
      error: { code: "CONNECTION_ERROR", message: "no hay nadie", service: "ms-agents" },
    });
    const res = respuesta();

    await createChat(peticion({ widgetId: WIDGET }), comoRespuesta(res));

    const [params] = createChatStream.mock.calls[0] as [Record<string, unknown>];
    expect(params.uniqueToken).toBe("token-de-organizacion");
    await expect(res.cuerpo()).resolves.toBe("respuesta del agente");
  });
});

describe("SPEC-196 · atender sólo desde lo registrado", () => {
  /** La frase que lee quien conversa cuando el dominio no está autorizado. */
  const NO_AUTORIZADO = "Este dominio no está autorizado para usar este asistente.";

  /** El antecedente del Gherkin: bloqueo encendido y "pepito.com" registrado. */
  function conBloqueo(extra: Record<string, unknown> = {}) {
    return configuracion(false, null, {
      domainBlockingEnabled: true,
      allowedDomains: ["pepito.com"],
      ...extra,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    limpiarCacheDeConfiguracionDeWidget();
    createChatStream.mockResolvedValue(respuestaDeAgents());
    atenderMensajeDelWidget.mockResolvedValue(respuestaDeLeads());
    getWidgetConfig.mockResolvedValue(conBloqueo());
  });

  it("Desde el dominio registrado se atiende", async () => {
    const res = respuesta();

    await createChat(
      peticion({ widgetId: WIDGET }, { origin: "https://pepito.com" }),
      comoRespuesta(res),
    );

    expect(createChatStream).toHaveBeenCalledTimes(1);
    await expect(res.cuerpo()).resolves.toBe("respuesta del agente");
  });

  it("Desde otro dominio se contesta que no está autorizado, y NO se llama al modelo", async () => {
    const res = respuesta();

    await createChat(
      peticion({ widgetId: WIDGET }, { origin: "https://raul.com" }),
      comoRespuesta(res),
    );

    expect(res.codigo).toBe(403);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: NO_AUTORIZADO });
    expect(createChatStream).not.toHaveBeenCalled();
    expect(atenderMensajeDelWidget).not.toHaveBeenCalled();
  });

  it("Y se responde con normalidad, no con un error que la página no pueda leer", async () => {
    // Si se cortara por CORS el navegador no dejaría leer la respuesta y el
    // visitante vería un widget roto en vez del mensaje. Lo que llega es una
    // respuesta corriente, con la misma forma que el widget ya sabe leer.
    const res = respuesta();

    await createChat(
      peticion({ widgetId: WIDGET }, { origin: "https://raul.com" }),
      comoRespuesta(res),
    );

    await expect(res.cuerpo()).resolves.toBe(
      JSON.stringify({ success: false, message: NO_AUTORIZADO }),
    );
  });

  it("Con el bloqueo apagado se atiende desde cualquier sitio", async () => {
    getWidgetConfig.mockResolvedValue(conBloqueo({ domainBlockingEnabled: false }));
    const res = respuesta();

    await createChat(
      peticion({ widgetId: WIDGET }, { origin: "https://raul.com" }),
      comoRespuesta(res),
    );

    expect(createChatStream).toHaveBeenCalledTimes(1);
    await expect(res.cuerpo()).resolves.toBe("respuesta del agente");
  });

  it("Sin dominios registrados no se bloquea nada", async () => {
    // Si no, crear un widget lo dejaría muerto hasta que alguien se acordara.
    getWidgetConfig.mockResolvedValue(conBloqueo({ allowedDomains: [] }));
    const res = respuesta();

    await createChat(
      peticion({ widgetId: WIDGET }, { origin: "https://donde-sea.example" }),
      comoRespuesta(res),
    );

    expect(createChatStream).toHaveBeenCalledTimes(1);
    await expect(res.cuerpo()).resolves.toBe("respuesta del agente");
  });

  it("Una petición sin origen no se atiende", async () => {
    // Un navegador siempre lo manda en esta llamada, así que su ausencia
    // significa que quien llama no es una página.
    const res = respuesta();

    await createChat(peticion({ widgetId: WIDGET }), comoRespuesta(res));

    expect(res.codigo).toBe(403);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: NO_AUTORIZADO });
    expect(createChatStream).not.toHaveBeenCalled();
  });

  it("un `Origin: null` cuenta como sin origen", async () => {
    // Un iframe con arenero o un fichero local: no es un dominio llamado null.
    const res = respuesta();

    await createChat(
      peticion({ widgetId: WIDGET }, { origin: "null" }),
      comoRespuesta(res),
    );

    expect(res.codigo).toBe(403);
    expect(createChatStream).not.toHaveBeenCalled();
  });

  it("El intento queda apuntado", async () => {
    // Saber desde dónde te intentan cargar es justo lo que el tenant necesita
    // ver (ADR-038), así que apuntar ocurre igual aunque se bloquee.
    await createChat(
      peticion({ widgetId: WIDGET }, { origin: "https://raul.com" }),
      comoRespuesta(respuesta()),
    );

    expect(apuntarOrigen).toHaveBeenCalledWith(WIDGET, "https://raul.com", expect.anything());
  });

  it("Un dominio bloqueado no gasta cuota del tenant", async () => {
    // El tope diario lo aplica ms-agents sobre las llamadas que le llegan con
    // `x-channel: widget`; ms-leads cuenta las suyas. No llamar a ninguno es lo
    // que hace que esto no cueste ni modelo ni cuota, que es el motivo entero
    // de la medida.
    await createChat(
      peticion({ widgetId: WIDGET }, { origin: "https://raul.com" }),
      comoRespuesta(respuesta()),
    );

    expect(createChatStream).not.toHaveBeenCalled();
    expect(atenderMensajeDelWidget).not.toHaveBeenCalled();
  });

  it("se decide antes de las dos puertas, también con leads encendido", async () => {
    getWidgetConfig.mockResolvedValue(conBloqueo({ leadsEnabled: true }));
    const res = respuesta();

    await createChat(
      peticion({ widgetId: WIDGET, visitanteId: VISITANTE }, { origin: "https://raul.com" }),
      comoRespuesta(res),
    );

    expect(res.codigo).toBe(403);
    expect(atenderMensajeDelWidget).not.toHaveBeenCalled();
    expect(createChatStream).not.toHaveBeenCalled();
  });

  it("un subdominio no registrado no cuela", async () => {
    // ADR-038 dejó los comodines de subdominio sin decidir; aquí no se inventan.
    const res = respuesta();

    await createChat(
      peticion({ widgetId: WIDGET }, { origin: "https://tienda.pepito.com" }),
      comoRespuesta(res),
    );

    expect(res.codigo).toBe(403);
  });

  it("un puerto y un esquema distintos siguen siendo el mismo sitio", async () => {
    // Es la costura con ms-agents: allá se guardó `pepito.com` y el navegador
    // manda esto. Si las dos normalizaciones se separan, el tenant se queda
    // fuera de su propia web.
    const res = respuesta();

    await createChat(
      peticion({ widgetId: WIDGET }, { origin: "http://Pepito.com:8443" }),
      comoRespuesta(res),
    );

    expect(createChatStream).toHaveBeenCalledTimes(1);
    await expect(res.cuerpo()).resolves.toBe("respuesta del agente");
  });

  it("la frase no repite el dominio que vino", async () => {
    // Se pinta en una página que no controlamos y el `Origin` lo pone quien
    // llama: devolverlo sería reflejar en el widget lo que alguien mandó.
    const res = respuesta();

    await createChat(
      peticion({ widgetId: WIDGET }, { origin: "https://<img src=x>.example" }),
      comoRespuesta(res),
    );

    expect(res.codigo).toBe(403);
    const [cuerpo] = res.json.mock.calls[0] as [{ message: string }];
    expect(cuerpo.message).toBe(NO_AUTORIZADO);
  });

  it("lo que no se ha podido resolver no se bloquea", async () => {
    // La regla de SPEC-167 no cambia: un tropiezo de ms-agents no puede dejar
    // mudo un widget sano, y sin resolver no hay lista contra la que comparar.
    getWidgetConfig.mockResolvedValue({
      success: false,
      statusCode: 503,
      duration: 1,
      error: { code: "CONNECTION_ERROR", message: "no hay nadie", service: "ms-agents" },
    });
    const res = respuesta();

    await createChat(
      peticion({ widgetId: WIDGET }, { origin: "https://raul.com" }),
      comoRespuesta(res),
    );

    expect(createChatStream).toHaveBeenCalledTimes(1);
    await expect(res.cuerpo()).resolves.toBe("respuesta del agente");
  });
});

describe("SPEC-221 · decir de quién es cada mensaje", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limpiarCacheDeConfiguracionDeWidget();
    createChatStream.mockResolvedValue(respuestaDeAgents());
    getWidgetConfig.mockResolvedValue(configuracion(false));
    atenderMensajeDelWidget.mockResolvedValue(respuestaDeLeads());
  });

  it("Se manda el widget resuelto", async () => {
    await createChat(
      peticionSinToken({ widgetId: WIDGET, visitanteId: VISITANTE }),
      comoRespuesta(respuesta()),
    );

    expect(createChatStream).toHaveBeenCalledWith(
      expect.objectContaining({ widgetId: WIDGET }),
    );
  });

  it("Y quién lo escribe", async () => {
    await createChat(
      peticionSinToken({ widgetId: WIDGET, visitanteId: VISITANTE }),
      comoRespuesta(respuesta()),
    );

    expect(createChatStream).toHaveBeenCalledWith(
      expect.objectContaining({ visitanteId: VISITANTE }),
    );
  });

  it("Sin identificador de visitante se atiende igual", async () => {
    // **Y no se inventa ninguno.** Un identificador por defecto convertiría a
    // todos los visitantes desconocidos en el mismo, que es justo el defecto
    // que esto viene a corregir. Y una cadena vacía sería un 400 de ms-agents
    // (SPEC-220), o sea, dejar mudo un widget sano por un dato que sobra.
    const res = respuesta();

    await createChat(peticionSinToken({ widgetId: WIDGET }), comoRespuesta(res));

    expect(createChatStream).toHaveBeenCalledTimes(1);
    const [params] = createChatStream.mock.calls[0] as [Record<string, unknown>];
    expect(params.visitanteId).toBeUndefined();
    await expect(res.cuerpo()).resolves.toBe("respuesta del agente");
  });

  it("Un visitante de sólo espacios no es un visitante", async () => {
    await createChat(
      peticionSinToken({ widgetId: WIDGET, visitanteId: "   " }),
      comoRespuesta(respuesta()),
    );

    const [params] = createChatStream.mock.calls[0] as [Record<string, unknown>];
    expect(params.visitanteId).toBeUndefined();
  });

  it("Un fragmento que no resuelve no atribuye", async () => {
    // SPEC-167 sigue mandando: un tropiezo de ms-agents no deja mudo el chat.
    // Lo que no se puede es atribuirle un widget que no hemos resuelto.
    getWidgetConfig.mockResolvedValue({
      success: false,
      statusCode: 503,
      duration: 1,
      error: { code: "CONNECTION_ERROR", message: "no hay nadie", service: "ms-agents" },
    });
    const res = respuesta();

    await createChat(
      peticion({ widgetId: WIDGET, visitanteId: VISITANTE }),
      comoRespuesta(res),
    );

    expect(createChatStream).toHaveBeenCalledTimes(1);
    const [params] = createChatStream.mock.calls[0] as [Record<string, unknown>];
    expect(params.widgetId).toBeUndefined();
    await expect(res.cuerpo()).resolves.toBe("respuesta del agente");
  });

  it("Sin nada que resolver tampoco se atribuye, pero sí se dice quién escribe", async () => {
    // El fragmento más antiguo de todos: sólo el token de organización. No hay
    // widget que decir, y el visitante sí se sabe.
    const res = respuesta();

    await createChat(peticion({ visitanteId: VISITANTE }), comoRespuesta(res));

    expect(getWidgetConfig).not.toHaveBeenCalled();
    const [params] = createChatStream.mock.calls[0] as [Record<string, unknown>];
    expect(params.widgetId).toBeUndefined();
    expect(params.visitanteId).toBe(VISITANTE);
  });

  it("Un fragmento antiguo atribuye al widget resuelto y NO al agente que mandó", async () => {
    // Lo que llega en el cuerpo es el identificador del AGENTE, y ms-agents
    // resuelve su widget por defecto. Guardar lo que vino en vez de lo
    // resuelto metería un identificador de agente en la columna del widget:
    // la auditoría de ese widget saldría vacía para siempre.
    await createChat(
      peticion({ agentId: AGENTE, visitanteId: VISITANTE }),
      comoRespuesta(respuesta()),
    );

    const [params] = createChatStream.mock.calls[0] as [Record<string, unknown>];
    expect(params.widgetId).toBe(WIDGET);
    expect(params.widgetId).not.toBe(AGENTE);
  });

  it("El camino de leads también lo dice", async () => {
    // Si sólo atribuyera el camino del agente, encender la clasificación de
    // leads volvería un widget MENOS auditable que uno sin ella.
    getWidgetConfig.mockResolvedValue(configuracion(true));

    await createChat(
      peticionSinToken({ widgetId: WIDGET, visitanteId: VISITANTE }),
      comoRespuesta(respuesta()),
    );

    expect(createChatStream).not.toHaveBeenCalled();
    expect(atenderMensajeDelWidget).toHaveBeenCalledWith(
      expect.objectContaining({ widgetId: WIDGET, visitanteId: VISITANTE }),
      expect.anything(),
    );
  });

  it("Un widget con leads encendido pero sin visitante atribuye igual por el agente", async () => {
    // Se cae al camino de ms-agents (SPEC-167), y eso no puede costar la
    // atribución: el widget se sabe igual.
    getWidgetConfig.mockResolvedValue(configuracion(true));

    await createChat(peticionSinToken({ widgetId: WIDGET }), comoRespuesta(respuesta()));

    expect(createChatStream).toHaveBeenCalledWith(
      expect.objectContaining({ widgetId: WIDGET }),
    );
  });

  it("Nada de esto cambia lo que ve quien conversa", async () => {
    const res = respuesta();

    await createChat(
      peticionSinToken({ widgetId: WIDGET, visitanteId: VISITANTE }),
      comoRespuesta(res),
    );

    expect(res.cabeceras["Content-Type"]).toBe("text/plain; charset=utf-8");
    expect(res.cabeceras["Chat-Session-Id"]).toBe("sesion-1");
    await expect(res.cuerpo()).resolves.toBe("respuesta del agente");
  });
});

/**
 * SPEC-227 — el borde declara el widget desconocido cuando no puede resolverlo.
 *
 * Este borde es **el único que tiene las dos mitades de la frase**: sabe que la
 * petición entró por la puerta del widget, y sabe que no ha podido resolver
 * cuál. Callarse la segunda mitad no deja la conversación sin widget: la deja
 * afirmando que no vino de ninguno, que es una afirmación falsa y que la borra
 * de la auditoría del widget que sí la atendió.
 *
 * Lo que se comprueba aquí es **la decisión**: qué se le pasa al cliente de
 * ms-agents. Cómo se traduce eso al cable (`widgetUnknown`) se prueba en
 * `agents-service.client.test.ts`, que es donde vive ese contrato.
 */
describe("SPEC-227 · declarar el widget desconocido", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limpiarCacheDeConfiguracionDeWidget();
    createChatStream.mockResolvedValue(respuestaDeAgents());
    getWidgetConfig.mockResolvedValue(configuracion(false));
    atenderMensajeDelWidget.mockResolvedValue(respuestaDeLeads());
  });

  /** Lo que se le pasó al camino de ms-agents en la llamada número `n`. */
  function loQueSeMando(n = 0): Record<string, unknown> {
    const [params] = createChatStream.mock.calls[n] as [Record<string, unknown>];
    return params;
  }

  it("Si resolver tropieza, se declara desconocido", async () => {
    // El servicio de configuración no contesta. Esto ya se atendía igual
    // (SPEC-167: un tropiezo no puede dejar mudo el chat de un cliente), y ahí
    // estaba el defecto: se atendía **afirmando que no vino de ningún widget**.
    // Un tropiezo de un segundo en un servicio nuestro no puede reescribir de
    // dónde vino la conversación de un cliente.
    getWidgetConfig.mockResolvedValue({
      success: false,
      statusCode: 503,
      duration: 1,
      error: { code: "CONNECTION_ERROR", message: "no hay nadie", service: "ms-agents" },
    });
    const res = respuesta();

    await createChat(peticion({ widgetId: WIDGET }), comoRespuesta(res));

    expect(loQueSeMando().widgetDesconocido).toBe(true);
    // Y se sigue atendiendo, que es la mitad que ya funcionaba.
    expect(createChatStream).toHaveBeenCalledTimes(1);
    await expect(res.cuerpo()).resolves.toBe("respuesta del agente");
  });

  it("Si resolver tropieza, se declara desconocido — también cuando la consulta revienta", async () => {
    // El mismo escenario por el otro camino: no un 5xx, sino una excepción
    // —tiempo de espera agotado, DNS, conexión cortada—. Los dos acaban en
    // `no-se-sabe` (SPEC-195) y los dos entraron por la puerta del widget, así
    // que los dos se declaran. Si sólo se cubriera uno, el día que el fallo
    // llegue por el otro volvemos a afirmar «ninguno».
    getWidgetConfig.mockRejectedValue(new Error("se agotó la espera"));
    const res = respuesta();

    await createChat(peticion({ widgetId: WIDGET }), comoRespuesta(res));

    expect(loQueSeMando().widgetDesconocido).toBe(true);
    await expect(res.cuerpo()).resolves.toBe("respuesta del agente");
  });

  it("Un fragmento antiguo también", async () => {
    // Sólo el token de organización: ni widget ni agente, así que no hay nada
    // que resolver y no se pregunta. **Pero vino por la puerta del widget
    // igual**, y eso es justo lo que sólo este borde sabe. «No he podido
    // resolverlo» y «no vino de ningún widget» no son la misma frase.
    const res = respuesta();

    await createChat(peticion({ visitanteId: VISITANTE }), comoRespuesta(res));

    expect(getWidgetConfig).not.toHaveBeenCalled();
    expect(loQueSeMando().widgetDesconocido).toBe(true);
    expect(loQueSeMando().widgetId).toBeUndefined();
    await expect(res.cuerpo()).resolves.toBe("respuesta del agente");
  });

  it("Resuelto, se dice cuál", async () => {
    // Cuando se sabe, se dice el identificador y **no se declara nada**:
    // declarar aquí sería mentir en el otro sentido, y además lo rechazaría el
    // otro lado. Se comprueba «no es `true`» y no «no está»: ausente y `false`
    // significan lo mismo del otro lado (SPEC-226), así que exigir cuál de los
    // dos se manda ataría la implementación sin proteger nada.
    await createChat(
      peticionSinToken({ widgetId: WIDGET, visitanteId: VISITANTE }),
      comoRespuesta(respuesta()),
    );

    expect(loQueSeMando().widgetId).toBe(WIDGET);
    expect(loQueSeMando().widgetDesconocido).not.toBe(true);
  });

  it("Nunca las dos cosas a la vez", async () => {
    // El otro lado responde **400** a un cuerpo que trae el identificador y la
    // declaración juntos (SPEC-226), y con razón: es una contradicción. Pero un
    // 400 aquí deja sin respuesta a quien está conversando con un widget sano,
    // así que la exclusión se garantiza desde este lado y no se confía en que
    // el de allá perdone.
    //
    // Se miran los dos desenlaces en la misma prueba porque lo que se afirma es
    // sobre los dos a la vez: **exactamente una** de las dos señales, nunca las
    // dos y nunca ninguna, cuando se entró por la puerta del widget.
    await createChat(peticionSinToken({ widgetId: WIDGET }), comoRespuesta(respuesta()));

    // Y el mismo widget sin poder resolverse. Se vacía lo recordado: si no, la
    // segunda llamada se contestaría con lo que resolvió la primera y esta
    // prueba estaría mirando dos veces el mismo desenlace.
    limpiarCacheDeConfiguracionDeWidget();
    getWidgetConfig.mockResolvedValue({
      success: false,
      statusCode: 503,
      duration: 1,
      error: { code: "CONNECTION_ERROR", message: "no hay nadie", service: "ms-agents" },
    });
    await createChat(peticionSinToken({ widgetId: WIDGET }), comoRespuesta(respuesta()));

    expect(createChatStream).toHaveBeenCalledTimes(2);
    for (const n of [0, 1]) {
      const params = loQueSeMando(n);
      const dice = params.widgetId !== undefined;
      const declara = params.widgetDesconocido === true;
      expect(dice && declara).toBe(false);
      expect(dice || declara).toBe(true);
    }
  });

  it("Un widget que no existe no declara nada, porque no hay conversación", async () => {
    // `no-existe` no es `no-se-sabe` (SPEC-195): aquí sí lo sabemos, y lo que
    // sabemos es que ese identificador no es de nadie. Se contesta 404 y no se
    // abre conversación ninguna, así que no hay nada de lo que declarar el
    // origen. Declarar aquí sería grabar una conversación que no existe.
    getWidgetConfig.mockResolvedValue(noResuelve());
    const res = respuesta();

    await createChat(peticionSinToken({ widgetId: WIDGET }), comoRespuesta(res));

    expect(res.codigo).toBe(404);
    expect(createChatStream).not.toHaveBeenCalled();
  });

  it("Nada de esto cambia lo que ve quien conversa", async () => {
    // Esto es información **sobre** la conversación, no **de** la conversación:
    // quien escribe lee exactamente lo mismo que leía ayer, con las mismas
    // cabeceras. Se prueba sobre el caso que cambia —el que no resuelve—,
    // porque es el único donde algo nuevo viaja.
    getWidgetConfig.mockResolvedValue({
      success: false,
      statusCode: 503,
      duration: 1,
      error: { code: "CONNECTION_ERROR", message: "no hay nadie", service: "ms-agents" },
    });
    const res = respuesta();

    await createChat(
      peticion({ widgetId: WIDGET, visitanteId: VISITANTE }),
      comoRespuesta(res),
    );

    expect(res.cabeceras["Content-Type"]).toBe("text/plain; charset=utf-8");
    expect(res.cabeceras["Chat-Session-Id"]).toBe("sesion-1");
    await expect(res.cuerpo()).resolves.toBe("respuesta del agente");
  });

  it("El camino de leads sigue como estaba y no declara nada", async () => {
    // Está fuera del alcance del SPEC a propósito: por leads sólo se pasa con
    // el widget ya resuelto —sin resolverlo no se sabe siquiera que clasifica
    // leads—, así que ahí nunca hay nada que declarar. Se prueba para que la
    // declaración no se cuele por un camino donde no tiene sentido.
    getWidgetConfig.mockResolvedValue(configuracion(true));

    await createChat(
      peticionSinToken({ widgetId: WIDGET, visitanteId: VISITANTE }),
      comoRespuesta(respuesta()),
    );

    expect(createChatStream).not.toHaveBeenCalled();
    expect(atenderMensajeDelWidget).toHaveBeenCalledWith(
      expect.objectContaining({ widgetId: WIDGET, visitanteId: VISITANTE }),
      expect.anything(),
    );
    const [mensaje] = atenderMensajeDelWidget.mock.calls[0] as [Record<string, unknown>];
    expect(mensaje.widgetDesconocido).toBeUndefined();
  });
});
