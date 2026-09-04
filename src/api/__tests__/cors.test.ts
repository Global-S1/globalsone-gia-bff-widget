// Importados explícitamente, no por `globals: true`: el tsconfig de este repo
// restringe typeRoots, así que "vitest/globals" no resuelve como tipo.
import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

/**
 * SPEC-183 — «lo que las lleva está declarado en el CORS».
 *
 * Una cabecera de respuesta que no se expone **existe y es invisible desde el
 * script**: el navegador la recibe y no deja leerla. Es el paso que ya hizo
 * falta para `Contact-Form-Url`, y sin él las fotos llegarían al widget sin que
 * el widget pudiera verlas — que desde fuera se ve igual que no mandarlas.
 *
 * Se comprueba sobre las opciones REALES que recibe `cors`, no sobre una lista
 * copiada aquí: una lista copiada sólo se confirmaría a sí misma.
 */

const opcionesDeCors = vi.fn();

vi.mock("cors", () => ({
  default: (opciones: unknown) => {
    opcionesDeCors(opciones);
    return (_req: Request, _res: Response, next: NextFunction) => next();
  },
}));

import { server } from "../../server";

function cabecerasExpuestas(): string[] {
  server();
  const opciones = opcionesDeCors.mock.calls[0]?.[0] as
    | { exposedHeaders?: string[] }
    | undefined;
  return opciones?.exposedHeaders ?? [];
}

describe("SPEC-183 · el navegador puede leer lo que le mandamos", () => {
  it("las fotos van en una cabecera declarada en el CORS", () => {
    expect(cabecerasExpuestas()).toContain("Chat-Photos");
  });

  it("y las que ya se exponían siguen expuestas", () => {
    // La sesión del camino de ms-agents y el formulario del de ms-leads: si una
    // de las dos se cae de la lista, el widget deja de verla sin ningún error.
    const expuestas = cabecerasExpuestas();
    expect(expuestas).toContain("Chat-Session-Id");
    expect(expuestas).toContain("Contact-Form-Url");
  });
});
