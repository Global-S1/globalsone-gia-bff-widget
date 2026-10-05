import { DocumentsServiceClient } from "../clientes/documents.client";

/**
 * Uno de los ficheros de un recurso, tal como lo guarda ms-agents (SPEC-230).
 *
 * **Tiene identificador propio**, distinto del del recurso: enviar un recurso
 * aparta una entrada por fichero, y tres entradas con el mismo identificador
 * dejarían a quien las recibe sin saber cuál es cuál.
 */
export interface IFicheroDeRecurso {
  id: string;
  /** El identificador del fichero en ms-documents. Aquí no hay bytes. */
  documentServiceId: string;
}

/** Lo que ms-agents guarda de un recurso: su significado, no su fichero. */
export interface ISignificadoDeRecurso {
  id: string;
  title: string;
  intention: string;
  /**
   * SPEC-246 — los momentos en los que sale sin pasar por el modelo.
   *
   * **Opcional porque el contrato de ayer no lo traía**, y entonces ninguno
   * acompañaba a nada: un significado que llegue sin ella se compone vacía.
   */
  acompanaEn?: string[];
  /**
   * El primero de `ficheros`, o `null` cuando no le queda ninguno (SPEC-230).
   *
   * Ya no se guarda: ms-agents lo deriva de la lista en cada lectura. Se sigue
   * publicando a propósito, porque es lo que esta vista casa contra
   * ms-documents para marcar lo que falta.
   */
  documentServiceId: string | null;
  /**
   * Sus ficheros, en el orden en que se apartan.
   *
   * **Opcional porque el contrato de ayer no lo traía**: un significado que
   * llegue sin esta lista se compone como el único fichero que era.
   */
  ficheros?: IFicheroDeRecurso[];
}

/** Un fichero del recurso, con lo que ms-documents sabe de él pegado. */
export interface IFicheroVisto {
  id: string;
  documentServiceId: string;
  fileName: string | null;
  mimeType: string | null;
  fileSize: number | null;
  /** Este fichero en concreto ya no está. */
  falta: boolean;
}

/** Lo que ve una pantalla: el significado con los datos del fichero pegados. */
export interface IRecursoVisto {
  id: string;
  title: string;
  intention: string;
  /** SPEC-246 — siempre presente: la pantalla no distingue ausente de vacía. */
  acompanaEn: string[];
  fileName: string | null;
  mimeType: string | null;
  fileSize: number | null;
  /** El fichero ya no está. Se enseña para que se pueda entender y quitar. */
  falta: boolean;
  /**
   * SPEC-231 — **todos** sus ficheros, no sólo el primero.
   *
   * Hace falta para poder abrirlos y quitarlos uno a uno: cada entrada trae su
   * identificador, que es por el que se piden. Los campos de arriba se quedan
   * donde estaban —salen del primero— porque son los que ya lee la pantalla.
   */
  ficheros: IFicheroVisto[];
}

/**
 * El significado (ms-agents) y el fichero (ms-documents), en una sola vista.
 *
 * **Vive aparte porque lo miran dos pantallas** (SPEC-083 y SPEC-102): la
 * pestaña Recursos del agente y el panel de quien atiende una conversación. Un
 * recurso al que le falta el fichero tiene que verse igual en las dos, y si
 * cada una lo compusiera por su cuenta dejarían de parecerse en cuanto alguien
 * tocara una.
 *
 * Que ms-documents no conteste **no deja la lista sin recursos**: se devuelven
 * con `falta: true`, que es exactamente lo que se ve. Ahí se pierde el matiz
 * entre «el fichero se borró» y «el servicio no contestó», y es a propósito:
 * para quien mira la pantalla, en los dos casos ese recurso no se puede enviar.
 *
 * **La señal de «incompleto» no cambia con SPEC-230**, y eso es deliberado: un
 * recurso al que se le quitaron todos los ficheros llega con
 * `documentServiceId` en `null`, no se encuentra al buscarlo, y entra por
 * **esta misma línea** con `falta: true`. Una marca nueva habría dado a la
 * pantalla dos maneras de decir lo mismo, y acabaría enseñando sólo una.
 */
export async function componerVistaDeRecursos(
  agentId: string,
  tenantId: string | undefined,
  significados: readonly ISignificadoDeRecurso[],
): Promise<IRecursoVisto[]> {
  const ficheros = await DocumentsServiceClient.recursosDeAgente(tenantId!, agentId).catch(
    () => [] as { id: string }[],
  );
  const porId = new Map(ficheros.map((f: { id: string }) => [f.id, f]));

  const datosDe = (documentServiceId: string | null) =>
    (documentServiceId === null ? undefined : porId.get(documentServiceId)) as
      | { fileName?: string; mimeType?: string; fileSize?: number }
      | undefined;

  return significados.map((recurso) => {
    const fichero = datosDe(recurso.documentServiceId ?? null);
    return {
      id: recurso.id,
      title: recurso.title,
      intention: recurso.intention,
      acompanaEn: recurso.acompanaEn ?? [],
      fileName: fichero?.fileName ?? null,
      mimeType: fichero?.mimeType ?? null,
      fileSize: fichero?.fileSize ?? null,
      falta: fichero === undefined,
      ficheros: ficherosDe(recurso).map((suyo) => {
        const datos = datosDe(suyo.documentServiceId);
        return {
          id: suyo.id,
          documentServiceId: suyo.documentServiceId,
          fileName: datos?.fileName ?? null,
          mimeType: datos?.mimeType ?? null,
          fileSize: datos?.fileSize ?? null,
          falta: datos === undefined,
        };
      }),
    };
  });
}

/**
 * Los ficheros de un recurso, venga como venga.
 *
 * Un significado del contrato de ayer no trae la lista: era un fichero y sólo
 * uno, y su identificador era el del propio recurso — que es exactamente lo
 * que ms-agents sigue devolviendo hoy para los que nadie ha tocado. Derivarlo
 * aquí es lo que hace que **lo de antes se siga leyendo sin que nadie lo
 * migre**, y no una cortesía.
 */
export function ficherosDe(recurso: ISignificadoDeRecurso): IFicheroDeRecurso[] {
  if (recurso.ficheros !== undefined) return recurso.ficheros;
  const documentServiceId = recurso.documentServiceId;
  return documentServiceId === null || documentServiceId === undefined
    ? []
    : [{ id: recurso.id, documentServiceId }];
}
