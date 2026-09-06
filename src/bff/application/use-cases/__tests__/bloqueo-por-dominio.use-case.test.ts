// Importados explícitamente, no por `globals: true`: el tsconfig de este repo
// restringe typeRoots, así que "vitest/globals" no resuelve como tipo.
import { describe, expect, it } from "vitest";

import { decidirPorDominio } from "../bloqueo-por-dominio.use-case";

/**
 * SPEC-196 · RF-025 · ADR-038 — atender sólo desde lo registrado.
 *
 * La decisión es una función pura y se prueba sin levantar nada: lo que se
 * comprueba aquí es **cuándo se bloquea**, no cómo se contesta, que es del
 * controlador.
 */

const ENCENDIDO_CON_PEPITO = {
  domainBlockingEnabled: true,
  allowedDomains: ["pepito.com"],
};

describe("SPEC-196 · cuándo se bloquea", () => {
  it("Desde el dominio registrado se atiende", () => {
    expect(decidirPorDominio(ENCENDIDO_CON_PEPITO, "https://pepito.com")).toBe("se-atiende");
  });

  it("Desde otro dominio no", () => {
    expect(decidirPorDominio(ENCENDIDO_CON_PEPITO, "https://raul.com")).toBe("no-autorizado");
  });

  it("Con el bloqueo apagado se atiende desde cualquier sitio", () => {
    expect(
      decidirPorDominio(
        { domainBlockingEnabled: false, allowedDomains: ["pepito.com"] },
        "https://raul.com",
      ),
    ).toBe("se-atiende");
  });

  it("Sin dominios registrados no se bloquea nada", () => {
    // Si no, crear un widget lo dejaría muerto hasta que alguien se acordara.
    expect(
      decidirPorDominio({ domainBlockingEnabled: true, allowedDomains: [] }, "https://raul.com"),
    ).toBe("se-atiende");
  });

  it("Una petición sin origen no se atiende", () => {
    // En esta llamada un navegador siempre manda `Origin`: su ausencia
    // significa que quien llama no es una página.
    expect(decidirPorDominio(ENCENDIDO_CON_PEPITO, undefined)).toBe("no-autorizado");
    expect(decidirPorDominio(ENCENDIDO_CON_PEPITO, "")).toBe("no-autorizado");
  });

  it("un `Origin: null` cuenta como sin origen y no como un dominio llamado null", () => {
    // Un iframe con arenero o un fichero local. Y aunque alguien llegara a
    // registrar «null» —ms-agents lo admite, es su hueco declarado—, un origen
    // opaco sigue sin ser un sitio desde el que se atienda.
    expect(decidirPorDominio(ENCENDIDO_CON_PEPITO, "null")).toBe("no-autorizado");
    expect(
      decidirPorDominio({ domainBlockingEnabled: true, allowedDomains: ["null"] }, "null"),
    ).toBe("no-autorizado");
  });

  it("el origen se normaliza antes de comparar, que es donde esto se rompería", () => {
    // Lo guardado es `pepito.com`; el navegador manda esquema y puerto.
    expect(decidirPorDominio(ENCENDIDO_CON_PEPITO, "https://PEPITO.com:8443")).toBe("se-atiende");
    expect(decidirPorDominio(ENCENDIDO_CON_PEPITO, "http://pepito.com")).toBe("se-atiende");
  });

  it("un subdominio no cuela: no hay comodines", () => {
    // ADR-038 dejó los comodines de subdominio sin decidir, así que aquí no se
    // inventan: `tienda.pepito.com` es otro sitio hasta que alguien lo decida.
    expect(decidirPorDominio(ENCENDIDO_CON_PEPITO, "https://tienda.pepito.com")).toBe(
      "no-autorizado",
    );
  });

  it("una lista que no llegó no bloquea, que es distinto de una lista vacía", () => {
    // `allowedDomains` va siempre presente por contrato (SPEC-205). Si algún
    // día no llega —un ms-agents anterior, una respuesta a medias—, quien
    // compara no sabe contra qué, y apagar el widget de un tenant por no
    // saberlo sería lo peor de los dos errores posibles.
    expect(decidirPorDominio({ domainBlockingEnabled: true }, "https://raul.com")).toBe(
      "se-atiende",
    );
  });

  it("lo que hay dentro de la lista viene de la red y no puede tumbar la decisión", () => {
    const rara = {
      domainBlockingEnabled: true,
      allowedDomains: [null, 42, " PEPITO.com "] as unknown as string[],
    };

    expect(decidirPorDominio(rara, "https://pepito.com")).toBe("se-atiende");
    expect(decidirPorDominio(rara, "https://raul.com")).toBe("no-autorizado");
  });
});
