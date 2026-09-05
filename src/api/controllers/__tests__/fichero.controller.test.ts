// Importados explícitamente, no por `globals: true`: el tsconfig de este repo
// restringe typeRoots, así que "vitest/globals" no resuelve como tipo.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "stream";
import type { Request } from "express";

/**
 * SPEC-187 · RF-022 · ADR-035 — el proxy del fichero.
 *
 * Una ruta **pública y sin credencial** que recibe una llave, se la resuelve a
 * ms-leads, va a buscar los bytes a ms-documents con el token de servicio y se
 * los entrega al navegador como una descarga.
 *
 * Es la pieza que hace que la ruta de ms-documents pueda seguir cerrada a
 * internet: quien escribe por el widget es anónimo y no va a tener sesión
 * nunca, así que **la llave ES la autorización**.
 *
 * **Y sus errores se escriben para que los lea una persona.** Esta ruta se
 * alcanza pinchando un enlace: al otro lado hay una pestaña del navegador de
 * quien conversa, no un programa que vaya a interpretar un objeto. De una
 * navegación no se puede leer ni el estado ni el cuerpo, así que el widget no
 * puede avisar por su cuenta: lo que esa persona ve es literalmente lo que
 * conteste este fichero.
 *
 * Cada `it` es un escenario del Gherkin del SPEC, con su nombre.
 */

const resolverLlaveDeFichero = vi.fn();
const obtenerFichero = vi.fn();

vi.mock("../../../bff/infrastructure/service-clients/leads-service.client", () => ({
  getLeadsServiceClient: () => ({ resolverLlaveDeFichero }),
}));

vi.mock("../../../bff/infrastructure/service-clients/documents-service.client", () => ({
  getDocumentsServiceClient: () => ({ obtenerFichero }),
}));

import { descargarFichero } from "../fichero.controller";
import { comoRespuesta, respuestaFalsa } from "../../../test/respuesta-falsa";

/** 43 caracteres de `[A-Za-z0-9_-]`: 256 bits en base64url (SPEC-186). */
const LLAVE = "3pQ7x1Kb9vZ2mN4tR8sL0dF6hJ5wY7cA1eG3iU9oP2k";
const ORGANIZACION = "org-1";
const DOCUMENTO = "doc-1";

/** La petición del navegador: una llave y nada más. */
function peticion(llave: string = LLAVE, headers: Record<string, string> = {}): Request {
  return {
    params: { llave },
    headers,
    ip: "10.0.0.1",
  } as unknown as Request;
}

function llaveResuelta() {
  return {
    success: true,
    statusCode: 200,
    duration: 1,
    data: { organizacionId: ORGANIZACION, documentoId: DOCUMENTO },
  };
}

/** Lo que devuelve ms-documents: los bytes, su tipo y su nombre. */
function ficheroDeDocuments(contenido = "%PDF-1.4 tarifas") {
  return {
    statusCode: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": 'attachment; filename="Tarifas%202026.pdf"',
    },
    body: Readable.from([contenido]),
  };
}

describe("SPEC-187 · descargar un fichero del agente", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolverLlaveDeFichero.mockResolvedValue(llaveResuelta());
    obtenerFichero.mockResolvedValue(ficheroDeDocuments());
  });

  it("Una llave buena entrega el fichero", async () => {
    const res = respuestaFalsa();

    await descargarFichero(peticion(), comoRespuesta(res));

    expect(res.codigo).toBe(200);
    await expect(res.cuerpo()).resolves.toBe("%PDF-1.4 tarifas");
    // Con su tipo y su nombre.
    expect(res.cabeceras["Content-Type"]).toBe("application/pdf");
    expect(res.cabeceras["Content-Disposition"]).toContain("Tarifas%202026.pdf");
  });

  it("El navegador lo guarda, no lo abre", async () => {
    // La diferencia con las fotos: aquéllas viven en otro dominio y sólo se
    // pueden abrir; estos bytes salen de nosotros, así que la descarga puede
    // ser una descarga de verdad y el botón cumple lo que promete.
    const res = respuestaFalsa();

    await descargarFichero(peticion(), comoRespuesta(res));

    expect(res.cabeceras["Content-Disposition"]).toMatch(/^attachment;/);
  });

  it("Se le pide a ms-documents con la organización que devolvió la llave", async () => {
    // La suposición declarada del SPEC: al acuñar la llave, ms-leads NO
    // comprueba que el documento sea de esa organización —lo toma de ms-agents,
    // que ya resuelve por tenant—. No hay fuga porque ms-documents recibe la
    // organización al pedir los bytes y responde según ella. Este proxy se
    // apoya en esa cadena: pedir con cualquier otra cosa la rompe.
    await descargarFichero(peticion(), comoRespuesta(respuestaFalsa()));

    expect(obtenerFichero).toHaveBeenCalledWith(
      expect.objectContaining({ organizacionId: ORGANIZACION, documentoId: DOCUMENTO }),
      expect.anything(),
    );
  });

  it("Una llave que no existe", async () => {
    resolverLlaveDeFichero.mockResolvedValue({
      success: false,
      statusCode: 404,
      duration: 1,
      error: { code: "404", message: "Esa llave no existe", service: "ms-leads" },
    });
    const res = respuestaFalsa();

    await descargarFichero(peticion(), comoRespuesta(res));

    expect(res.codigo).toBe(404);
    // Y no se llama a ms-documents: sin llave no hay a qué documento ir.
    expect(obtenerFichero).not.toHaveBeenCalled();
  });

  it("Una llave con otra forma no llega ni a ms-leads", async () => {
    // La llave tiene una forma fija (SPEC-186). Lo que no la tiene no puede
    // existir, así que no se pregunta: quien barra la ruta al azar no nos
    // cuesta una llamada por intento. El 404 es el mismo, y por eso no delata
    // nada.
    const res = respuestaFalsa();

    await descargarFichero(peticion("../../etc/passwd"), comoRespuesta(res));

    expect(res.codigo).toBe(404);
    expect(resolverLlaveDeFichero).not.toHaveBeenCalled();
    expect(obtenerFichero).not.toHaveBeenCalled();
  });

  it("Un fichero que ya no está", async () => {
    // Los dos lados se borran por separado: una llave viva contra un documento
    // que ya no está es un caso normal, no una avería.
    obtenerFichero.mockResolvedValue({
      statusCode: 404,
      headers: { "content-type": "application/json" },
      body: Readable.from(['{"error":"no está"}']),
    });
    const res = respuestaFalsa();

    await descargarFichero(peticion(), comoRespuesta(res));

    expect(res.codigo).toBe(404);
  });

  it("No hace falta identificarse", async () => {
    // Ni token de organización, ni sesión, ni nada: quien escribe por el widget
    // es anónimo y la llave es la autorización.
    const res = respuestaFalsa();

    await descargarFichero(peticion(LLAVE, {}), comoRespuesta(res));

    expect(res.codigo).toBe(200);
    await expect(res.cuerpo()).resolves.toBe("%PDF-1.4 tarifas");
  });

  it("La llave no dice qué documento es", async () => {
    const res = respuestaFalsa();

    await descargarFichero(peticion(), comoRespuesta(res));

    // Ni en las cabeceras ni en el cuerpo: entra una llave y salen bytes.
    const todo = JSON.stringify(res.cabeceras) + (await res.cuerpo());
    expect(todo).not.toContain(DOCUMENTO);
    expect(todo).not.toContain(ORGANIZACION);
  });

  it("Y tampoco lo dice al fallar, ahora que el cuerpo es otro", async () => {
    // La misma comprobación sobre la respuesta legible: cambiar la envoltura no
    // puede colar por el cuerpo nuevo lo que el anterior no dejaba salir.
    obtenerFichero.mockResolvedValue({
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: Readable.from([`{"organizacionId":"${ORGANIZACION}"}`]),
    });
    const res = respuestaFalsa();

    await descargarFichero(peticion(), comoRespuesta(res));

    const todo = JSON.stringify(res.cabeceras) + (await res.cuerpo());
    expect(todo).not.toContain(DOCUMENTO);
    expect(todo).not.toContain(ORGANIZACION);
  });

  it("Un fichero que ya no está se dice con palabras", async () => {
    obtenerFichero.mockResolvedValue({
      statusCode: 404,
      headers: { "content-type": "application/json" },
      body: Readable.from(['{"error":"no está"}']),
    });
    const res = respuestaFalsa();

    await descargarFichero(peticion(), comoRespuesta(res));

    // Lo que se lee es una frase, no un objeto con llaves y comillas.
    const cuerpo = await res.cuerpo();
    expect(cuerpo).toBe("Ese fichero ya no está disponible.");
    expect(cuerpo).not.toContain("{");
    expect(cuerpo).not.toContain('"');
    expect(res.cabeceras["Content-Type"]).toBe("text/plain; charset=utf-8");
  });

  it("Una llave que no existe también se dice con palabras", async () => {
    resolverLlaveDeFichero.mockResolvedValue({
      success: false,
      statusCode: 404,
      duration: 1,
      error: { code: "404", message: "Esa llave no existe", service: "ms-leads" },
    });
    const res = respuestaFalsa();

    await descargarFichero(peticion(), comoRespuesta(res));

    expect(await res.cuerpo()).toBe("Ese fichero ya no está disponible.");
  });

  it("Y un fallo nuestro también, con su propia frase", async () => {
    // Un 502 no es «no existe»: se le dice que vuelva a intentarlo, porque el
    // enlace sigue siendo bueno. Y también en palabras.
    resolverLlaveDeFichero.mockRejectedValue(new Error("boom"));
    const res = respuestaFalsa();

    await descargarFichero(peticion(), comoRespuesta(res));

    expect(await res.cuerpo()).toBe(
      "No he podido darte ese fichero ahora mismo. Vuelve a intentarlo en un momento.",
    );
    expect(res.cabeceras["Content-Type"]).toBe("text/plain; charset=utf-8");
  });

  it("Un error no se descarga: se lee en la pestaña", async () => {
    // Sin `Content-Disposition`. Guardar un fichero llamado «Tarifas 2026» que
    // por dentro dice «ya no está disponible» es peor que no dar nada.
    resolverLlaveDeFichero.mockResolvedValue({
      success: false,
      statusCode: 404,
      duration: 1,
      error: { code: "404", message: "Esa llave no existe", service: "ms-leads" },
    });
    const res = respuestaFalsa();

    await descargarFichero(peticion(), comoRespuesta(res));

    expect(res.cabeceras["Content-Disposition"]).toBeUndefined();
  });

  it("Un 404 tampoco cuenta nada de lo que hay detrás", async () => {
    resolverLlaveDeFichero.mockResolvedValue({
      success: false,
      statusCode: 404,
      duration: 1,
      error: { code: "404", message: "Esa llave no existe", service: "ms-leads" },
    });
    const res = respuestaFalsa();

    await descargarFichero(peticion(), comoRespuesta(res));

    const cuerpo = await res.cuerpo();
    expect(cuerpo).not.toContain("ms-leads");
    expect(cuerpo).not.toContain("llave");
  });

  it("Si ms-leads no contesta", async () => {
    resolverLlaveDeFichero.mockRejectedValue(new Error("boom"));
    const res = respuestaFalsa();

    await descargarFichero(peticion(), comoRespuesta(res));

    // Un error que el widget pueda enseñar, y NO un 404: decirle «no existe» a
    // un enlace que sí existe le pediría a quien escribe que dejara de
    // intentarlo.
    expect(res.codigo).toBe(502);
    expect(obtenerFichero).not.toHaveBeenCalled();
  });

  it("Si ms-documents no contesta, tampoco se rompe la conversación", async () => {
    obtenerFichero.mockRejectedValue(new Error("boom"));
    const res = respuestaFalsa();

    await descargarFichero(peticion(), comoRespuesta(res));

    expect(res.codigo).toBe(502);
  });

  it("Un fichero sin tipo declarado se entrega igual", async () => {
    // Sin `content-type` no se adivina: se entrega como bytes sin más, que es
    // lo que hace que el navegador lo guarde en vez de intentar pintarlo.
    obtenerFichero.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: Readable.from(["datos"]),
    });
    const res = respuestaFalsa();

    await descargarFichero(peticion(), comoRespuesta(res));

    expect(res.codigo).toBe(200);
    expect(res.cabeceras["Content-Type"]).toBe("application/octet-stream");
    expect(res.cabeceras["Content-Disposition"]).toMatch(/^attachment;/);
  });
});
