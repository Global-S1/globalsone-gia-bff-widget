import { beforeEach, describe, expect, it, vi } from "vitest";

// Antes de cualquier import: `environments.ts` lee el secreto al cargarse, y
// ponerlo en un `beforeEach` llegaría tarde.
vi.hoisted(() => {
  process.env.INTERNAL_SERVICE_TOKEN = "secreto-compartido";
});

const request = vi.fn();
vi.mock("undici", () => ({ request: (...args: unknown[]) => request(...args) }));

import { LeadsServiceClient } from "../leads-service.client";
import type { IRequestContext } from "../../../domain/interfaces/request-context.interface";

/**
 * SPEC-167 — cómo se le habla a la entrada del widget de ms-leads (SPEC-164).
 *
 * Lo que se comprueba aquí es lo que ese servicio EXIGE y rechaza: el token
 * interno, el tenant en la cabecera y en ninguna otra parte, y que un POST que
 * crea un lead no se reintenta.
 */

const contexto: IRequestContext = {
  correlationId: "corr-1",
  timestamp: new Date(),
};

function respuestaJson(statusCode: number, cuerpo: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: { text: async () => JSON.stringify(cuerpo) },
  };
}

describe("LeadsServiceClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function cliente() {
    return new LeadsServiceClient({
      name: "ms-leads",
      baseUrl: "http://ms-leads",
      timeout: 5000,
      retries: 2,
      healthPath: "/health",
    });
  }

  it("manda la organización en x-tenant-id y no en el cuerpo", async () => {
    request.mockResolvedValue(respuestaJson(200, { conversacionId: "c-1", texto: "hola" }));

    await cliente().atenderMensajeDelWidget(
      { organizacionId: "org-1", agenteId: "a-1", visitanteId: "v-1", texto: "hola" },
      contexto,
    );

    const [url, opciones] = request.mock.calls[0] as [string, Record<string, any>];
    expect(url).toBe("http://ms-leads/v1/widget/mensaje");
    expect(opciones.headers["x-tenant-id"]).toBe("org-1");
    expect(opciones.headers["x-internal-service-token"]).toBe("secreto-compartido");
    // La organización es la señal que el llamante no controla: en el cuerpo se
    // ignora, así que mandarla ahí sólo confundiría a quien lea un registro.
    expect(JSON.parse(opciones.body)).toEqual({
      agenteId: "a-1",
      visitanteId: "v-1",
      texto: "hola",
    });
  });

  it("no manda x-user-id: quien escribe no es un usuario del tenant", async () => {
    request.mockResolvedValue(respuestaJson(200, { conversacionId: "c-1", texto: "hola" }));

    await cliente().atenderMensajeDelWidget(
      { organizacionId: "org-1", agenteId: "a-1", visitanteId: "v-1", texto: "hola" },
      { ...contexto, userId: "no-deberia-viajar" },
    );

    const [, opciones] = request.mock.calls[0] as [string, Record<string, any>];
    expect(opciones.headers["X-User-ID"]).toBeUndefined();
    expect(opciones.headers["x-user-id"]).toBeUndefined();
  });

  it("manda la ip cuando la hay y la omite cuando no", async () => {
    request.mockResolvedValue(respuestaJson(200, { conversacionId: "c-1", texto: "hola" }));

    await cliente().atenderMensajeDelWidget(
      { organizacionId: "org-1", agenteId: "a-1", visitanteId: "v-1", texto: "hola", ip: "1.2.3.4" },
      contexto,
    );

    expect(JSON.parse((request.mock.calls[0] as any)[1].body).ip).toBe("1.2.3.4");
  });

  it("no reintenta: un mensaje reintentado es un mensaje duplicado en la conversación", async () => {
    request.mockRejectedValue(new Error("ECONNREFUSED"));

    const salida = await cliente().atenderMensajeDelWidget(
      { organizacionId: "org-1", agenteId: "a-1", visitanteId: "v-1", texto: "hola" },
      contexto,
    );

    expect(request).toHaveBeenCalledTimes(1);
    expect(salida.success).toBe(false);
  });

  it("conserva lo que ms-leads dijo del error, para poder traducirlo", async () => {
    request.mockResolvedValue(
      respuestaJson(502, { error: "No he podido responderte ahora mismo." }),
    );

    const salida = await cliente().atenderMensajeDelWidget(
      { organizacionId: "org-1", agenteId: "a-1", visitanteId: "v-1", texto: "hola" },
      contexto,
    );

    expect(salida.statusCode).toBe(502);
    expect(salida.error?.details).toEqual({ error: "No he podido responderte ahora mismo." });
  });
});
