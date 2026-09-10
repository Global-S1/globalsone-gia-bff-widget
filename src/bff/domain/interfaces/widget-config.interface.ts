/**
 * Lo que ms-agents devuelve al resolver un widget, en
 * `GET /v1/widgets/:id/config` (SPEC-192 · ADR-037).
 *
 * **`:id` vale como identificador de widget o como identificador de agente**, y
 * eso es lo que sostiene los fragmentos ya pegados en webs de clientes: cuando
 * es un agente, ms-agents devuelve su widget por defecto, que es el más antiguo
 * de los suyos. La ruta vieja, `GET /v1/agents/:id/widget-config`, comparte
 * manejador con ésta y sigue existiendo; su retirada es de este SPEC.
 *
 * Con esto dejan de hacer falta en la petición el identificador del agente y el
 * de la organización: los dos salen de aquí.
 *
 * La instrucción de identificación del tenant NO sale por esta ruta: la usa
 * ms-agents al componer lo que se le pide al modelo (ADR-025).
 */
export interface IWidgetConfig {
  /** La entidad que atiende: un widget atiende a un solo agente (ADR-037). */
  readonly widgetId: string;
  readonly agentId: string;
  readonly organizationId: string;
  /**
   * Si el widget está atendiendo. Nace encendido; el tenant lo apaga desde su
   * panel, y un widget apagado no gasta modelo.
   */
  readonly active: boolean;
  /** El interruptor que decide por qué puerta entra el mensaje (ADR-034). */
  readonly leadsEnabled: boolean;
  /** Dirección `http`/`https` del formulario del tenant, o nada. */
  readonly contactFormUrl: string | null;
  /**
   * SPEC-205 · SPEC-196 — los dominios que el tenant **declaró suyos**, ya
   * normalizados por ms-agents: sin esquema, sin puerto, sin camino, en
   * minúsculas y con el IDN en punycode.
   *
   * **Va siempre presente aunque esté vacía, y es a propósito**: quien compara
   * necesita distinguir «no hay lista» de «no me lo contó». Vacía significa que
   * el tenant no registró ninguno, y entonces no se bloquea nada.
   *
   * No confundir con los orígenes **observados**, que son otra lista y no salen
   * por esta ruta: una la escribe una persona y dice «esto es mío», la otra la
   * escribe el tráfico y dice «esto está pasando».
   */
  readonly allowedDomains: readonly string[];
  /** Si esos dominios se hacen cumplir. Nace apagado (RF-025). */
  readonly domainBlockingEnabled: boolean;
  /**
   * SPEC-259 · SPEC-256 · RF-034 — cuántos caracteres deja escribir este
   * widget, **ya resuelto** por ms-agents: el suyo si lo declaró, y si no el de
   * la casa.
   *
   * Opcional a propósito: un ms-agents que todavía no lo publique deja el campo
   * ausente, y ausente significa «rige el que el widget ya trae». Este servicio
   * **no conoce el defecto de la casa y no debe conocerlo**.
   */
  readonly topeDeCaracteres?: number;
}
