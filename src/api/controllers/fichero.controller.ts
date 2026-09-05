import { Request, Response } from "express";
import { StatusCodes } from "../../entities/shared/infraestructure/lib/http-status-codes";
import { getLeadsServiceClient } from "../../bff/infrastructure/service-clients/leads-service.client";
import { getDocumentsServiceClient } from "../../bff/infrastructure/service-clients/documents-service.client";
import { IRequestContext } from "../../bff/domain/interfaces/request-context.interface";
import { logger } from "../../entities/shared/infraestructure/utils/logger";

/**
 * GET /v1/fichero/:llave  —  públicamente `<gateway>/v1/widget/v1/fichero/:llave`
 *
 * El proxy que decidió ADR-035: una ruta **pública y sin credencial** que
 * recibe una llave, se la resuelve a ms-leads (SPEC-186), va a buscar los bytes
 * a ms-documents con el token de servicio (ADR-026) y se los entrega al
 * navegador **como una descarga** (SPEC-187 · RF-022).
 *
 * Es la pieza que hace que la ruta de ms-documents pueda seguir cerrada a
 * internet.
 *
 * ## Por qué no pide nada
 *
 * Quien escribe por el widget es anónimo y no va a tener sesión nunca (GLO-008),
 * así que **la llave ES la autorización**: 256 bits de azar que sólo sirven
 * para ese fichero en esa conversación (SPEC-186). De ahí se siguen dos cosas
 * que este fichero cumple a rajatabla:
 *
 *   · **No se pide ninguna credencial.** Exigirla sería exigirle a un anónimo
 *     algo que no puede tener.
 *   · **La respuesta no revela ningún identificador interno**: ni el del
 *     documento ni el de la organización, ni en las cabeceras ni en el cuerpo,
 *     ni siquiera al fallar. Entra una llave y salen bytes.
 *
 * ## Lo que este proxy da por bueno
 *
 * Al acuñar la llave, ms-leads **no comprueba** que el documento pertenezca a
 * esa organización: lo toma tal como se lo dio ms-agents, que ya resuelve por
 * tenant. No hay fuga porque ms-documents recibe la organización al pedir los
 * bytes y responde según ella — pero esta ruta se apoya en esa cadena, así que
 * se pide **siempre con la organización que devolvió la llave** y nunca con
 * nada que venga de quien descarga. Quien rompa la cadena aguas arriba rompe
 * esto sin que aquí falle nada.
 */

/**
 * Lo que se le dice a quien no pudo descargar.
 *
 * Escrito aquí y no traído del error: lo que devuelve un servicio interno puede
 * traer dentro detalles de nuestra configuración, y esto lo lee alguien en una
 * página que no controlamos.
 */
const NO_TE_PUEDO_DAR_EL_FICHERO =
  "No he podido darte ese fichero ahora mismo. Vuelve a intentarlo en un momento.";

/** Lo que se dice cuando no hay nada al otro lado de la llave. */
const NO_ESTA = "Ese fichero ya no está disponible.";

/**
 * La forma de una llave (SPEC-186): 256 bits en `base64url`, 43 caracteres de
 * `[A-Za-z0-9_-]`.
 *
 * Comprobarla aquí no es validación por gusto: lo que no tiene esta forma no
 * puede existir, así que no se pregunta. Quien barra la ruta al azar —y una
 * ruta pública sin credencial se barre— no nos cuesta una llamada a ms-leads
 * por intento. El 404 que recibe es **exactamente el mismo** que el de una
 * llave bien formada que no existe, así que no delata nada.
 */
const FORMA_DE_LA_LLAVE = /^[A-Za-z0-9_-]{43}$/;

export async function descargarFichero(
  req: Request,
  res: Response
): Promise<void> {
  const llave = String(req.params?.["llave"] ?? "");

  const context: IRequestContext = {
    correlationId: (req.headers["x-correlation-id"] as string) || "",
    timestamp: new Date(),
  };

  if (!FORMA_DE_LA_LLAVE.test(llave)) {
    noEsta(res);
    return;
  }

  // ── De quién es la llave ─────────────────────────────────────────────────
  let suya;
  try {
    suya = await getLeadsServiceClient().resolverLlaveDeFichero(llave, context);
  } catch (error) {
    logger.error("No se pudo resolver la llave de un fichero del widget", error);
    noTePuedoAtender(res);
    return;
  }

  if (suya.statusCode === StatusCodes.NOT_FOUND) {
    // Una llave que no está es un 404 para todo el mundo, y no se llama a
    // ms-documents: sin llave no hay a qué documento ir.
    noEsta(res);
    return;
  }

  if (!suya.success || !suya.data) {
    logger.error("ms-leads no resolvió la llave de un fichero del widget", {
      statusCode: suya.statusCode,
      error: suya.error,
    });
    // **502 y no 404**: decirle «no existe» a un enlace que sí existe le pide a
    // quien escribe que deje de intentarlo con algo que sólo está caído.
    noTePuedoAtender(res);
    return;
  }

  // ── Los bytes ────────────────────────────────────────────────────────────
  let upstream;
  try {
    upstream = await getDocumentsServiceClient().obtenerFichero(
      {
        organizacionId: suya.data.organizacionId,
        documentoId: suya.data.documentoId,
      },
      context
    );
  } catch (error) {
    logger.error("No se pudieron pedir los bytes de un recurso del agente", error);
    noTePuedoAtender(res);
    return;
  }

  if (upstream.statusCode === StatusCodes.NOT_FOUND) {
    // Los dos lados se borran por separado: una llave viva contra un documento
    // que ya no está es un caso normal, no una avería.
    upstream.body.resume();
    noEsta(res);
    return;
  }

  if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
    logger.error("ms-documents no dio el fichero de un recurso del agente", {
      statusCode: upstream.statusCode,
    });
    upstream.body.resume();
    noTePuedoAtender(res);
    return;
  }

  // ── La descarga ──────────────────────────────────────────────────────────
  //
  // **El navegador lo guarda, no lo abre**, y ésa es la diferencia con las
  // fotos (SPEC-183): aquéllas viven en otro dominio y entre dominios distintos
  // el navegador ignora esta instrucción y las abre; estos bytes salen de
  // nosotros, así que aquí la descarga es una descarga de verdad y el botón del
  // widget cumple lo que promete (RF-022).
  //
  // La cabecera se **re-emite** en vez de reenviarse tal cual: lo que llega es
  // de otro servicio, y este es el borde que da a un navegador ajeno.
  res.setHeader("Content-Type", tipoQueSePuedeServir(upstream.headers["content-type"]));
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${nombreQueSePuedeServir(upstream.headers["content-disposition"])}"`
  );
  // El contenido lo subió un tenant: que ningún navegador decida por su cuenta
  // que esto es HTML y lo ejecute en nuestro origen.
  res.setHeader("X-Content-Type-Options", "nosniff");
  // La URL ES el secreto: no puede quedarse en una caché compartida.
  res.setHeader("Cache-Control", "private, no-store");
  res.status(StatusCodes.OK);

  upstream.body.on("error", (error: Error) => {
    logger.error("Se cortó la descarga de un recurso del agente", error);
    if (!res.headersSent) {
      res.status(StatusCodes.BAD_GATEWAY);
    }
    res.end();
  });

  upstream.body.pipe(res);
}

function noEsta(res: Response): void {
  res.status(StatusCodes.NOT_FOUND).json({ success: false, message: NO_ESTA });
}

function noTePuedoAtender(res: Response): void {
  res
    .status(StatusCodes.BAD_GATEWAY)
    .json({ success: false, message: NO_TE_PUEDO_DAR_EL_FICHERO });
}

/** El tipo que dijo ms-documents, o bytes sin más. */
function tipoQueSePuedeServir(cabecera: string | string[] | undefined): string {
  const valor = Array.isArray(cabecera) ? cabecera[0] : cabecera;
  if (typeof valor !== "string" || valor.trim() === "") {
    // Sin tipo declarado no se adivina: `octet-stream` es lo que hace que el
    // navegador lo guarde en vez de intentar pintarlo.
    return "application/octet-stream";
  }
  // Un salto de línea dentro de un valor de cabecera revienta la respuesta
  // entera en `setHeader`, y aquí la que se pierde es la descarga.
  return valor.replace(/[^\x20-\x7E]/g, "").trim() || "application/octet-stream";
}

/**
 * El nombre que dijo ms-documents, o uno genérico.
 *
 * ms-documents ya lo manda percent-encoded dentro de `filename="..."`, y así se
 * reenvía: **sin decodificar**. Decodificarlo metería otra vez en el valor de
 * la cabecera las comillas, los saltos de línea y los acentos que ese encoding
 * quitó, y una comilla ahí deja al navegador guardar un fichero con el nombre
 * que quiera quien lo subió.
 */
function nombreQueSePuedeServir(
  cabecera: string | string[] | undefined
): string {
  const valor = Array.isArray(cabecera) ? cabecera[0] : cabecera;
  if (typeof valor !== "string") return "documento";
  const encontrado = /filename="([^"]*)"/.exec(valor);
  const nombre = (encontrado?.[1] ?? "").replace(/[^A-Za-z0-9._%~+-]/g, "");
  return nombre === "" ? "documento" : nombre;
}
