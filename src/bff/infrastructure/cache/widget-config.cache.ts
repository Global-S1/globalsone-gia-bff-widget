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
 * El coste, declarado: un tenant que cambia el interruptor tarda hasta un TTL
 * en notarlo, y dos réplicas pueden discrepar mientras tanto. Es el mismo coste
 * que tendría cualquier caché por tiempo, también una compartida.
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

/** Vacía la memoria. Existe para las pruebas: en marcha nadie la invalida. */
export function limpiarCacheDeConfiguracionDeWidget(): void {
  entradas.clear();
}
