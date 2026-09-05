/**
 * SPEC-183 · SPEC-188 — el presupuesto que comparten las cabeceras de lo que el
 * agente aparta, y la codificación que usan las dos.
 *
 * ## Por qué esto vive en un sitio y no copiado en dos
 *
 * Con las fotos había **una** cabecera que podía crecer. Con los ficheros hay
 * **dos**, y el límite que de verdad importa nunca fue el de una: es el bloque
 * ENTERO de cabeceras de la respuesta. Dos topes independientes en dos ficheros
 * se suman sin que nadie lo vea, y el 502 sólo aparece el día que coinciden un
 * turno con muchas fotos y muchos ficheros — que es justo el turno bueno.
 *
 * Así que el presupuesto es un número, en un sitio, con una prueba que dice que
 * las reservas caben dentro.
 */

/**
 * Lo que pueden ocupar, **entre todas**, las cabeceras de lo apartado.
 *
 * No es prudencia genérica. Entre este servicio y el navegador hay un nginx
 * (`api-gateway/conf.d/widget.conf`) que lee la cabecera de la respuesta dentro
 * de `proxy_buffer_size`, que ahí no está tocado y por tanto vale su valor por
 * defecto: 4 KB. Si el bloque se pasa, nginx **no recorta**: tira la respuesta
 * y devuelve un 502, y quien escribe se queda **sin el texto** por culpa de un
 * adjunto. `proxy_buffering off` no ayuda: eso afecta al cuerpo, no a esto.
 *
 * 2000 deja la otra mitad del búfer para la línea de estado, lo nuestro
 * —`Content-Type`, `Cache-Control`, `Contact-Form-Url`, `X-Correlation-ID`— y
 * lo que añade el propio nginx, con margen de sobra.
 */
export const PRESUPUESTO_DE_CABECERAS = 2000;

/**
 * Lo que puede ocupar **cada** cabecera.
 *
 * Reservas fijas y no un reparto por orden de llegada, y es una decisión con
 * consecuencias: quien pida primero no puede quedarse con todo. Un turno con
 * quince fotos apagaría en silencio el fichero que el agente acaba de prometer,
 * y ese silencio es indistinguible de una avería para quien lo lee.
 *
 * El precio es que una cabecera no puede usar lo que a la otra le sobra. Se
 * paga a gusto: 1000 caracteres son del orden de una decena de fotos o de
 * ficheros, y el tope por turno de verdad vive en ms-agents (RF-021 · RF-022),
 * que es quien decide cuántos aparta el agente. Aquí no se inventa otro.
 */
export const RESERVA_POR_CABECERA = PRESUPUESTO_DE_CABECERAS / 2;

/**
 * Una lista lista para ponerse en una cabecera, o `null` si no queda nada.
 *
 * **Va codificada, y no por adorno.** Una cabecera HTTP sólo admite latin-1:
 * Node **rechaza la respuesta entera** si se le pone una «ñ» o una «á». En las
 * fotos eso era la ruta de un catálogo en español; en los ficheros es el título
 * que escribió el tenant, así que «Catálogo de otoño» es el caso normal. Base64
 * de un JSON lo deja en ASCII imprimible y, de paso, quita el problema del
 * separador: una lista JSON no tiene que prometer que ningún valor lleva dentro
 * la coma o el espacio con que se habría separado.
 *
 * Es lo mismo que ya hace `codificarAdjuntos` en ms-agents (SPEC-084).
 *
 * `null` y no una cadena vacía: una cabecera vacía obligaría a quien la lee a
 * distinguir «no hay nada» de «no la entiendo».
 *
 * **Lo que no quepa se recorta por el final y nunca se reordena**: el texto del
 * agente habla de lo apartado por su orden, así que mover algo cambiaría lo que
 * dice el mensaje sin tocar el mensaje. Y si no cabe ni el primero, no hay
 * cabecera: mejor sin adjuntos que sin respuesta.
 */
export function codificarParaCabecera<T>(
  elementos: readonly T[],
  tope: number
): string | null {
  if (elementos.length === 0) return null;

  let caben = elementos;
  let valor = codificar(caben);
  while (caben.length > 0 && valor.length > tope) {
    caben = caben.slice(0, -1);
    valor = codificar(caben);
  }

  return caben.length === 0 ? null : valor;
}

/** Base64 es ASCII por construcción, así que su longitud son sus bytes. */
function codificar<T>(elementos: readonly T[]): string {
  return Buffer.from(JSON.stringify(elementos), "utf8").toString("base64");
}
