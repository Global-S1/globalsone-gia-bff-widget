import { IRequestContext } from "../../domain/interfaces/request-context.interface";
import { IWidgetConfig } from "../../domain/interfaces/widget-config.interface";
import { getAgentsServiceClient } from "../../infrastructure/service-clients/agents-service.client";
import {
  guardarConfiguracionDeWidget,
  leerConfiguracionDeWidget,
} from "../../infrastructure/cache/widget-config.cache";
import { logger } from "../../../entities/shared/infraestructure/utils/logger";
import { StatusCodes } from "../../../entities/shared/infraestructure/lib/http-status-codes";

/**
 * SPEC-195 — resolver quién es el widget que manda un mensaje.
 *
 * **Son tres desenlaces y no dos, y la diferencia importa.** Hasta SPEC-167
 * bastaba con «lo sé» o «no lo sé»: cualquier fallo caía al camino de siempre.
 * Ahora hay un tercero que no se puede disimular:
 *
 *   · `resuelto`   — quién es, con su agente y su organización.
 *   · `no-existe`  — ms-agents dice que ese identificador no es de nadie (404).
 *     Se le contesta a quien escribe con una frase, y **no se llama a nadie
 *     más**: no hay agente al que preguntar ni conversación que abrir.
 *   · `no-se-sabe` — no hemos podido preguntarlo. Se atiende **como hoy**, que
 *     es la regla de SPEC-167: un tropiezo de ms-agents, el secreto
 *     desalineado o un tiempo de espera no pueden dejar mudo el chat de un
 *     cliente.
 *
 * Confundir los dos últimos es lo que hay que evitar en los dos sentidos:
 * tratar un 404 como un tropiezo apaga la feature en silencio —el visitante
 * conversa con un agente que el fragmento ya no debería alcanzar—, y tratar un
 * tropiezo como un 404 deja mudo un widget que está perfectamente bien.
 */
export type ResolucionDeWidget =
  | { readonly tipo: "resuelto"; readonly config: IWidgetConfig }
  | { readonly tipo: "no-existe" }
  | { readonly tipo: "no-se-sabe" };

/**
 * El identificador es **el del widget o el del agente**, indistintamente: la
 * ruta de ms-agents resuelve los dos y devuelve el widget por defecto cuando le
 * dan un agente (ADR-037). Aquí no se decide cuál es cuál — decidirlo obligaría
 * a este BFF a saber distinguir dos formas de identificador que hoy son la
 * misma, y a equivocarse el día que una cambie.
 */
export async function resolverWidget(
  identificador: string,
  context: IRequestContext
): Promise<ResolucionDeWidget> {
  const cacheada = leerConfiguracionDeWidget(identificador);
  if (cacheada) return { tipo: "resuelto", config: cacheada };

  try {
    const respuesta = await getAgentsServiceClient().getWidgetConfig(
      identificador,
      context
    );

    if (respuesta.statusCode === StatusCodes.NOT_FOUND) {
      // Situación normal y no avería: el identificador lo pega una persona en
      // el HTML de su web, y ahí se escribe mal o se queda uno viejo.
      logger.warn("Un mensaje llegó con un identificador que no resuelve", {
        identificador,
      });
      return { tipo: "no-existe" };
    }

    if (!respuesta.success || !respuesta.data) {
      logger.warn("No se pudo resolver el widget: se atiende por el camino de siempre", {
        identificador,
        statusCode: respuesta.statusCode,
        error: respuesta.error,
      });
      return { tipo: "no-se-sabe" };
    }

    // **Sólo se guardan los aciertos.** Cachear un fallo dejaría al widget
    // fuera durante todo el TTL por un tropiezo de un segundo; y cachear un
    // «no existe» dejaría muerto durante todo el TTL un widget recién creado.
    guardarConfiguracionDeWidget(identificador, respuesta.data);
    return { tipo: "resuelto", config: respuesta.data };
  } catch (error) {
    logger.warn("Falló la consulta de la configuración de widget", {
      identificador,
      error,
    });
    return { tipo: "no-se-sabe" };
  }
}
