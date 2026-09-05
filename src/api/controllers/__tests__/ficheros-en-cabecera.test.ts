// Importados explícitamente, no por `globals: true`: el tsconfig de este repo
// restringe typeRoots, así que "vitest/globals" no resuelve como tipo.
import { describe, expect, it } from "vitest";

import { RESERVA_POR_CABECERA } from "../apartados-en-cabecera";
import { CABECERA_DE_FICHEROS, codificarFicheros } from "../ficheros-en-cabecera";

/**
 * SPEC-188 · RF-022 · ADR-035 — los ficheros hacia el navegador.
 *
 * Lo mismo que las fotos y por lo mismo: el cuerpo de esta ruta es el texto que
 * lee quien escribe, así que lo que no sea ese texto viaja fuera.
 *
 * Aquí el base64 muerde más que en las fotos: una dirección de catálogo *puede*
 * llevar una «ñ», pero **el título lo escribe el tenant**, así que «Catálogo de
 * otoño» es el caso normal y no el raro. Una cabecera HTTP sólo admite latin-1
 * y Node rechaza la respuesta entera al ponérsela.
 */

function descodificar(valor: string): { titulo: string; llave: string }[] {
  return JSON.parse(Buffer.from(valor, "base64").toString("utf8"));
}

/** 43 caracteres de `[A-Za-z0-9_-]`: 256 bits en base64url (SPEC-186). */
const LLAVE = "3pQ7x1Kb9vZ2mN4tR8sL0dF6hJ5wY7cA1eG3iU9oP2k";
const OTRA_LLAVE = "Zm9vYmFyYmF6cXV4MDEyMzQ1Njc4OWFiY2RlZmdoaWo";

describe("SPEC-188 · codificarFicheros", () => {
  it("la cabecera se llama igual siempre", () => {
    // El widget construye contra este nombre literal: no se calcula.
    expect(CABECERA_DE_FICHEROS).toBe("Chat-Files");
  });

  it("los ficheros llegan con su título y su llave, en su orden", () => {
    // El orden importa por lo mismo que en las fotos: el texto habla de ellos
    // por su orden, y reordenarlos cambiaría lo que dice el mensaje.
    const valor = codificarFicheros([
      { titulo: "Tarifas 2026", llave: LLAVE },
      { titulo: "Brochure", llave: OTRA_LLAVE },
    ]) as string;

    expect(descodificar(valor)).toEqual([
      { titulo: "Tarifas 2026", llave: LLAVE },
      { titulo: "Brochure", llave: OTRA_LLAVE },
    ]);
  });

  it("un título con acentos llega entero", () => {
    // Sin tocar, sin transliterar y sin recortar: es lo que el tenant escribió
    // y lo que va a leer quien conversa.
    const valor = codificarFicheros([
      { titulo: "Catálogo de otoño", llave: LLAVE },
    ]) as string;

    expect(valor).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(descodificar(valor)[0]!.titulo).toBe("Catálogo de otoño");
  });

  it("sin ningún fichero no hay valor, en vez de un valor vacío", () => {
    expect(codificarFicheros([])).toBeNull();
    expect(codificarFicheros(undefined)).toBeNull();
  });

  it("un fichero sin título no se ofrece", () => {
    // Sin nombre no hay bloque que pintar (SPEC-189): sería un enlace mudo.
    const valor = codificarFicheros([
      { titulo: "   ", llave: LLAVE },
      { titulo: "Tarifas", llave: OTRA_LLAVE },
    ]) as string;

    expect(descodificar(valor)).toEqual([{ titulo: "Tarifas", llave: OTRA_LLAVE }]);
  });

  it("una llave con otra forma no se ofrece", () => {
    // La llave tiene forma fija (SPEC-186) y el proxy la comprueba antes de
    // preguntar: ofrecer una que no la tiene es ofrecer un enlace que ya
    // sabemos que va a dar 404.
    const valor = codificarFicheros([
      { titulo: "Roto", llave: "no-es-una-llave" },
      { titulo: "Tarifas", llave: LLAVE },
    ]) as string;

    expect(descodificar(valor)).toEqual([{ titulo: "Tarifas", llave: LLAVE }]);
  });

  it("lo que no tiene forma de fichero se ignora sin arrastrar a los demás", () => {
    const valor = codificarFicheros([
      null as never,
      { titulo: "Tarifas", llave: LLAVE },
      { llave: OTRA_LLAVE } as never,
    ]) as string;

    expect(descodificar(valor)).toEqual([{ titulo: "Tarifas", llave: LLAVE }]);
  });

  it("cuando ninguno se puede ofrecer no hay valor", () => {
    expect(codificarFicheros([{ titulo: "", llave: "x" }])).toBeNull();
  });

  it("una lista que no cabe se recorta por el final en vez de romper", () => {
    const titulo = "Catálogo de otoño ".repeat(20);
    const muchos = Array.from({ length: 30 }, (_, i) => ({
      titulo: `${titulo}${i}`,
      llave: LLAVE,
    }));

    const valor = codificarFicheros(muchos) as string;

    expect(valor.length).toBeLessThanOrEqual(RESERVA_POR_CABECERA);
    const entregados = descodificar(valor);
    expect(entregados.length).toBeGreaterThan(0);
    expect(entregados.length).toBeLessThan(muchos.length);
    expect(entregados).toEqual(muchos.slice(0, entregados.length));
  });

  it("un solo título gigantesco deja la respuesta sin cabecera, no rota", () => {
    const valor = codificarFicheros([
      { titulo: "x".repeat(RESERVA_POR_CABECERA * 2), llave: LLAVE },
    ]);

    expect(valor).toBeNull();
  });
});
