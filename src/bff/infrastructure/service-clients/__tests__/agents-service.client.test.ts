import { beforeEach, describe, expect, it, vi } from "vitest";

// Antes de cualquier import: `environments.ts` lee el secreto al cargarse.
vi.hoisted(() => {
  process.env.INTERNAL_SERVICE_TOKEN = "secreto-compartido";
});

const request = vi.fn();
vi.mock("undici", () => ({ request: (...args: unknown[]) => request(...args) }));

import { AgentsServiceClient } from "../agents-service.client";
import type { IRequestContext } from "../../../domain/interfaces/request-context.interface";

/**
 * SPEC-195 · ADR-037 — cómo se le pregunta a ms-agents por un widget.
 *
 * La ruta cambia de sitio: el widget ya es una entidad, así que se pregunta por
 * `/v1/widgets/:id/config` y no por la del agente. Tiene prueba porque una ruta
 * equivocada aquí no rompe el arranque: se manifiesta como un 404 en cada
 * mensaje, que este BFF trata como «no se puede saber» y disimula cayendo al
 * camino de siempre — es decir, la feature se apaga en silencio.
 */

const contexto: IRequestContext = {
  correlationId: "corr-1",
  timestamp: new Date(),
};

function cliente() {
  return new AgentsServiceClient({
    name: "ms-agents",
    baseUrl: "http://ms-agents",
    timeout: 5000,
    retries: 2,
    healthPath: "/health",
  });
}

function respuestaJson(statusCode: number, cuerpo: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: { text: async () => JSON.stringify(cuerpo) },
  };
}

describe("AgentsServiceClient · la configuración de un widget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    request.mockResolvedValue(
      respuestaJson(200, {
        success: true,
        data: {
          widgetId: "w-1",
          agentId: "a-1",
          organizationId: "org-1",
          active: true,
          leadsEnabled: false,
          contactFormUrl: null,
        },
      }),
    );
  });

  it("pregunta por la ruta del widget, no por la del agente", async () => {
    await cliente().getWidgetConfig("w-1", contexto);

    const [url] = request.mock.calls[0] as [string, Record<string, any>];
    expect(url).toBe("http://ms-agents/v1/widgets/w-1/config");
  });

  it("la misma ruta sirve para un identificador de agente", async () => {
    // ms-agents resuelve `:id` primero como widget y, si no hay, como agente,
    // devolviendo el más antiguo de los suyos. Es lo que sostiene los
    // fragmentos ya pegados en webs de clientes.
    await cliente().getWidgetConfig("a-1", contexto);

    const [url] = request.mock.calls[0] as [string, Record<string, any>];
    expect(url).toBe("http://ms-agents/v1/widgets/a-1/config");
  });

  it("va con el token interno de servicio: es una ruta de la casa", async () => {
    await cliente().getWidgetConfig("w-1", contexto);

    const [, opciones] = request.mock.calls[0] as [string, Record<string, any>];
    expect(opciones.headers["x-internal-service-token"]).toBe("secreto-compartido");
  });

  it("escapa el identificador en la ruta", async () => {
    await cliente().getWidgetConfig("a/b", contexto);

    const [url] = request.mock.calls[0] as [string, Record<string, any>];
    expect(url).toBe("http://ms-agents/v1/widgets/a%2Fb/config");
  });

  it("trae el widget, su agente, su organización y si está activo", async () => {
    const r = await cliente().getWidgetConfig("w-1", contexto);

    expect(r.data).toEqual({
      widgetId: "w-1",
      agentId: "a-1",
      organizationId: "org-1",
      active: true,
      leadsEnabled: false,
      contactFormUrl: null,
    });
  });

  it("un identificador que no resuelve es un 404, no una excepción", async () => {
    request.mockResolvedValue(
      respuestaJson(404, {
        success: false,
        kindMessage: "No existe ningún widget con ese identificador ni el de su agente",
      }),
    );

    const r = await cliente().getWidgetConfig("no-existe", contexto);

    expect(r.success).toBe(false);
    expect(r.statusCode).toBe(404);
  });
});

describe("AgentsServiceClient · apuntar lo observado (SPEC-202)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    request.mockResolvedValue(respuestaJson(200, { success: true, data: { anotado: true } }));
  });

  it("apunta contra la ruta del widget", async () => {
    await cliente().apuntarVisto("w-1", "tienda.example", contexto);

    const [url, opciones] = request.mock.calls[0] as [string, Record<string, any>];
    expect(url).toBe("http://ms-agents/v1/widgets/w-1/visto");
    expect(opciones.method).toBe("POST");
    expect(JSON.parse(opciones.body)).toEqual({ origin: "tienda.example" });
  });

  it("va con el token interno de servicio", async () => {
    await cliente().apuntarVisto("w-1", "tienda.example", contexto);

    const [, opciones] = request.mock.calls[0] as [string, Record<string, any>];
    expect(opciones.headers["x-internal-service-token"]).toBe("secreto-compartido");
  });

  it("trae si escribió o si lo frenó", async () => {
    request.mockResolvedValue(respuestaJson(200, { success: true, data: { anotado: false } }));

    const r = await cliente().apuntarVisto("w-1", "tienda.example", contexto);

    expect(r.data).toEqual({ anotado: false });
  });

  it("no se reintenta: es una observación, no una respuesta que alguien espera", async () => {
    request.mockRejectedValue(new Error("boom"));

    await cliente().apuntarVisto("w-1", "tienda.example", contexto);

    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("AgentsServiceClient · el ámbito del chat (SPEC-203)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    request.mockResolvedValue({ statusCode: 200, headers: {}, body: {} });
  });

  it("con organización manda x-tenant-id y NO el token", async () => {
    // SPEC-203: el canal del widget ya admite la organización, que es la regla
    // de la casa. Mandar las dos señales cuando pueden discrepar es lo que
    // ahora se rechaza, así que se manda una.
    await cliente().createChatStream({
      message: "hola",
      organizacionId: "org-1",
      agentId: "a-1",
    });

    const [, opciones] = request.mock.calls[0] as [string, Record<string, any>];
    expect(opciones.headers["x-tenant-id"]).toBe("org-1");
    expect(opciones.headers["x-unique-token"]).toBeUndefined();
  });

  it("sin organización sigue mandando el token, como hasta hoy", async () => {
    await cliente().createChatStream({
      message: "hola",
      uniqueToken: "token-de-organizacion",
      agentId: "a-1",
    });

    const [, opciones] = request.mock.calls[0] as [string, Record<string, any>];
    expect(opciones.headers["x-unique-token"]).toBe("token-de-organizacion");
    expect(opciones.headers["x-tenant-id"]).toBeUndefined();
  });

  it("el canal se declara igual por las dos vías", async () => {
    await cliente().createChatStream({ message: "hola", organizacionId: "org-1" });

    const [, opciones] = request.mock.calls[0] as [string, Record<string, any>];
    expect(opciones.headers["x-channel"]).toBe("widget");
    expect(opciones.headers["x-internal-service-token"]).toBe("secreto-compartido");
  });
});

/**
 * SPEC-221 · SPEC-220 — de qué widget viene y quién escribe, en el cuerpo.
 *
 * Van **en el cuerpo y no en una cabecera**: es donde ms-agents los declara en
 * su validador, compartido por la ruta corriente y la de respuesta
 * estructurada. Lo que ese validador no conoce lo descarta en silencio, así que
 * un nombre equivocado aquí no da error en ningún sitio: se traduce en una
 * columna vacía para siempre y una auditoría que siempre sale en blanco.
 */
describe("AgentsServiceClient · quién escribe y por qué widget (SPEC-221)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    request.mockResolvedValue({ statusCode: 200, headers: {}, body: {} });
  });

  function cuerpoDeLaLlamada(): Record<string, unknown> {
    const [, opciones] = request.mock.calls[0] as [string, Record<string, any>];
    return JSON.parse(opciones.body as string) as Record<string, unknown>;
  }

  it("manda el widget en el cuerpo", async () => {
    await cliente().createChatStream({
      message: "hola",
      organizacionId: "org-1",
      agentId: "a-1",
      widgetId: "w-1",
    });

    expect(cuerpoDeLaLlamada().widgetId).toBe("w-1");
  });

  it("manda el visitante como `visitorId`, que es como lo llama ms-agents", async () => {
    // Aquí dentro se llama `visitanteId` —es el nombre con el que el widget lo
    // manda y con el que ms-leads lo espera (SPEC-181)—, y en el cable de
    // ms-agents es `visitorId`. La traducción vive en el borde con ese
    // servicio, que es donde está su contrato.
    await cliente().createChatStream({
      message: "hola",
      organizacionId: "org-1",
      agentId: "a-1",
      visitanteId: "v-abc",
    });

    const cuerpo = cuerpoDeLaLlamada();
    expect(cuerpo.visitorId).toBe("v-abc");
    expect(cuerpo.visitanteId).toBeUndefined();
  });

  it("lo que no se sabe no se manda: ni vacío ni nulo", async () => {
    // ms-agents responde **400** a un `widgetId` o un `visitorId` vacío
    // (SPEC-220), y un 400 aquí deja sin respuesta a quien escribe. Ausente es
    // «no lo sé»; vacío es una avería.
    await cliente().createChatStream({
      message: "hola",
      organizacionId: "org-1",
      agentId: "a-1",
    });

    const cuerpo = cuerpoDeLaLlamada();
    expect("widgetId" in cuerpo).toBe(false);
    expect("visitorId" in cuerpo).toBe(false);
  });

  it("un identificador de sólo espacios no se manda", async () => {
    await cliente().createChatStream({
      message: "hola",
      organizacionId: "org-1",
      agentId: "a-1",
      widgetId: "   ",
      visitanteId: "  ",
    });

    const cuerpo = cuerpoDeLaLlamada();
    expect("widgetId" in cuerpo).toBe(false);
    expect("visitorId" in cuerpo).toBe(false);
  });

  it("viajan también al continuar una conversación", async () => {
    // ms-agents marca las columnas **al nacer** y no las reescribe, así que
    // mandarlas siempre no cambia nada de lo ya guardado; y no mandarlas en el
    // segundo turno obligaría a este borde a saber cuál es el primero.
    await cliente().createChatStream({
      message: "hola",
      organizacionId: "org-1",
      chatPerUserId: "sesion-1",
      widgetId: "w-1",
      visitanteId: "v-abc",
    });

    const cuerpo = cuerpoDeLaLlamada();
    expect(cuerpo.chatPerUserId).toBe("sesion-1");
    expect(cuerpo.widgetId).toBe("w-1");
    expect(cuerpo.visitorId).toBe("v-abc");
  });

  it("la identidad de usuario sigue siendo el agente", async () => {
    // **No se toca `x-user-id`**, aunque sea lo que hace que todas las
    // conversaciones de un widget parezcan la misma persona: de esa cabecera
    // cuelgan el guard de canal anónimo y la atribución de cuota de ms-agents.
    // Quién escribió se dice por el cuerpo, que es donde SPEC-220 lo pide.
    await cliente().createChatStream({
      message: "hola",
      organizacionId: "org-1",
      agentId: "a-1",
      visitanteId: "v-abc",
    });

    const [, opciones] = request.mock.calls[0] as [string, Record<string, any>];
    expect(opciones.headers["x-user-id"]).toBe("a-1");
  });
});
