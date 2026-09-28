import { Router } from "express";
import { contextoDelPanel } from "./middlewares/contexto.middleware";
import { puertaDelPanel } from "./middlewares/puerta-del-panel.middleware";
import { canjeRoutes } from "./routes/canje.routes";
import { leadsRoutes } from "./routes/leads.routes";

/**
 * El panel incrustado de GIA Leads (CA-023 · SPEC-268/271/273/275), como
 * módulo de este BFF.
 *
 * **Un módulo por widget.** Este BFF es la puerta común de todo lo que se
 * incrusta en webs de terceros (el chat, este panel, los que vengan), y cada
 * widget vive en su carpeta bajo `src/widgets/` con sus rutas, su contexto,
 * sus clientes y sus pruebas. Lo único que comparten es la maquinaria: el
 * servidor, el cliente HTTP base y la configuración de servicios. Así un cambio
 * en el panel no puede tocar el chat, ni al revés.
 *
 * Montado en `/v1/panel`, tal como llega del gateway (que conserva el prefijo:
 * `/v1/panel/x` → `/v1/panel/x`, a diferencia de `/v1/widget/`):
 *
 *   POST /v1/panel/{canje,sesion,bajas} — sin sesión: lo autentica ms-auth por la aserción o el vale
 *   /v1/panel/leads/**                  — sólo con el token del panel, y detrás de su permiso
 */
export function panelLeadsRoutes(): Router {
  const router = Router();

  router.use(contextoDelPanel);

  // Las tres rutas del canje van ANTES de la puerta: todavía no hay sesión.
  router.use("/", canjeRoutes());

  // Todo lo demás: primero qué token es, después qué permiso tiene.
  router.use("/leads", puertaDelPanel, leadsRoutes());

  return router;
}
