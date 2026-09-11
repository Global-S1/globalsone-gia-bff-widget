import { codificarFicheros } from "./ficheros-en-cabecera";
import { codificarFotos } from "./fotos-en-cabecera";

/**
 * SPEC-253 · SPEC-255 · RF-033 — lo que el agente apartó, cuando la respuesta
 * viene por el camino corto.
 *
 * Por el camino de ms-leads, lo apartado llega dentro de un objeto ya masticado.
 * Por el corto llega en dos cabeceras de ms-agents —`Chat-Resources` y
 * `Chat-Photos`, base64 de un JSON— y hay que traducirlo a las dos cabeceras que
 * el widget ya sabe leer.
 *
 * **Una sola forma para el widget**, venga por donde venga: quien escribe no
 * puede notar por qué camino entró su mensaje.
 *
 * Nada de esto lanza. Una cabecera que no se entiende es «no había nada»: mejor
 * una respuesta sin adjuntos que ninguna respuesta.
 */

/** Lo que ms-agents pone en `Chat-Resources`: una entrada por fichero apartado. */
interface AdjuntoDeAgents {
  readonly id: string;
  readonly titulo: string;
}

function leerCabecera(valor: string | string[] | undefined): unknown[] {
  const crudo = Array.isArray(valor) ? valor[0] : valor;
  if (typeof crudo !== "string" || crudo === "") return [];
  try {
    const leido: unknown = JSON.parse(Buffer.from(crudo, "base64").toString("utf8"));
    return Array.isArray(leido) ? leido : [];
  } catch {
    return [];
  }
}

/**
 * Los ficheros, con la forma que el widget espera.
 *
 * `id` y no `llave`: desde ADR-043 el identificador no autoriza nada por sí
 * solo —quien autoriza es la sesión de la conversación— así que puede viajar a
 * la vista. Lo que llegue sin identificador o sin título no se ofrece: un bloque
 * cuyo enlace no puede pedir nada es peor que no ofrecerlo.
 */
export function ficherosDeLaCabecera(valor: string | string[] | undefined): string | null {
  const ofrecibles = leerCabecera(valor)
    .filter((entrada): entrada is AdjuntoDeAgents => {
      if (typeof entrada !== "object" || entrada === null) return false;
      const { id, titulo } = entrada as { id?: unknown; titulo?: unknown };
      return typeof id === "string" && id !== "" && typeof titulo === "string" && titulo.trim() !== "";
    })
    .map((entrada) => ({ titulo: entrada.titulo, id: entrada.id }));

  return codificarFicheros(ofrecibles);
}

/** Las fotos, que viajan como direcciones y nada más (RF-021). */
export function fotosDeLaCabecera(valor: string | string[] | undefined): string | null {
  const direcciones = leerCabecera(valor).filter(
    (url): url is string => typeof url === "string" && url !== "",
  );
  return codificarFotos(direcciones);
}
