import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  guardarConfiguracionDeWidget,
  leerConfiguracionDeWidget,
  limpiarCacheDeConfiguracionDeWidget,
  olvidarWidget,
} from "../widget-config.cache";

const CONFIG = {
  widgetId: "w-1",
  agentId: "a-1",
  organizationId: "org-1",
  active: true,
  leadsEnabled: true,
  contactFormUrl: null,
  // SPEC-205: los dos van siempre en la respuesta interna, y `allowedDomains`
  // también cuando está vacía. Se guardan con el resto: quien decide bloquear
  // lee de aquí, y sin ellos la caché serviría una configuración incompleta.
  allowedDomains: [] as string[],
  domainBlockingEnabled: false,
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

  it("no confunde dos identificadores", () => {
    guardarConfiguracionDeWidget("a-1", CONFIG);
    expect(leerConfiguracionDeWidget("a-2")).toBeNull();
  });

  it("caduca: un interruptor que el tenant apaga acaba notándose", () => {
    guardarConfiguracionDeWidget("a-1", CONFIG);
    // El TTL por defecto son 300 s (BFF_CACHE_DEFAULT_TTL).
    vi.advanceTimersByTime(301_000);
    expect(leerConfiguracionDeWidget("a-1")).toBeNull();
  });

  /*
   * SPEC-262 · ADR-044 — el olvido por aviso.
   *
   * Hasta aquí la única forma de dejar de servir algo viejo era esperar a que
   * venciera. El aviso de SPEC-261 llega con el identificador del widget, y lo
   * que hay que borrar puede estar guardado bajo dos claves: la caché se indexa
   * por «el identificador tal como llegó», que puede ser el del widget o el de
   * su agente (ADR-037).
   */
  describe("olvidar por aviso", () => {
    it("borra lo guardado bajo el identificador del widget", () => {
      guardarConfiguracionDeWidget("w-1", CONFIG);

      olvidarWidget("w-1");

      expect(leerConfiguracionDeWidget("w-1")).toBeNull();
    });

    it("borra también lo guardado bajo el identificador de su agente", () => {
      guardarConfiguracionDeWidget("a-1", CONFIG);

      olvidarWidget("w-1");

      expect(leerConfiguracionDeWidget("a-1")).toBeNull();
    });

    it("borra las dos claves del mismo widget a la vez", () => {
      guardarConfiguracionDeWidget("w-1", CONFIG);
      guardarConfiguracionDeWidget("a-1", CONFIG);

      olvidarWidget("w-1");

      expect(leerConfiguracionDeWidget("w-1")).toBeNull();
      expect(leerConfiguracionDeWidget("a-1")).toBeNull();
    });

    it("no toca lo que no es de ese widget", () => {
      const OTRO = { ...CONFIG, widgetId: "w-2", agentId: "a-2" };
      guardarConfiguracionDeWidget("w-1", CONFIG);
      guardarConfiguracionDeWidget("w-2", OTRO);

      olvidarWidget("w-1");

      expect(leerConfiguracionDeWidget("w-2")).toEqual(OTRO);
    });

    it("olvidar algo que no estaba no es un fallo", () => {
      expect(() => olvidarWidget("w-9")).not.toThrow();
    });
  });
});
