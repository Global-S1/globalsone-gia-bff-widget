/**
 * SPEC-183 · RF-021 · ADR-035 — cómo llegan al navegador las fotos que el
 * agente señaló.
 *
 * **No pueden ir en el cuerpo.** El cuerpo de `POST /v1/chat/create-chat` es el
 * texto que lee quien escribe, tal cual: cualquier cosa que se meta ahí se le
 * pinta dentro del globo del mensaje. Y el cuerpo no pasa a JSON porque eso
 * tocaría la etiqueta que los tenants tienen pegada en su web y rompería el
 * camino de streaming de los agentes que no clasifican leads.
 *
 * Así que van **fuera del cuerpo**, en una cabecera de la respuesta —el mismo
 * mecanismo por el que ya viaja `Contact-Form-Url`— y declarada en el CORS
 * (`server.ts`): una cabecera que no se expone existe y es invisible desde el
 * script del widget.
 *
 * **Van codificadas, y no por adorno.** Son varias direcciones en un solo
 * valor, y eso plantea dos problemas que se resuelven de una vez:
 *
 *   · **El separador.** Una coma o un espacio obligan a prometer que ninguna
 *     dirección los lleva dentro, y una dirección de catálogo puede llevar
 *     ambos. Un array JSON no necesita esa promesa.
 *   · **El juego de caracteres.** Una cabecera HTTP sólo admite latin-1: Node
 *     **rechaza la respuesta entera** si se le pone una «ñ» o una «á», y la
 *     ruta de un catálogo en español las lleva casi siempre.
 *
 * Base64 de un array JSON deja el valor en ASCII imprimible, que es lo único
 * que hace falta garantizar. Es exactamente lo que ya hace `codificarAdjuntos`
 * en ms-agents (SPEC-084) para el mismo problema, y por eso la cabecera se
 * llama como su hermana: `Chat-Resources` allí, `Chat-Photos` aquí.
 *
 * Desde SPEC-188 **la codificación y el tope no viven aquí**: los comparte con
 * `Chat-Files`, porque el límite que importa nunca fue el de una cabecera sino
 * el del bloque entero. Ver `apartados-en-cabecera.ts`.
 */
import {
  RESERVA_POR_CABECERA,
  codificarParaCabecera,
} from "./apartados-en-cabecera";

/**
 * El nombre literal de la cabecera. **El widget construye contra esto**, así
 * que se declara una vez y se exporta: el CORS de `server.ts` y quien la pone
 * leen el mismo valor, y no puede haber dos nombres que se separen con el
 * tiempo.
 */
export const CABECERA_DE_FOTOS = "Chat-Photos";

/**
 * Una dirección que se le puede entregar al navegador, normalizada, o nada.
 *
 * **Sólo `http` y `https`.** Esto acaba dentro de una página que no
 * controlamos: un `javascript:` ahí sería código ejecutándose en el sitio del
 * cliente de nuestro cliente, y un `data:` una carga útil que nadie miró.
 *
 * ms-leads ya es **más estricto** —sólo deja pasar `https`, porque un `http:`
 * es contenido mixto que el navegador bloquea sin decir por qué— y no se
 * relaja aquí: esta es la segunda puerta, y cubre lo que entrara antes de que
 * existiera la primera. Cuesta cuatro líneas.
 *
 * Se devuelve `href` y no el original: el analizador normaliza y quita los
 * caracteres de control que el original podría llevar dentro.
 */
function direccionQueSePuedeEntregar(direccion: unknown): string | null {
  if (typeof direccion !== "string" || direccion.trim() === "") return null;
  try {
    const analizada = new URL(direccion);
    if (analizada.protocol !== "http:" && analizada.protocol !== "https:") {
      return null;
    }
    return analizada.href;
  } catch {
    // Lo que no es una dirección no se entrega, y no arrastra a las demás.
    return null;
  }
}

/**
 * Las fotos listas para ponerse en la cabecera, o `null` cuando no hay ninguna
 * que entregar.
 *
 * `null` y no una cadena vacía: una cabecera vacía obligaría a quien la lee a
 * distinguir «no hay fotos» de «no la entiendo». Es la misma regla que ya
 * siguen `Contact-Form-Url` aquí y `Chat-Resources` en ms-agents.
 *
 * **Una lista que no quepa no rompe la respuesta**: se entregan las que quepan
 * y el texto sale igual. Se recorta **por el final** y nunca se reordena,
 * porque el texto del agente habla de las fotos por su orden (RF-021): mover
 * una cambiaría lo que dice el mensaje sin tocar el mensaje.
 *
 * El parámetro llega como `readonly string[] | undefined` a propósito. ms-leads
 * garantiza el campo `fotos` siempre presente y vacío cuando no hay ninguna
 * (SPEC-182, verificado en su `orquestador.ts`), pero durante la ventana de
 * despliegue en la que este servicio ya esté arriba y el suyo todavía no, lo
 * que llega es `undefined` — y eso tiene que ser «sin fotos», no una excepción
 * que deje mudo al visitante.
 */
export function codificarFotos(
  fotos: readonly string[] | undefined,
  tope: number = RESERVA_POR_CABECERA
): string | null {
  const entregables: string[] = [];
  for (const foto of fotos ?? []) {
    const direccion = direccionQueSePuedeEntregar(foto);
    if (direccion !== null) entregables.push(direccion);
  }
  return codificarParaCabecera(entregables, tope);
}
