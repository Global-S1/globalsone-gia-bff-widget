// Importados explícitamente, no por `globals: true`: el tsconfig de este repo
// restringe typeRoots, así que "vitest/globals" no resuelve como tipo.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apuntarVisto = vi.fn();
vi.mock("../../../infrastructure/service-clients/agents-service.client", () => ({
  getAgentsServiceClient: () => ({ apuntarVisto }),
}));

import {
  dominioDelOrigen,
  apuntarOrigen,
  olvidarOrigenesApuntados,
} from "../apuntar-origen.use-case";
import type { IRequestContext } from "../../../domain/interfaces/request-context.interface";

/**
 * SPEC-195 · RF-025 · ADR-038 — desde dónde se carga el widget.
 *
 * Lo que se apunta sale de la llamada que el widget **ya hace**: nadie declara
 * nada y no se sale a rastrear páginas ajenas.
 */

const contexto: IRequestContext = { correlationId: "corr-1", timestamp: new Date() };

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
    // local. Apuntarlo ensuciaría la lista que el tenant mira.
    expect(dominioDelOrigen("null")).toBeNull();
  });

  it("lo que no es una dirección tampoco lo es", () => {
    expect(dominioDelOrigen("no soy un dominio")).toBeNull();
    expect(dominioDelOrigen("javascript:alert(1)")).toBeNull();
  });
});

describe("SPEC-195 · apuntar lo observado", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    olvidarOrigenesApuntados();
    apuntarVisto.mockResolvedValue({
      success: true,
      statusCode: 200,
      duration: 1,
      data: { anotado: true },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("Se apunta desde dónde se cargó", () => {
    apuntarOrigen("w-1", "https://tienda.example/productos", contexto);

    expect(apuntarVisto).toHaveBeenCalledWith("w-1", "tienda.example", expect.anything());
  });

  it("Se apunta el dominio y nada más", () => {
    // Ni el visitante, ni su IP, ni la dirección completa.
    apuntarOrigen("w-1", "https://tienda.example/carrito?cliente=ana&ip=1.2.3.4", contexto);

    const [, mandado] = apuntarVisto.mock.calls[0] as [string, string, unknown];
    expect(mandado).toBe("tienda.example");
    expect(mandado).not.toContain("ana");
    expect(mandado).not.toContain("1.2.3.4");
    expect(mandado).not.toContain("carrito");
  });

  it("No se apunta en cada visita", () => {
    // El freno de verdad vive en ms-agents, que es el único que sabe cuándo se
    // escribió por última vez. Éste sólo ahorra la llamada.
    for (let i = 0; i < 20; i++) {
      apuntarOrigen("w-1", "https://tienda.example", contexto);
    }

    expect(apuntarVisto).toHaveBeenCalledTimes(1);
  });

  it("pasado el rato se vuelve a apuntar", () => {
    vi.useFakeTimers();
    apuntarOrigen("w-1", "https://tienda.example", contexto);
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    apuntarOrigen("w-1", "https://tienda.example", contexto);

    expect(apuntarVisto).toHaveBeenCalledTimes(2);
  });

  it("un dominio que no constaba se apunta aunque otro esté reciente", () => {
    // Es justo la señal que se quiere ver: alguien copió el fragmento y lo
    // montó en otro sitio (ADR-038).
    apuntarOrigen("w-1", "https://tienda.example", contexto);
    apuntarOrigen("w-1", "https://copia.ajena.example", contexto);

    expect(apuntarVisto).toHaveBeenCalledTimes(2);
    expect(apuntarVisto).toHaveBeenLastCalledWith(
      "w-1",
      "copia.ajena.example",
      expect.anything(),
    );
  });

  it("dos widgets en el mismo dominio se apuntan por separado", () => {
    apuntarOrigen("w-1", "https://tienda.example", contexto);
    apuntarOrigen("w-2", "https://tienda.example", contexto);

    expect(apuntarVisto).toHaveBeenCalledTimes(2);
  });

  it("sin origen no se llama a nadie", () => {
    apuntarOrigen("w-1", undefined, contexto);

    expect(apuntarVisto).not.toHaveBeenCalled();
  });

  it("si la llamada falla se reintenta en el mensaje siguiente", async () => {
    // El freno se apunta ANTES de llamar para que una ráfaga no dispare veinte
    // a la vez; si la llamada se cae, se suelta para no perder el dominio
    // durante todo el rato.
    apuntarVisto.mockRejectedValueOnce(new Error("boom"));

    apuntarOrigen("w-1", "https://tienda.example", contexto);
    await vi.waitFor(() => expect(apuntarVisto).toHaveBeenCalledTimes(1));

    await vi.waitFor(() => {
      apuntarOrigen("w-1", "https://tienda.example", contexto);
      expect(apuntarVisto).toHaveBeenCalledTimes(2);
    });
  });

  it("apuntar no puede tumbar la respuesta de quien escribe", async () => {
    // Es una observación, no parte de contestar: ni se espera ni puede lanzar.
    apuntarVisto.mockRejectedValue(new Error("boom"));

    expect(() => apuntarOrigen("w-1", "https://tienda.example", contexto)).not.toThrow();
    await vi.waitFor(() => expect(apuntarVisto).toHaveBeenCalled());
  });
});
