import { Router } from "express";
import { descargarFichero } from "../controllers/fichero.controller";

/**
 * SPEC-187 · ADR-035 — el proxy del fichero que el agente aparta.
 *
 * **Pública y sin credencial, a propósito**: quien escribe por el widget es
 * anónimo, y lo que autoriza es la llave (SPEC-186). Va montada fuera de
 * cualquier middleware de sesión por la misma razón.
 */
export function ficheroRoutes(): Router {
  const router = Router();

  // GET /v1/fichero/:llave — públicamente `/v1/widget/v1/fichero/:llave`.
  router.get("/:llave", descargarFichero);

  return router;
}
