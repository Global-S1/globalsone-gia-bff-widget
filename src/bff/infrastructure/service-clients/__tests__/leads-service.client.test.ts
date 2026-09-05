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

/**
 * SPEC-186 · SPEC-187 — resolver la llave con la que sale un fichero.
 *
 * Es **la única ruta de ms-leads que no exige** `**x-tenant-id**`: quien
 * presenta una llave viene justo a preguntar de qué organización es, así que
 * pedirle ese dato sería pedirle lo que viene a buscar. El token interno sí se
 * exige igual que en todas.
 */
describe("LeadsServiceClient · resolver la llave de un fichero", () => {
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

  const LLAVE = "3pQ7x1Kb9vZ2mN4tR8sL0dF6hJ5wY7cA1eG3iU9oP2k";

  it("pregunta por la llave y trae la organización y el documento", async () => {
    request.mockResolvedValue(
      respuestaJson(200, { organizacionId: "org-1", documentoId: "doc-1" }),
    );

    const r = await cliente().resolverLlaveDeFichero(LLAVE, contexto);

    const [url] = request.mock.calls[0] as [string, Record<string, any>];
    expect(url).toBe(`http://ms-leads/v1/widget/fichero/${LLAVE}`);
    expect(r.data).toEqual({ organizacionId: "org-1", documentoId: "doc-1" });
  });

  it("manda el token interno y NO manda x-tenant-id", async () => {
    request.mockResolvedValue(
      respuestaJson(200, { organizacionId: "org-1", documentoId: "doc-1" }),
    );

    await cliente().resolverLlaveDeFichero(LLAVE, contexto);

    const [, opciones] = request.mock.calls[0] as [string, Record<string, any>];
    expect(opciones.headers["x-internal-service-token"]).toBe("secreto-compartido");
    expect(opciones.headers["x-tenant-id"]).toBeUndefined();
  });

  it("escapa la llave en la ruta", async () => {
    request.mockResolvedValue(respuestaJson(404, { error: "Esa llave no existe" }));

    await cliente().resolverLlaveDeFichero("a/b c", contexto);

    const [url] = request.mock.calls[0] as [string, Record<string, any>];
    expect(url).toBe("http://ms-leads/v1/widget/fichero/a%2Fb%20c");
  });

  it("una llave que no existe es un 404, no una excepción", async () => {
    request.mockResolvedValue(respuestaJson(404, { error: "Esa llave no existe" }));

    const r = await cliente().resolverLlaveDeFichero(LLAVE, contexto);

    expect(r.success).toBe(false);
    expect(r.statusCode).toBe(404);
  });
});
