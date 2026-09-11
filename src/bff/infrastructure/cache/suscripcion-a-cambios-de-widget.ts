import { createClient, RedisClientType } from "redis";
import { env } from "../../../entities/shared/infraestructure/config/environments";
import { logger } from "../../../entities/shared/infraestructure/utils/logger";
import { olvidarWidget } from "./widget-config.cache";

/**
 * SPEC-262 · SPEC-261 · ADR-044 — enterarse de que un widget cambió, en vez de
 * esperar a que la copia venza.
 *
 * Hasta aquí, un tenant que cambiaba algo en su panel veía su widget seguir
 * haciendo lo de antes hasta que el TTL caducaba. No son cinco minutos de
 * molestia: es que el panel deja de ser creíble, y quien ha visto una vez que
 * guardar no hace nada empieza a buscar el fallo donde no está.
 *
 * **El vencimiento no se quita.** Pasa de ser la única forma de estar al día a
 * ser la red por debajo: si Redis no está, si el aviso se pierde o si este
 * proceso acababa de arrancar, el peor caso vuelve a ser el de ayer.
 */

/** El tema que publica ms-agents (SPEC-261). */
export const TEMA_DE_WIDGET_CAMBIADO = "widget.updated";

/** Lo que `EventBus.publish` compone al otro lado. */
interface IAviso {
  readonly data?: { readonly widgetId?: unknown };
}

/**
 * **Un aviso que no se entiende se registra y se ignora.** No se vacía la
 * memoria «por si acaso»: borrar por un mensaje corrupto es adivinar, y
 * adivinar aquí significa mandar a todos los widgets a preguntar de nuevo por
 * un carácter mal puesto.
 */
export function atenderAviso(mensaje: string): void {
  let widgetId: unknown;
  try {
    widgetId = (JSON.parse(mensaje) as IAviso).data?.widgetId;
  } catch {
    logger.warn("Llegó un aviso de widget que no se pudo leer", { mensaje });
    return;
  }

  if (typeof widgetId !== "string" || widgetId === "") {
    logger.warn("Llegó un aviso de widget sin identificador", { mensaje });
    return;
  }

  olvidarWidget(widgetId);
}

/** Una conexión de Redis suscrita no atiende otras órdenes: hace falta la suya. */
function conexionPropia(): RedisClientType {
  const host = env.services.cache.redis?.host || "localhost";
  const port = process.env["REDIS_PORT"] || "6379";
  const url =
    host.startsWith("redis://") || host.startsWith("rediss://")
      ? host
      : `redis://${host}:${port}`;

  // Spread condicional, igual que en el cliente de caché: pasar
  // `password: undefined` haría que node-redis mandara AUTH igualmente, y un
  // Redis sin `requirepass` rechaza la conexión.
  return createClient({
    url,
    ...(process.env["REDIS_PASSWORD"] ? { password: process.env["REDIS_PASSWORD"] } : {}),
  }) as RedisClientType;
}

/**
 * Abre la escucha. Devuelve si quedó escuchando, **y no lanza nunca**: quedarse
 * sin aviso es perder inmediatez, no perder el servicio, y tumbar el arranque
 * del BFF por eso dejaría sin chat a todos los widgets para arreglarle el
 * retraso a uno.
 */
export async function escucharCambiosDeWidget(
  crearSuscriptor: () => RedisClientType = conexionPropia
): Promise<boolean> {
  try {
    const suscriptor = crearSuscriptor();
    suscriptor.on("error", (error: Error) => {
      logger.warn("La escucha de cambios de widget tropezó", { error: error.message });
    });
    await suscriptor.connect();
    await suscriptor.subscribe(TEMA_DE_WIDGET_CAMBIADO, atenderAviso);
    return true;
  } catch (error) {
    logger.warn("No se pudo escuchar los cambios de widget: rige el vencimiento", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
