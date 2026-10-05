// Importados explícitamente, no por `globals: true`: el tsconfig de este repo
// restringe typeRoots, así que "vitest/globals" no resuelve como tipo.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";

/**
 * SPEC-259 · RF-034 — lo que un widget necesita saber de sí mismo antes del
 * primer mensaje.
 *
 * Hasta ahora no tenía de dónde aprender nada suyo, así que su tope de
 * caracteres estaba escrito a mano dentro del propio widget.
 *
 * Lo que se sujeta aquí es sobre todo lo que **no** hace: no dice si un widget
 * existe, no publica nada más que el tope, y cuando no lo sabe **no se inventa
 * un número** — porque este servicio no conoce el defecto de la casa y no debe
 * conocerlo.
 */

const resolverWidget = vi.fn();

vi.mock("../../../bff/application/use-cases/widget-config.use-case", () => ({
  resolverWidget: (...args: unknown[]) => resolverWidget(...args),
}));

// Import estático y no `await import`: el build de este repositorio compila
// también las pruebas, y su `module` no admite `await` de nivel superior. El
// doble de arriba lo iza vitest, así que no hace falta.
import { configuracionDelWidget } from "../configuracion.controller";

function peticion(widgetId = "w-1"): Request {
  return { params: { widgetId }, headers: {} } as unknown as Request;
}

/** Recoge lo que el controlador contesta. */
function respuesta() {
  const capturado = { codigo: 0, cuerpo: undefined as unknown };
  const res = {
    status(codigo: number) {
      capturado.codigo = codigo;
      return this;
    },
    json(cuerpo: unknown) {
      capturado.cuerpo = cuerpo;
      return this;
    },
  };
  return { capturado, res: res as never };
}

const resuelto = (config: Record<string, unknown>) => ({
  tipo: "resuelto",
  // Encendido y al día salvo que la prueba diga otra cosa, que es lo que
  // responde ms-agents de un widget normal.
  config: { active: true, organizacionSuspendida: false, ...config },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SPEC-259 · Un widget pregunta por lo suyo", () => {
  it("devuelve el tope que rige", async () => {
    resolverWidget.mockResolvedValue(resuelto({ topeDeCaracteres: 500 }));
    const { capturado, res } = respuesta();

    await configuracionDelWidget(peticion(), res);

    expect(capturado.codigo).toBe(200);
    expect(capturado.cuerpo).toEqual({ topeDeCaracteres: 500, disponible: true });
  });

  it("sin tope propio contesta el de la casa, ya resuelto por quien lo sabe", async () => {
    // ms-agents resuelve el nulo antes de publicarlo, así que aquí llega un
    // número y el widget no tiene que distinguir nada.
    resolverWidget.mockResolvedValue(resuelto({ topeDeCaracteres: 90 }));
    const { capturado, res } = respuesta();

    await configuracionDelWidget(peticion(), res);

    expect(capturado.cuerpo).toEqual({ topeDeCaracteres: 90, disponible: true });
  });

  it("un widget que no existe no dice que no existe", async () => {
    resolverWidget.mockResolvedValue({ tipo: "no-existe" });
    const { capturado, res } = respuesta();

    await configuracionDelWidget(peticion("inventado"), res);

    expect(capturado.codigo).toBe(200);
    expect(capturado.cuerpo).toEqual({});
  });

  it("y no se distingue de un fallo pasajero", async () => {
    // Distinguirlos convertiría esta ruta en un enumerador de widgets ajenos.
    resolverWidget.mockResolvedValue({ tipo: "no-existe" });
    const noExiste = respuesta();
    await configuracionDelWidget(peticion("inventado"), noExiste.res);

    resolverWidget.mockResolvedValue({ tipo: "no-se-sabe" });
    const fallo = respuesta();
    await configuracionDelWidget(peticion("w-1"), fallo.res);

    expect(fallo.capturado).toEqual(noExiste.capturado);
  });

  it("si el servicio de dentro no contesta, el campo no viaja", async () => {
    // Ni un error ni un número inventado: el defecto lo sabe ms-agents y lo
    // trae el widget como valor de arranque. Una tercera copia sería la que
    // nadie actualiza.
    resolverWidget.mockResolvedValue({ tipo: "no-se-sabe" });
    const { capturado, res } = respuesta();

    await configuracionDelWidget(peticion(), res);

    expect(capturado.codigo).toBe(200);
    expect(capturado.cuerpo).toEqual({});
  });

  it("un ms-agents que todavía no publique el tope tampoco lo inventa", async () => {
    resolverWidget.mockResolvedValue(resuelto({ agentId: "a-1" }));
    const { capturado, res } = respuesta();

    await configuracionDelWidget(peticion(), res);

    // El tope no se inventa; la disponibilidad sí se sabe y por eso viaja.
    expect(capturado.cuerpo).toEqual({ disponible: true });
  });

  it("una organización suspendida sale como no disponible, sin decir por qué", async () => {
    /*
     * Delante está el cliente de nuestro cliente. No sabe que existe una
     * suscripción y no tiene por qué enterarse de una deuda ajena: un solo
     * booleano, sin motivo.
     */
    resolverWidget.mockResolvedValue(
      resuelto({ topeDeCaracteres: 500, organizacionSuspendida: true }),
    );
    const { capturado, res } = respuesta();

    await configuracionDelWidget(peticion(), res);

    expect(capturado.cuerpo).toEqual({ topeDeCaracteres: 500, disponible: false });
    expect(JSON.stringify(capturado.cuerpo)).not.toMatch(/suspend|pago|deuda/i);
  });

  it("un widget que el cliente apagó también sale como no disponible", async () => {
    // Desde delante son lo mismo: no se puede hacer nada y no corresponde
    // saber cuál de los dos motivos es.
    resolverWidget.mockResolvedValue(resuelto({ topeDeCaracteres: 500, active: false }));
    const { capturado, res } = respuesta();

    await configuracionDelWidget(peticion(), res);

    expect(capturado.cuerpo).toEqual({ topeDeCaracteres: 500, disponible: false });
  });

  it("no se publica nada más", async () => {
    // Ni el token de la organización, ni el agente, ni los dominios: nada de
    // eso hace falta para pintar una caja de texto.
    resolverWidget.mockResolvedValue(
      resuelto({
        topeDeCaracteres: 500,
        agentId: "a-1",
        organizationId: "org-1",
        allowedDomains: ["acme.example"],
        leadsEnabled: true,
      }),
    );
    const { capturado, res } = respuesta();

    await configuracionDelWidget(peticion(), res);

    expect(Object.keys(capturado.cuerpo as object)).toEqual(["topeDeCaracteres", "disponible"]);
  });

  /*
   * SPEC-262 · ADR-044 — **se pregunta siempre.** Esta ruta se pide una vez
   * por carga de página, no una por mensaje: no tiene por qué pagar la espera
   * que la caché del camino caliente impone, ni servirle al tenant lo que él
   * mismo acaba de cambiar.
   */
  it("resuelve sin pasar por la caché", async () => {
    resolverWidget.mockResolvedValue({
      tipo: "resuelto",
      config: { topeDeCaracteres: 500 },
    });

    await configuracionDelWidget(peticion("w-1"), respuesta().res);

    expect(resolverWidget).toHaveBeenCalledWith(
      "w-1",
      expect.anything(),
      { sinCache: true }
    );
  });
});
