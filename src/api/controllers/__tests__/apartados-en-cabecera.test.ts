// Importados explícitamente, no por `globals: true`: el tsconfig de este repo
// restringe typeRoots, así que "vitest/globals" no resuelve como tipo.
import { describe, expect, it } from "vitest";

import {
  PRESUPUESTO_DE_CABECERAS,
  RESERVA_POR_CABECERA,
  codificarParaCabecera,
} from "../apartados-en-cabecera";

/**
 * SPEC-183 · SPEC-188 — el presupuesto que comparten las cabeceras de lo que el
 * agente aparta.
 *
 * Con las fotos había UNA cabecera que podía crecer. Con los ficheros hay DOS,
 * y el límite que importa no es el de cada una: es **el bloque entero de
 * cabeceras de la respuesta**, que el nginx de en medio lee dentro de un búfer
 * de tamaño fijo. Si se pasa no recorta: tira la respuesta con un 502, y quien
 * escribe se queda sin el texto por culpa de un adjunto.
 */
describe("SPEC-188 · el presupuesto compartido", () => {
  it("las dos reservas juntas no se pasan del presupuesto", () => {
    // Ésta es LA invariante de este fichero. Si alguien sube una reserva sin
    // mirar la otra, esta prueba se pone roja antes de que lo haga un 502 en
    // producción, que además sólo aparece cuando coinciden un turno con muchas
    // fotos y otro con muchos ficheros.
    expect(RESERVA_POR_CABECERA * 2).toBeLessThanOrEqual(PRESUPUESTO_DE_CABECERAS);
  });

  it("y el presupuesto deja sitio de sobra para el resto de la respuesta", () => {
    // El búfer por defecto de nginx es de 4 KB y ahí cabe TODO: la línea de
    // estado, las nuestras (`Content-Type`, `Cache-Control`, `Contact-Form-Url`,
    // `X-Correlation-ID`) y las que añade el propio nginx.
    expect(PRESUPUESTO_DE_CABECERAS).toBeLessThanOrEqual(2048);
  });
});

describe("SPEC-188 · codificarParaCabecera", () => {
  it("deja el valor en ASCII imprimible aunque el contenido no lo sea", () => {
    const valor = codificarParaCabecera([{ t: "Catálogo de otoño" }], 1000) as string;

    expect(valor).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("sin nada que codificar no hay valor, en vez de un valor vacío", () => {
    expect(codificarParaCabecera([], 1000)).toBeNull();
  });

  it("recorta por el final hasta que quepa, sin reordenar", () => {
    const largo = "x".repeat(200);
    const muchos = Array.from({ length: 20 }, (_, i) => ({ t: `${largo}${i}` }));

    const valor = codificarParaCabecera(muchos, 500) as string;

    expect(valor.length).toBeLessThanOrEqual(500);
    const dentro = JSON.parse(Buffer.from(valor, "base64").toString("utf8"));
    expect(dentro.length).toBeGreaterThan(0);
    expect(dentro).toEqual(muchos.slice(0, dentro.length));
  });

  it("cuando ni el primero cabe, no hay valor: mejor sin cabecera que sin respuesta", () => {
    expect(codificarParaCabecera([{ t: "x".repeat(5000) }], 100)).toBeNull();
  });
});
