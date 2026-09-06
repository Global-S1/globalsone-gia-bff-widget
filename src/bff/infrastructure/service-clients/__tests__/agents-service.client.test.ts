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
