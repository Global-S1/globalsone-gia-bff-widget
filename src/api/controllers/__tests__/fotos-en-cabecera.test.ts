// Importados explícitamente, no por `globals: true`: el tsconfig de este repo
// restringe typeRoots, así que "vitest/globals" no resuelve como tipo.
import { describe, expect, it } from "vitest";

import {
  CABECERA_DE_FOTOS,
  TOPE_DE_LA_CABECERA,
  codificarFotos,
} from "../fotos-en-cabecera";

/**
 * SPEC-183 — las fotos hacia el navegador, codificadas para una cabecera.
 *
 * El cuerpo de esta ruta **es el texto que lee quien escribe**: lo que se meta
 * ahí se le pinta. Las fotos van fuera, por donde ya va `Contact-Form-Url`.
 */

/** Lo que el widget hará al leer la cabecera. */
function descodificar(valor: string): unknown {
  return JSON.parse(Buffer.from(valor, "base64").toString("utf8"));
}

const UNA = "https://cdn.acme.example/catalogo/silla-roja.jpg";
const OTRA = "https://cdn.acme.example/catalogo/silla-azul.jpg";

describe("SPEC-183 · codificarFotos", () => {
  it("la cabecera se llama igual siempre", () => {
    // El widget construye contra este nombre literal: no se calcula.
    expect(CABECERA_DE_FOTOS).toBe("Chat-Photos");
  });

  it("varias direcciones caben en un solo valor y conservan su orden", () => {
    // El orden importa porque el texto habla de ellas por su orden (RF-021):
    // reordenarlas cambia lo que dice el mensaje sin tocar el mensaje.
    const valor = codificarFotos([UNA, OTRA]);

    expect(valor).not.toBeNull();
    expect(descodificar(valor as string)).toEqual([UNA, OTRA]);
  });

  it("el valor es ASCII imprimible aunque la dirección no lo sea", () => {
    // Una cabecera HTTP sólo admite latin-1: Node RECHAZA la respuesta entera
    // si se le pone una «ñ», y la ruta de un catálogo en español las lleva.
    // Es el mismo motivo por el que ms-agents codifica lo que aparta.
    const conEnie = "https://cdn.acme.example/catalogo/silla-ñandú.jpg";
    const valor = codificarFotos([conEnie]) as string;

    expect(valor).toMatch(/^[A-Za-z0-9+/=]+$/);
    // Y lo que se descodifica sigue llevando a la misma foto.
    expect(String((descodificar(valor) as string[])[0])).toContain("silla-");
  });

  it("sin ninguna foto no hay valor, en vez de un valor vacío", () => {
    // Nada de cabecera vacía: obligaría a quien la lee a distinguir «no hay
    // fotos» de «no la entiendo». Es la regla de `Chat-Resources` y la de
    // `Contact-Form-Url`.
    expect(codificarFotos([])).toBeNull();
    expect(codificarFotos(undefined)).toBeNull();
  });

  it("una dirección que no es http ni https no sale", () => {
    // Esto acaba dentro de una página que no controlamos: un `javascript:` ahí
    // es código ejecutándose en el sitio del cliente de nuestro cliente.
    const valor = codificarFotos(["javascript:alert(1)", UNA, "data:image/png;base64,AAA"]);

    expect(descodificar(valor as string)).toEqual([UNA]);
  });

  it("lo que no es una dirección tampoco sale, y no arrastra a las demás", () => {
    const valor = codificarFotos(["no soy una url", UNA, "", "   "]);

    expect(descodificar(valor as string)).toEqual([UNA]);
  });

  it("cuando ninguna se puede entregar no hay valor", () => {
    expect(codificarFotos(["javascript:alert(1)", "ftp://acme.example/x.jpg"])).toBeNull();
  });

  it("una lista que no cabe se recorta por el final en vez de romper", () => {
    // Detrás hay un nginx que lee las cabeceras en un buffer de tamaño fijo: si
    // se pasa, la respuesta ENTERA se pierde. Antes menos fotos que ninguna
    // respuesta.
    const larga = `https://cdn.acme.example/catalogo/${"a".repeat(300)}.jpg`;
    const muchas = Array.from({ length: 40 }, (_, i) => `${larga}?n=${i}`);

    const valor = codificarFotos(muchas) as string;

    expect(valor.length).toBeLessThanOrEqual(TOPE_DE_LA_CABECERA);
    const entregadas = descodificar(valor) as string[];
    expect(entregadas.length).toBeGreaterThan(0);
    expect(entregadas.length).toBeLessThan(muchas.length);
    // Y las que se entregan son las primeras, en su orden: el texto habla de
    // ellas por su orden, así que recortar por el final es lo único que no
    // desordena lo que ya se dijo.
    expect(entregadas).toEqual(muchas.slice(0, entregadas.length));
  });

  it("una sola dirección que no cabe deja la respuesta sin cabecera, no rota", () => {
    const monstruosa = `https://cdn.acme.example/${"a".repeat(TOPE_DE_LA_CABECERA * 2)}.jpg`;

    expect(codificarFotos([monstruosa])).toBeNull();
  });
});
