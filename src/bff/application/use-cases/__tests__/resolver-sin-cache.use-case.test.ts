// Importados explícitamente, no por `globals: true`: el tsconfig de este repo
// restringe typeRoots, así que "vitest/globals" no resuelve como tipo.
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SPEC-262 · ADR-044 — la configuración se pregunta siempre.
 *
 * La caché de SPEC-167 existe por el camino de mensajes: una consulta por cada
 * mensaje de cada visitante. La ruta de configuración de SPEC-259 reutilizó
 * esta misma función y heredó una memoria pensada para un tráfico que ella no
 * tiene — se pide **una vez por carga de página**, antes del primer mensaje.
 *
 * Lo que se sujeta aquí son las dos mitades: **ni la lee ni la siembra.** Si
 * leyera, se serviría viejo. Si sembrara, una visita que sólo carga la página
 * dejaría al camino de mensajes una copia que nadie encargó.
 */

const getWidgetConfig = vi.fn();

vi.mock("../../../infrastructure/service-clients/agents-service.client", () => ({
  getAgentsServiceClient: () => ({ getWidgetConfig }),
}));

import { resolverWidget } from "../widget-config.use-case";
import {
  leerConfiguracionDeWidget,
  limpiarCacheDeConfiguracionDeWidget,
} from "../../../infrastructure/cache/widget-config.cache";

const CONFIG = {
  widgetId: "w-1",
  agentId: "a-1",
  organizationId: "org-1",
  active: true,
  leadsEnabled: true,
  contactFormUrl: null,
  allowedDomains: [] as string[],
  domainBlockingEnabled: false,
  topeDeCaracteres: 500,
};

const CONTEXTO = { correlationId: "c-1", timestamp: new Date() };

describe("SPEC-262 · resolver sin caché", () => {
  beforeEach(() => {
    limpiarCacheDeConfiguracionDeWidget();
    getWidgetConfig.mockReset();
    getWidgetConfig.mockResolvedValue({ success: true, statusCode: 200, data: CONFIG });
  });

  it("vuelve a preguntar aunque se acabe de preguntar", async () => {
    await resolverWidget("w-1", CONTEXTO, { sinCache: true });
    await resolverWidget("w-1", CONTEXTO, { sinCache: true });

    expect(getWidgetConfig).toHaveBeenCalledTimes(2);
  });

  it("no deja sembrada la caché del camino de mensajes", async () => {
    await resolverWidget("w-1", CONTEXTO, { sinCache: true });

    expect(leerConfiguracionDeWidget("w-1")).toBeNull();
  });

  it("ignora lo que ya hubiera memorizado", async () => {
    // El camino de mensajes memorizó un tope viejo…
    await resolverWidget("w-1", CONTEXTO);
    getWidgetConfig.mockResolvedValue({
      success: true,
      statusCode: 200,
      data: { ...CONFIG, topeDeCaracteres: 20 },
    });

    const resolucion = await resolverWidget("w-1", CONTEXTO, { sinCache: true });

    expect(resolucion).toEqual({
      tipo: "resuelto",
      config: { ...CONFIG, topeDeCaracteres: 20 },
    });
  });

  it("sin pedirlo, el camino de siempre sigue memorizando", async () => {
    await resolverWidget("w-1", CONTEXTO);
    await resolverWidget("w-1", CONTEXTO);

    expect(getWidgetConfig).toHaveBeenCalledTimes(1);
  });
});
