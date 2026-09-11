import { Router } from "express";
import { configuracionDelWidget } from "../controllers/configuracion.controller";

/**
 * SPEC-259 · RF-034 — lo que un widget necesita saber de sí mismo.
 *
 * **Pública y sin credencial**, como el proxy del fichero y por lo mismo: la
 * pide el navegador de un visitante anónimo en la web de un tercero. Va montada
 * fuera de cualquier middleware de sesión.
 */
export function configuracionRoutes(): Router {
  const router = Router();

  // GET /v1/widget/:widgetId/configuracion —
  // públicamente `/v1/widget/v1/widget/:widgetId/configuracion`.
  router.get("/:widgetId/configuracion", configuracionDelWidget);

  return router;
}
