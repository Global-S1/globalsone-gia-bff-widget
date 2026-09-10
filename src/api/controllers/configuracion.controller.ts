import { Request, Response } from "express";
import { StatusCodes } from "../../entities/shared/infraestructure/lib/http-status-codes";
import { IRequestContext } from "../../bff/domain/interfaces/request-context.interface";
import { resolverWidget } from "../../bff/application/use-cases/widget-config.use-case";

/**
 * SPEC-259 · RF-034 — lo que un widget necesita saber de sí mismo **antes del
 * primer mensaje**.
 *
 * Hoy es un dato: cuántos caracteres deja escribir. Hasta ahora el widget no
 * tenía de dónde aprender nada suyo —lo único que pedía era su marca, y eso vive
 * en ms-branding—, así que su tope estaba escrito a mano dentro del propio
 * widget.
 *
 * ## Pública y sin credencial, como la marca
 *
 * La pide el navegador de un visitante anónimo en la web de un tercero. No hay
 * sesión que exigir ni la habrá.
 *
 * ## Y por eso no dice si un widget existe
 *
 * Un identificador inventado y un fallo pasajero contestan **exactamente igual**:
 * `200` con un objeto sin tope. Uno apagado contesta como uno encendido, porque
 * quien decide si se atiende es el turno y no esto.
 *
 * Distinguirlos convertiría esta ruta en un enumerador de widgets ajenos, que es
 * justo lo que no puede ser una ruta sin credencial.
 *
 * ## Lo que no publica
 *
 * Ni el token de la organización, ni el agente, ni los dominios declarados.
 * Nada de eso hace falta para pintar una caja de texto, y lo que no se manda no
 * se puede filtrar.
 */
export async function configuracionDelWidget(req: Request, res: Response): Promise<void> {
  const context: IRequestContext = {
    correlationId: (req.headers["x-correlation-id"] as string) || "",
    timestamp: new Date(),
  };

  const resolucion = await resolverWidget(String(req.params?.["widgetId"] ?? ""), context);

  /*
   * **Cuando no se sabe, el campo no viaja**: ni un error ni un número
   * inventado. Este servicio no conoce el defecto de la casa —lo sabe ms-agents,
   * que es su dueño, y lo trae el widget como valor de arranque— y ponerlo aquí
   * sería una tercera copia del mismo número. La tercera copia es la que nadie
   * actualiza.
   */
  const tope =
    resolucion.tipo === "resuelto" ? resolucion.config.topeDeCaracteres : undefined;

  res.status(StatusCodes.OK).json(tope === undefined ? {} : { topeDeCaracteres: tope });
}
