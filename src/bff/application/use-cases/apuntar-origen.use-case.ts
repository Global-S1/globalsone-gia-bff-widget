import { IRequestContext } from "../../domain/interfaces/request-context.interface";
import { getAgentsServiceClient } from "../../infrastructure/service-clients/agents-service.client";
import { logger } from "../../../entities/shared/infraestructure/utils/logger";

/**
 * SPEC-195 · RF-025 · ADR-038 — desde qué dominio se carga cada widget.
 *
 * Responde las dos preguntas que hoy no tienen respuesta —si un embed sigue
 * vivo y dónde está— **a partir de la llamada que el widget ya hace**: nadie
 * tiene que declarar nada y no se sale a rastrear páginas ajenas. Y se observa
 * **antes** de bloquear: el panel enseña desde dónde se carga de verdad, que no
 * siempre es lo que el tenant declaró —subdominios, entornos de pruebas,
 * previsualizaciones de su hosting—, porque encender el bloqueo sin ese dato es
 * apagarle el widget a un cliente por un dominio mal escrito.
 *
 * **Comprobado por construcción que el `Origin` llega hasta aquí** (SPEC-195):
 * el bloque `location /v1/widget/` del gateway se ejecutó contra un upstream
 * que devuelve lo que recibe, y la cabecera pasa intacta. No se supuso.
 *
 * **Qué protege y qué no**, dicho aquí para que nadie lo confunda: el origen
 * sólo es de fiar cuando quien llama es un navegador —la página no puede
 * falsificarlo— y no cuando llama un servidor, que puede poner el que quiera o
 * ninguno. Esto sirve para ver el uso indebido casual, que es el que se pide
 * ver.
 */

/** Lo que este proceso se ahorra volver a preguntar, en milisegundos. */
const RATO = 15 * 60 * 1000;

/**
 * Lo ya apuntado por este proceso, por widget y dominio.
 *
 * **El freno de verdad NO vive aquí: vive en ms-agents** (SPEC-202), que es el
 * único que sabe cuándo se escribió por última vez y el único que puede
 * garantizarlo con varias réplicas por delante. Esto sólo ahorra la llamada
 * cuando ya sabemos la respuesta, que es lo que evita convertir una lectura
 * barata en una petición por visita.
 *
 * Por eso puede desalinearse con el de allá sin consecuencias: si este proceso
 * se equivoca de menos, ms-agents frena; si se equivoca de más, se pierde una
 * anotación de un dominio que ya constaba.
 *
 * **Un dominio que no constaba nunca se frena**, ni aquí ni allá: es justo la
 * señal que se quiere ver, y sale de que la clave lleve el dominio dentro.
 */
const apuntados = new Map<string, number>();

/** Vacía lo recordado. Existe para las pruebas: en marcha nadie la invalida. */
export function olvidarOrigenesApuntados(): void {
  apuntados.clear();
}

/**
 * El dominio de un origen, en minúsculas, o nada.
 *
 * **Sólo el dominio**: ni la dirección completa, ni el camino, ni lo que traiga
 * pegado, ni el puerto. Lo que sale de este servicio es lo que se va a guardar
 * (SPEC-195), y una lista de dominios con una consulta dentro sería a la vez
 * inútil para el panel y un sitio donde acaban datos que nadie pidió.
 *
 * Admite un origen completo o un dominio pelado, igual que la ruta que lo
 * recibe. Y descarta `null`, que es lo que manda un navegador con un origen
 * opaco —un iframe con `sandbox`, un fichero local—: apuntarlo ensuciaría con
 * una entrada sin significado la lista que el tenant mira antes de encender el
 * bloqueo.
 */
export function dominioDelOrigen(origen: string | undefined): string | null {
  if (typeof origen !== "string") return null;
  const limpio = origen.trim();
  if (limpio === "" || limpio === "null") return null;

  const candidato = /^[a-z][a-z0-9+.-]*:\/\//i.test(limpio)
    ? limpio
    : `https://${limpio}`;

  try {
    const { hostname } = new URL(candidato);
    return hostname === "" ? null : hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Apunta que este widget se cargó desde este origen.
 *
 * **No se espera y no puede lanzar.** Es una observación, no parte de
 * contestar: quien escribe está esperando su respuesta, y un tropiezo de
 * ms-agents o un milisegundo de más aquí no pueden tocarla. Por eso devuelve
 * `void` y no una promesa — devolverla invitaría a que alguien la esperase.
 */
export function apuntarOrigen(
  widgetId: string,
  origen: string | undefined,
  context: IRequestContext
): void {
  const dominio = dominioDelOrigen(origen);
  if (dominio === null) return;

  const clave = `${widgetId}|${dominio}`;
  const ahora = Date.now();
  const hasta = apuntados.get(clave);
  if (hasta !== undefined && ahora < hasta) return;

  // **Se apunta ANTES de llamar**, no después: si no, una ráfaga de mensajes
  // del mismo visitante dispara veinte llamadas antes de que vuelva la primera.
  apuntados.set(clave, ahora + RATO);

  void getAgentsServiceClient()
    .apuntarVisto(widgetId, dominio, context)
    .catch((error: unknown) => {
      // Se suelta el freno para que el mensaje siguiente reintente: si no, un
      // tropiezo de un segundo escondería el dominio durante todo el rato, y
      // un dominio nuevo es justo lo que interesa ver.
      apuntados.delete(clave);
      logger.warn("No se pudo apuntar el origen de un widget", {
        widgetId,
        dominio,
        error,
      });
    });
}
