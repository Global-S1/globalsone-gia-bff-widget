import { Router } from "express";
import { canjeController } from "../controllers/canje.controller";

/**
 * SPEC-268 — el canje del panel incrustado, visto desde fuera:
 *
 *   POST /v1/canje  {asercion}  ← el SERVIDOR del anfitrión, con su aserción firmada
 *   POST /v1/sesion {vale}      ← el navegador, con el vale que le dio su servidor
 *   POST /v1/bajas  {asercion}  ← el servidor del anfitrión, al dar de baja a alguien
 *
 * Son las tres únicas rutas de esta puerta que el gateway deja pasar sin
 * `auth_request`: no hay sesión todavía. Lo que autentica es la aserción
 * firmada (o el vale), y lo comprueba ms-auth.
 */
export function canjeRoutes(): Router {
  const router = Router();
  router.post("/canje", (req, res) => canjeController.canjear(req, res));
  router.post("/sesion", (req, res) => canjeController.abrirSesion(req, res));
  router.post("/bajas", (req, res) => canjeController.darDeBaja(req, res));
  return router;
}
