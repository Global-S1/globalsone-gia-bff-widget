import { PassThrough } from "stream";
import type { Response } from "express";
import { vi } from "vitest";

/**
 * Una respuesta de express que de verdad se puede escribir.
 *
 * Los caminos que sirven bytes hacen `upstream.body.pipe(res)`, y un objeto con
 * `vi.fn()` no es un destino válido para un stream. Sobre un `PassThrough` sí,
 * y además deja leer lo que se escribió.
 *
 * Vive en `src/test/` —fuera de la cobertura— porque es andamio de pruebas y no
 * código del servicio.
 */
export type RespuestaFalsa = PassThrough & {
  cabeceras: Record<string, string>;
  codigo: number | undefined;
  headersSent: boolean;
  setHeader: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  cuerpo: () => Promise<string>;
};

export function respuestaFalsa(): RespuestaFalsa {
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

/** El controlador espera un `Response`; aquí sólo se usa lo que toca. */
export function comoRespuesta(res: RespuestaFalsa): Response {
  return res as unknown as Response;
}
