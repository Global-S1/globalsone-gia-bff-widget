import { beforeEach, describe, expect, it, vi } from "vitest";

// Antes de cualquier import: `environments.ts` lee el secreto al cargarse, y
// ponerlo en un `beforeEach` llegaría tarde.
vi.hoisted(() => {
  process.env.INTERNAL_SERVICE_TOKEN = "secreto-compartido";
});

const request = vi.fn();
vi.mock("undici", () => ({ request: (...args: unknown[]) => request(...args) }));

import { DocumentsServiceClient } from "../documents-service.client";
import type { IRequestContext } from "../../../domain/interfaces/request-context.interface";

/**
 * SPEC-187 · ADR-026 — cómo se le piden los bytes a ms-documents.
 *
 * Lo que se comprueba aquí es lo que ese servicio EXIGE, que no es lo que
 * exige el resto de la casa: **la cabecera del token se llama distinto**. Es
 * una trampa con historia —mandar el nombre de la casa daba un 401 en cada
 * entrega— y por eso tiene su propia prueba y no sólo un comentario.
 */

const contexto: IRequestContext = {
  correlationId: "corr-1",
  timestamp: new Date(),
};

function cliente() {
  return new DocumentsServiceClient({
    name: "ms-documents",
    baseUrl: "http://ms-documents",
    timeout: 5000,
    retries: 2,
    healthPath: "/health",
  });
}

describe("DocumentsServiceClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    request.mockResolvedValue({ statusCode: 200, headers: {}, body: {} });
  });

  it("pide el fichero del recurso por su documento", async () => {
    await cliente().obtenerFichero(
      { organizacionId: "org-1", documentoId: "doc-1" },
      contexto,
    );

    const [url] = request.mock.calls[0] as [string, Record<string, any>];
    expect(url).toBe("http://ms-documents/v1/agent-resources/doc-1/file");
  });

  it("manda `x-internal-token`, SIN «service», que es el que exige ms-documents", async () => {
    await cliente().obtenerFichero(
      { organizacionId: "org-1", documentoId: "doc-1" },
      contexto,
    );

    const [, opciones] = request.mock.calls[0] as [string, Record<string, any>];
    expect(opciones.headers["x-internal-token"]).toBe("secreto-compartido");
    // Y no el de la casa: ms-documents no lo mira, y mandarlo solo da un 401.
    expect(opciones.headers["x-internal-service-token"]).toBeUndefined();
  });

  it("manda la organización que dijo la llave, en la cabecera de tenant", async () => {
    // Es lo que hace que la cadena no tenga fuga: ms-documents responde según
    // la organización que recibe, no según lo que le pidan.
    await cliente().obtenerFichero(
      { organizacionId: "org-1", documentoId: "doc-1" },
      contexto,
    );

    const [, opciones] = request.mock.calls[0] as [string, Record<string, any>];
    expect(opciones.headers["x-tenant-id"]).toBe("org-1");
  });

  it("escapa el identificador del documento en la ruta", async () => {
    await cliente().obtenerFichero(
      { organizacionId: "org-1", documentoId: "doc/1?x=2" },
      contexto,
    );

    const [url] = request.mock.calls[0] as [string, Record<string, any>];
    expect(url).toBe("http://ms-documents/v1/agent-resources/doc%2F1%3Fx%3D2/file");
  });

  it("no consume el cuerpo: lo devuelve para servirlo según llega", async () => {
    // Un fichero puede pesar; bufferizarlo entero aquí lo mete en memoria del
    // BFF para nada, porque de aquí va directo al navegador.
    const cuerpo = { pipe: () => undefined };
    request.mockResolvedValue({ statusCode: 200, headers: {}, body: cuerpo });

    const respuesta = await cliente().obtenerFichero(
      { organizacionId: "org-1", documentoId: "doc-1" },
      contexto,
    );

    expect(respuesta.body).toBe(cuerpo);
  });
});
