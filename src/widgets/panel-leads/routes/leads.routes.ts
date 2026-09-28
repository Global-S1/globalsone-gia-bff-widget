import { Router } from "express";
import { leadsController } from "../controllers/leads.controller";
import { PERMISOS_DE_LEADS, requierePermiso } from "../middlewares/requiere-permiso.middleware";

/**
 * SPEC-271 · SPEC-275 — las cuatro vistas del panel incrustado y sus acciones.
 *
 * Verlas es de VER; actuar es de ATENDER. **No hay catálogo, canales ni
 * ajustes**: quien los necesite entra al backoffice. Un permiso de más en el
 * backoffice no abre nada aquí, porque aquí no hay ruta que lo pida.
 */
export function leadsRoutes(): Router {
  const router = Router();
  const VER = requierePermiso(PERMISOS_DE_LEADS.VER);
  const ATENDER = requierePermiso(PERMISOS_DE_LEADS.ATENDER);

  // ── Panel y ficha del lead ────────────────────────────────────────────────
  router.get("/panel", VER, (req, res) => leadsController.panel(req, res));
  router.get("/pendientes", VER, (req, res) => leadsController.pendientes(req, res));
  router.get("/leads/:leadId/historial", VER, (req, res) => leadsController.historial(req, res));
  router.get("/leads/:leadId/clasificaciones", VER, (req, res) => leadsController.clasificaciones(req, res));
  router.put("/leads/:leadId/clase", ATENDER, (req, res) => leadsController.corregirClase(req, res));
  router.put("/leads/:leadId/contacto", ATENDER, (req, res) => leadsController.corregirContacto(req, res));
  router.delete("/leads/:leadId", ATENDER, (req, res) => leadsController.ejecutarBorrado(req, res));

  // ── Bandeja y conversación ────────────────────────────────────────────────
  router.get("/conversaciones", VER, (req, res) => leadsController.bandeja(req, res));
  router.get("/conversaciones/:conversacionId/ficha", VER, (req, res) => leadsController.fichaDeConversacion(req, res));
  router.get("/conversaciones/:conversacionId", VER, (req, res) => leadsController.conversacion(req, res));
  for (const accion of ["tomar", "liberar", "devolver-al-agente"] as const) {
    router.post(`/conversaciones/:conversacionId/${accion}`, ATENDER, (req, res) => leadsController.accion(accion)(req, res));
  }
  router.post("/conversaciones/:conversacionId/responder", ATENDER, (req, res) => leadsController.responder(req, res));

  // ── Las herramientas del agente, prestadas a quien atiende (SPEC-102) ────
  router.get("/conversaciones/:conversacionId/recursos", ATENDER, (req, res) => leadsController.recursosDeLaConversacion(req, res));
  router.get("/conversaciones/:conversacionId/consultas", ATENDER, (req, res) => leadsController.consultasDeLaConversacion(req, res));
  router.post("/conversaciones/:conversacionId/recursos/:recursoId", ATENDER, (req, res) => leadsController.mandarRecurso(req, res));
  router.post("/conversaciones/:conversacionId/consultas/:consultaId", ATENDER, (req, res) => leadsController.ejecutarConsulta(req, res));

  return router;
}
