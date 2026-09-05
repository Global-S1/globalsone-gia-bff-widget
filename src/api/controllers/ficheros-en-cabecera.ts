import {
  RESERVA_POR_CABECERA,
  codificarParaCabecera,
} from "./apartados-en-cabecera";

/**
 * SPEC-188 · RF-022 · ADR-035 — cómo llegan al navegador los ficheros que el
 * agente apartó.
 *
 * La hermana de `Chat-Photos`, y por la misma razón: el cuerpo de
 * `POST /v1/chat/create-chat` es el texto que lee quien escribe, tal cual, así
 * que lo que no sea ese texto se le pintaría dentro del globo del mensaje.
 *
 * Lo que viaja **no son los bytes ni el identificador del documento**: es el
 * título con el que el tenant lo dio de alta y la llave con la que se piden sus
 * bytes al proxy (SPEC-186 · SPEC-187). Con el identificador interno, cualquiera
 * que lo tuviera se descargaría el recurso de cualquier tenant; ésa es toda la
 * razón de que la llave exista.
 *
 * El peso no viaja: aquí sólo se sabría descargando el fichero entero, y eso no
 * se hace para pintar un bloque (RF-022).
 */

/**
 * El nombre literal de la cabecera. **El widget construye contra esto**, así
 * que se declara una vez y se exporta: el CORS de `server.ts` y quien la pone
 * leen el mismo valor.
 */
export const CABECERA_DE_FICHEROS = "Chat-Files";

/** Lo que ms-leads devuelve de cada fichero apartado (SPEC-186). */
export interface FicheroApartado {
  readonly titulo: string;
  readonly llave: string;
}

/**
 * La forma de una llave (SPEC-186): 256 bits en `base64url`, 43 caracteres.
 *
 * La misma que comprueba el proxy antes de preguntar por ella. Ofrecer una
 * llave con otra forma es ofrecer un enlace que ya sabemos que va a dar 404, y
 * un enlace muerto en la conversación no se distingue de una avería.
 */
const FORMA_DE_LA_LLAVE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Un fichero que se le puede ofrecer a quien escribe, o nada.
 *
 * Hacen falta las dos cosas. Sin llave no hay de dónde bajarlo; **sin título no
 * hay bloque que pintar** (SPEC-189) y quedaría un enlace mudo, que es peor que
 * no ofrecerlo.
 *
 * El título va **entero y tal cual**: es lo que el tenant escribió y lo que va a
 * leer quien conversa. No se recorta ni se transliteran sus acentos — para eso
 * está el base64.
 */
function ficheroQueSePuedeOfrecer(fichero: unknown): FicheroApartado | null {
  if (typeof fichero !== "object" || fichero === null) return null;
  const { titulo, llave } = fichero as { titulo?: unknown; llave?: unknown };
  if (typeof titulo !== "string" || titulo.trim() === "") return null;
  if (typeof llave !== "string" || !FORMA_DE_LA_LLAVE.test(llave)) return null;
  return { titulo, llave };
}

/**
 * Los ficheros listos para la cabecera, o `null` cuando no hay ninguno que
 * ofrecer.
 *
 * El parámetro acepta `undefined` a propósito. ms-leads garantiza el campo
 * `ficheros` siempre presente y vacío cuando no hay ninguno (SPEC-186,
 * verificado en su `orquestador.ts`), pero durante la ventana de despliegue en
 * que este servicio ya esté arriba y el suyo todavía no, lo que llega es
 * `undefined` — y eso tiene que ser «sin ficheros», no una excepción que deje
 * mudo al visitante.
 */
export function codificarFicheros(
  ficheros: readonly unknown[] | undefined,
  tope: number = RESERVA_POR_CABECERA
): string | null {
  const ofrecibles: FicheroApartado[] = [];
  for (const fichero of ficheros ?? []) {
    const ofrecible = ficheroQueSePuedeOfrecer(fichero);
    if (ofrecible !== null) ofrecibles.push(ofrecible);
  }
  return codificarParaCabecera(ofrecibles, tope);
}
