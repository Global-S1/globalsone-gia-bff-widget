import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  guardarConfiguracionDeWidget,
  leerConfiguracionDeWidget,
  limpiarCacheDeConfiguracionDeWidget,
} from "../widget-config.cache";

const CONFIG = {
  agentId: "a-1",
  organizationId: "org-1",
  leadsEnabled: true,
  contactFormUrl: null,
};

describe("caché de la configuración de widget", () => {
  beforeEach(() => {
    limpiarCacheDeConfiguracionDeWidget();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("devuelve lo guardado sin volver a preguntar", () => {
    guardarConfiguracionDeWidget("a-1", CONFIG);
    expect(leerConfiguracionDeWidget("a-1")).toEqual(CONFIG);
  });

  it("no confunde dos agentes", () => {
    guardarConfiguracionDeWidget("a-1", CONFIG);
    expect(leerConfiguracionDeWidget("a-2")).toBeNull();
  });

  it("caduca: un interruptor que el tenant apaga acaba notándose", () => {
    guardarConfiguracionDeWidget("a-1", CONFIG);
    // El TTL por defecto son 300 s (BFF_CACHE_DEFAULT_TTL).
    vi.advanceTimersByTime(301_000);
    expect(leerConfiguracionDeWidget("a-1")).toBeNull();
  });
});
