/**
 * La configuración de widget de un agente, tal y como la publica ms-agents en
 * `GET /v1/agents/:id/widget-config` (SPEC-162).
 *
 * `leadsEnabled` es el interruptor que decide por qué puerta entra el mensaje
 * de un visitante (SPEC-167 · ADR-034). `organizationId` viene con él porque
 * quien pregunta —este BFF— no la sabe: tiene un token de organización, que
 * identifica pero no dice cuál es.
 *
 * La instrucción de identificación del tenant NO sale por esa ruta: la usa
 * ms-agents al componer lo que se le pide al modelo (ADR-025).
 */
export interface IWidgetConfig {
  readonly agentId: string;
  readonly organizationId: string;
  readonly leadsEnabled: boolean;
  /** Dirección `http`/`https` del formulario del tenant, o nada. */
  readonly contactFormUrl: string | null;
}
