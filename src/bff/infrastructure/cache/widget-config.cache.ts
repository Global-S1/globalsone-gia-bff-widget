/**
 * SPEC-167 · SPEC-195 — la resolución de un widget, memorizada.
 *
 * El SPEC lo pide explícitamente: «la configuración del agente no se pregunta
 * en cada mensaje». Sin esto, cada mensaje de cada visitante añade una llamada
 * a ms-agents ANTES de la que de verdad responde.
 *
 * **Es memoria del proceso y no el Redis del BFF, y es a propósito.** Redis
 * aquí no quitaría una espera de red: la sustituiría por otra, y encima
 * `AggregatedCacheService` se apaga entero con `BFF_CACHE_ENABLED=false` —el
 * valor por defecto cuando la variable no está declarada—, lo que dejaría el
 * SPEC incumplido en cualquier despliegue que no la ponga. Lo que se guarda es
 * un objeto de seis campos por identificador: cabe de sobra en el proceso.
 *
 * **La clave es el identificador tal como llegó** —el del widget o el de su
 * agente—, no el widget resuelto. Los dos pueden acabar guardando el mismo
 * widget bajo dos claves distintas, y da igual: es el mismo objeto, ocupa nada,
 * y la alternativa —normalizar antes de cachear— exigiría resolver primero,
 * que es justo lo que la caché existe para no hacer.
 *
 * **Sólo se guardan los aciertos.** Un fallo al preguntar cae al camino de hoy
 * —esa es la regla del SPEC— y cachearlo dejaría a un agente fuera de leads
 * durante todo el TTL por un tropiezo de un segundo.
 *
 * **El vencimiento ya no es la única forma de estar al día** (ADR-044). Desde
 * SPEC-262 esto se olvida también por aviso: ms-agents publica cuando un widget
 * cambia y aquí se borra al instante. Lo que el tenant guarda rige desde la
 * petición siguiente, no desde dentro de un rato.
 *
 * El TTL se queda debajo, como red: si Redis no está, si el aviso se pierde o
 * si el proceso acababa de arrancar, el peor caso vuelve a ser el de antes
 * —hasta un TTL de retraso— y no uno peor.
 */
import { env } from "../../../entities/shared/infraestructure/config/environments";
import { IWidgetConfig } from "../../domain/interfaces/widget-config.interface";

interface IEntrada {
  readonly valor: IWidgetConfig;
  readonly expiraEn: number;
}

const entradas = new Map<string, IEntrada>();

/** Lo que vale una configuración ya consultada, en milisegundos. */
function ttlEnMilisegundos(): number {
  return env.bff.cacheDefaultTtl * 1000;
}

export function leerConfiguracionDeWidget(identificador: string): IWidgetConfig | null {
  const entrada = entradas.get(identificador);
  if (!entrada) return null;
  if (Date.now() >= entrada.expiraEn) {
    entradas.delete(identificador);
    return null;
  }
  return entrada.valor;
}

export function guardarConfiguracionDeWidget(
  identificador: string,
  valor: IWidgetConfig
): void {
  entradas.set(identificador, {
    valor,
    expiraEn: Date.now() + ttlEnMilisegundos(),
  });
}

/**
 * SPEC-262 · SPEC-261 · ADR-044 — olvida lo que se guardaba de un widget.
 *
 * **Se borra por widget, no por clave.** Esto se indexa por «el identificador
 * tal como llegó» —el del widget o el de su agente (ADR-037)—, así que el mismo
 * widget puede estar bajo dos claves y el aviso sólo trae una. Se recorre el
 * mapa buscando al dueño: son unos pocos objetos, y la alternativa —que
 * ms-agents mandara también el identificador del agente— le obligaría a saber
 * cómo indexa su memoria un servicio que no es suyo.
 */
export function olvidarWidget(widgetId: string): void {
  entradas.delete(widgetId);
  for (const [clave, entrada] of entradas) {
    if (entrada.valor.widgetId === widgetId) entradas.delete(clave);
  }
}

/** Vacía la memoria entera. Existe para las pruebas. */
export function limpiarCacheDeConfiguracionDeWidget(): void {
  entradas.clear();
}
