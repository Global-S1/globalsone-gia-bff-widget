/**
 * El dominio de un origen, en minúsculas, o nada.
 *
 * **Sólo el dominio**: ni la dirección completa, ni el camino, ni lo que traiga
 * pegado, ni el puerto. Lo que sale de aquí es a la vez lo que se guarda como
 * observado (SPEC-195) y lo que se compara contra los dominios que el tenant
 * declaró (SPEC-196), y por eso vive en un módulo suyo y no dentro de ninguno
 * de los dos: **una función y no dos**. Dos copias empiezan iguales y acaban
 * decidiendo distinto sin que nada avise.
 *
 * ## La costura, dicha aquí porque es donde se rompería
 *
 * Los dominios declarados **se guardan ya normalizados en ms-agents**, por su
 * función `dominioDe` (`src/application/widgets/lo-observado.ts`, SPEC-205):
 * `https://Pepito.com/contacto?x=1` quedó guardado como `pepito.com`. Quien
 * compara —esto— tiene que dejar el `Origin` entrante en esa misma forma, y las
 * dos puntas viven en **repositorios distintos**: nada avisa el día que una
 * cambie. Si se separan, un tenant con el bloqueo encendido se queda fuera de
 * su propia web y el registro no dice por qué.
 *
 * Se parece a `dominioDe` en todo lo que decide la forma —analizador de URL y
 * no expresión regular, esquema y puerto fuera, minúsculas, IDN en punycode, y
 * se exige `http`/`https` para que `chrome-extension://x` no salga de aquí como
 * el dominio `x`— y **se aparta en una cosa a propósito**: `"null"` es nada.
 * Allá es un dominio llamado `null` (su hueco declarado, porque ADR-038 dejó
 * abierto qué hacer sin origen); aquí es lo que manda un navegador con un
 * origen opaco —un iframe con arenero, un fichero local—, y SPEC-196 dice que
 * eso cuenta como sin origen. La diferencia no separa a las dos puntas: sólo
 * hace que un origen opaco no case con nada, que es lo que se pide.
 *
 * Admite un origen completo o un dominio pelado, porque quien llama manda lo
 * que el navegador le dio y eso cambia según el caso.
 */
export function dominioDelOrigen(origen: string | undefined): string | null {
  if (typeof origen !== "string") return null;
  const limpio = origen.trim();
  if (limpio === "" || limpio === "null") return null;

  const candidato = /^[a-z][a-z0-9+.-]*:\/\//i.test(limpio)
    ? limpio
    : `https://${limpio}`;

  try {
    const { hostname, protocol } = new URL(candidato);
    // `javascript:alert(1)` parsea, así que no basta con que parsee: se exige
    // que sea una dirección web, igual que hace `dominioDe` en ms-agents.
    if (protocol !== "http:" && protocol !== "https:") return null;
    return hostname === "" ? null : hostname.toLowerCase();
  } catch {
    return null;
  }
}
