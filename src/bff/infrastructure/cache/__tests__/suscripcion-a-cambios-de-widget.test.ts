// Importados explícitamente, no por `globals: true`: el tsconfig de este repo
// restringe typeRoots, así que "vitest/globals" no resuelve como tipo.
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SPEC-262 · SPEC-261 · ADR-044 — enterarse en vez de esperar.
 *
 * ms-agents publica `widget.updated` cuando un widget cambia. Aquí se escucha y
 * se olvida lo que se guardaba de él, sin aguardar a que venza.
 *
 * Lo que se sujeta sobre todo es la tolerancia: **nada de esto puede impedir
 * atender**. Si no hay a quién escuchar, si el aviso viene roto o si llega de
 * un widget que no tenemos, el servicio sigue en pie con el vencimiento por
 * tiempo debajo, que es exactamente el comportamiento de ayer.
 */
import {
  atenderAviso,
  escucharCambiosDeWidget,
  TEMA_DE_WIDGET_CAMBIADO,
} from "../suscripcion-a-cambios-de-widget";
import {
  guardarConfiguracionDeWidget,
  leerConfiguracionDeWidget,
  limpiarCacheDeConfiguracionDeWidget,
} from "../widget-config.cache";

const CONFIG = {
  widgetId: "w-1",
  agentId: "a-1",
  organizationId: "org-1",
  active: true,
  leadsEnabled: true,
  contactFormUrl: null,
  allowedDomains: [] as string[],
  domainBlockingEnabled: false,
};

function aviso(widgetId: string): string {
  return JSON.stringify({
    event: TEMA_DE_WIDGET_CAMBIADO,
    timestamp: new Date().toISOString(),
    data: { widgetId },
  });
}

describe("SPEC-262 · escuchar que un widget cambió", () => {
  beforeEach(() => limpiarCacheDeConfiguracionDeWidget());

  it("el aviso hace olvidar", () => {
    guardarConfiguracionDeWidget("w-1", CONFIG);

    atenderAviso(aviso("w-1"));

    expect(leerConfiguracionDeWidget("w-1")).toBeNull();
  });

  it("olvida también lo guardado bajo el identificador del agente", () => {
    guardarConfiguracionDeWidget("a-1", CONFIG);

    atenderAviso(aviso("w-1"));

    expect(leerConfiguracionDeWidget("a-1")).toBeNull();
  });

  it("un aviso de otro widget no borra el que no toca", () => {
    guardarConfiguracionDeWidget("w-1", CONFIG);

    atenderAviso(aviso("w-2"));

    expect(leerConfiguracionDeWidget("w-1")).toEqual(CONFIG);
  });

  it("un aviso que no se entiende deja lo memorizado como estaba", () => {
    guardarConfiguracionDeWidget("w-1", CONFIG);

    atenderAviso("{esto no es json");

    expect(leerConfiguracionDeWidget("w-1")).toEqual(CONFIG);
  });

  it("un aviso sin identificador tampoco borra nada", () => {
    // Borrar por un mensaje corrupto sería adivinar.
    guardarConfiguracionDeWidget("w-1", CONFIG);

    atenderAviso(JSON.stringify({ event: TEMA_DE_WIDGET_CAMBIADO, data: {} }));

    expect(leerConfiguracionDeWidget("w-1")).toEqual(CONFIG);
  });

  it("se suscribe al tema con una conexión propia", async () => {
    const suscriptor = { connect: vi.fn(), subscribe: vi.fn(), on: vi.fn() };

    await escucharCambiosDeWidget(() => suscriptor as never);

    expect(suscriptor.connect).toHaveBeenCalled();
    expect(suscriptor.subscribe).toHaveBeenCalledWith(
      TEMA_DE_WIDGET_CAMBIADO,
      expect.any(Function)
    );
  });

  it("lo que llega por la suscripción se atiende", async () => {
    guardarConfiguracionDeWidget("w-1", CONFIG);
    let entregar: ((mensaje: string) => void) | undefined;
    const suscriptor = {
      connect: vi.fn(),
      on: vi.fn(),
      subscribe: vi.fn((_tema: string, cb: (mensaje: string) => void) => {
        entregar = cb;
      }),
    };

    await escucharCambiosDeWidget(() => suscriptor as never);
    entregar?.(aviso("w-1"));

    expect(leerConfiguracionDeWidget("w-1")).toBeNull();
  });

  it("si no se puede suscribir, no revienta: se sigue con el vencimiento", async () => {
    const roto = () => {
      throw new Error("redis no está");
    };

    await expect(escucharCambiosDeWidget(roto as never)).resolves.toBe(false);
  });
});
