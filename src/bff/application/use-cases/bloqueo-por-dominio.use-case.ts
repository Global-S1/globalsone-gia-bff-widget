import { dominioDelOrigen } from "../../domain/dominio-del-origen";

/**
 * SPEC-196 · RF-025 · ADR-038 — atender sólo desde lo registrado.
 *
 * **Se decide aquí dentro y nunca con CORS.** Si se rechazara en el borde, el
 * navegador cortaría la petición antes de que la página pudiera leer nada y el
 * visitante vería un widget roto en vez de la frase — y entregar esa frase es
 * el objetivo entero. Por eso el CORS se queda abierto y la decisión se toma
 * después de resolver, con una respuesta normal y **sin llamar al modelo**, que
 * es el gasto que se quería evitar.
 *
 * Función pura: decide, no contesta. Cómo se le dice a quien escribe es del
 * controlador, que es quien tiene delante una página que no controlamos.
 *
 * **Qué protege y qué no**: el origen sólo es de fiar cuando quien llama es un
 * navegador —la página no puede falsificarlo— y no cuando llama un servidor,
 * que puede poner el que quiera o ninguno. Esto corta el uso indebido *casual*,
 * que es el que se pide cortar; contra quien se lo proponga siguen estando los
 * topes de cuota, y nada más.
 */
export type DecisionDeDominio = "se-atiende" | "no-autorizado";

/**
 * Lo que hace falta saber del widget para decidir. **Los dos campos llegan por
 * la red** (`GET /v1/widgets/:id/config`), así que se declaran como lo que son
 * ahí —puede que no vengan— y no como lo que el contrato promete.
 */
interface LoDeclaradoPorElTenant {
  readonly allowedDomains?: readonly string[];
  readonly domainBlockingEnabled?: boolean;
}

export function decidirPorDominio(
  widget: LoDeclaradoPorElTenant,
  origen: string | undefined
): DecisionDeDominio {
  if (widget.domainBlockingEnabled !== true) return "se-atiende";

  const declarados = dominiosDeclarados(widget.allowedDomains);
  // **Encendido y sin lista no bloquea nada.** Si no, crear un widget lo
  // dejaría muerto hasta que alguien se acordara de registrar su dominio. Y
  // vale lo mismo para una lista que no llegó: apagarle el widget a un tenant
  // por no saber contra qué comparar es el peor de los dos errores posibles.
  if (declarados.length === 0) return "se-atiende";

  // **Sin origen no se atiende.** En esta llamada un navegador siempre lo
  // manda, así que su ausencia significa que quien llama no es una página. Un
  // `Origin: null` —un iframe con arenero, un fichero local— cae aquí también:
  // es sin origen, no un dominio llamado `null`.
  const dominio = dominioDelOrigen(origen);
  if (dominio === null) return "no-autorizado";

  // Igualdad exacta y no sufijo: **no hay comodines de subdominio**, que es una
  // decisión que ADR-038 dejó abierta y que no se inventa aquí.
  return declarados.includes(dominio) ? "se-atiende" : "no-autorizado";
}

/**
 * La lista tal y como se puede comparar.
 *
 * Llega ya normalizada de ms-agents (SPEC-205), así que esto no vuelve a
 * normalizar: sólo se defiende de que el otro lado mande algo que no sea una
 * cadena, porque una lista rota no puede tumbar la respuesta de quien escribe.
 * El recorte y las minúsculas son idempotentes sobre lo que el contrato promete
 * y baratos sobre lo que no.
 */
function dominiosDeclarados(lista: readonly string[] | undefined): string[] {
  if (!Array.isArray(lista)) return [];
  return lista
    .filter((d): d is string => typeof d === "string")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d !== "");
}
