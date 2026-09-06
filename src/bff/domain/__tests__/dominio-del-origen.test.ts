// Importados explícitamente, no por `globals: true`: el tsconfig de este repo
// restringe typeRoots, así que "vitest/globals" no resuelve como tipo.
import { describe, expect, it } from "vitest";

import { dominioDelOrigen } from "../dominio-del-origen";

/**
 * SPEC-195 · SPEC-196 · SPEC-205 — **la costura entre dos repositorios**.
 *
 * Los dominios que el tenant declara se guardan ya normalizados en ms-agents,
 * con `dominioDe`. Aquí llega un `Origin` de navegador y hay que dejarlo en la
 * misma forma **antes** de compararlo. Las dos puntas viven en repositorios
 * distintos, así que nada avisa el día que una cambie: si se separan, un tenant
 * con el bloqueo encendido se queda fuera de su propia web y el registro no
 * dice por qué.
 *
 * Por eso la tabla de casos de SPEC-205 está **transcrita aquí como fixture** y
 * no confiada al cuidado de quien lea. Es una copia a propósito: si allá se
 * cambia el criterio, esto se pone rojo, que es lo único que puede avisar.
 */

/**
 * La tabla de SPEC-205, literal: entrada → lo que ms-agents dejó guardado.
 *
 * `münchen.de` está porque el IDN es el caso donde dos implementaciones
 * razonables divergen sin querer: quien no pase por un analizador de URL
 * guardaría los acentos y no casaría nunca con lo que manda el navegador.
 */
const LA_TABLA_DE_SPEC_205: [string, string][] = [
  ["https://Pepito.com/contacto?x=1", "pepito.com"],
  ["https://Acme.example/precios", "acme.example"],
  ["tienda.acme.example", "tienda.acme.example"],
  ["https://acme.example/", "acme.example"],
  ["https://münchen.de", "xn--mnchen-3ya.de"],
];

describe("SPEC-196 · el origen se normaliza como lo hizo ms-agents al guardar", () => {
  it.each(LA_TABLA_DE_SPEC_205)("%s queda en %s", (entrada, guardado) => {
    expect(dominioDelOrigen(entrada)).toBe(guardado);
  });

  it("las tres formas de nombrar la misma web dan la misma cadena", () => {
    // Es la comprobación literal de SPEC-205: esquema y puerto se caen, y lo
    // que queda es exactamente la cadena que allá está guardada. Un `Origin`
    // de navegador es siempre `esquema://host[:puerto]`, nunca una URL con
    // camino, así que estos tres son todos los que pueden llegar.
    const formas = [
      "https://acme.example",
      "https://acme.example:8443",
      "http://acme.example",
    ].map(dominioDelOrigen);

    expect(formas).toEqual(["acme.example", "acme.example", "acme.example"]);
  });
});

describe("SPEC-195 · el dominio del origen", () => {
  it("se queda con el dominio y tira todo lo demás", () => {
    expect(dominioDelOrigen("https://tienda.example/productos?utm=x")).toBe("tienda.example");
    expect(dominioDelOrigen("https://tienda.example")).toBe("tienda.example");
  });

  it("tira también el puerto: lo que se apunta es el dominio", () => {
    expect(dominioDelOrigen("https://pruebas.tienda.example:8443")).toBe(
      "pruebas.tienda.example",
    );
  });

  it("lo pasa a minúsculas, que es como se guarda", () => {
    expect(dominioDelOrigen("https://Tienda.EXAMPLE")).toBe("tienda.example");
  });

  it("admite un dominio pelado, sin esquema", () => {
    expect(dominioDelOrigen("tienda.example")).toBe("tienda.example");
  });

  it("una petición sin origen no apunta nada", () => {
    // Un navegador siempre lo manda en esta llamada; un servidor no. Y sin
    // bloqueo encendido, eso se atiende igual (ADR-038).
    expect(dominioDelOrigen(undefined)).toBeNull();
    expect(dominioDelOrigen("")).toBeNull();
    expect(dominioDelOrigen("   ")).toBeNull();
  });

  it("`null` literal de un navegador no es un dominio", () => {
    // Es lo que manda un origen opaco: un iframe con sandbox, un fichero
    // local. Apuntarlo ensuciaría la lista que el tenant mira, y compararlo
    // convertiría «sin origen» en un dominio llamado `null`.
    expect(dominioDelOrigen("null")).toBeNull();
  });

  it("lo que no es una dirección tampoco lo es", () => {
    expect(dominioDelOrigen("no soy un dominio")).toBeNull();
    expect(dominioDelOrigen("javascript:alert(1)")).toBeNull();
  });

  it("lo que no es web no es un dominio, igual que allá", () => {
    // `dominioDe` de ms-agents exige `http`/`https`: sin esta línea, un
    // `Origin: chrome-extension://abcdef` saldría de aquí como el dominio
    // `abcdef` y las dos puntas dejarían de hablar de lo mismo.
    expect(dominioDelOrigen("chrome-extension://abcdefghijklmnop")).toBeNull();
    expect(dominioDelOrigen("file://")).toBeNull();
  });
});
