import { IRequestContext } from "../../domain/interfaces/request-context.interface";
import { IWidgetConfig } from "../../domain/interfaces/widget-config.interface";
import { getAgentsServiceClient } from "../../infrastructure/service-clients/agents-service.client";
import {
  guardarConfiguracionDeWidget,
  leerConfiguracionDeWidget,
} from "../../infrastructure/cache/widget-config.cache";
import { logger } from "../../../entities/shared/infraestructure/utils/logger";

/**
 * SPEC-167 — la configuración de widget de un agente, preguntada una vez.
 *
 * **Devuelve `null` cuando no se puede saber, y eso NO es un error que subir.**
 * Es la regla del SPEC: «si no se puede saber la configuración, se atiende como
 * hoy». Un fallo nuestro —ms-agents caído, el secreto desalineado, un agente
 * que ya no existe— no puede dejar mudo el chat de un cliente.
 */
export async function obtenerConfiguracionDeWidget(
  agentId: string,
  context: IRequestContext
): Promise<IWidgetConfig | null> {
  const cacheada = leerConfiguracionDeWidget(agentId);
  if (cacheada) return cacheada;

  try {
    const respuesta = await getAgentsServiceClient().getWidgetConfig(
      agentId,
      context
    );

    if (!respuesta.success || !respuesta.data) {
      // A nivel de aviso y no de error: el 404 de un agente que no existe entra
      // por aquí y es una situación normal —el widget manda el agente que le
      // pegaron en la web— no una avería.
      logger.warn("No se pudo leer la configuración de widget del agente", {
        agentId,
        statusCode: respuesta.statusCode,
        error: respuesta.error,
      });
      return null;
    }

    guardarConfiguracionDeWidget(agentId, respuesta.data);
    return respuesta.data;
  } catch (error) {
    logger.warn("Falló la consulta de la configuración de widget", {
      agentId,
      error,
    });
    return null;
  }
}
