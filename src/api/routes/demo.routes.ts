import { Router, Request, Response, NextFunction } from "express";
import { DemoProxyOptions, proxyDemo } from "../demo-proxy";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Explicit route allowlist: a public caller can never address /admin. */
export function demoRoutes(options: DemoProxyOptions = {}): Router {
  const router = Router();
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.get("x-demo-session") && req.get("x-demo-session")!.length > 512) {
      res.status(400).json({ success:false,error:{code:"INVALID_SESSION",message:"Sesión inválida."} }); return;
    }
    next();
  });
  const check = (req: Request, res: Response, next: NextFunction) => {
    for (const key of ["demoId", "sessionId", "templateId", "documentId"]) {
      if (req.params[key] && !uuid.test(req.params[key])) {
        res.status(404).json({success:false,error:{code:"NOT_FOUND",message:"Demo o recurso no encontrado."}});return;
      }
    }
    if (req.params.sessionId && !req.get("x-demo-session")) {
      res.status(401).json({success:false,error:{code:"SESSION_REQUIRED",message:"La sesión de demo es necesaria."}});return;
    }
    next();
  };
  const pass = (keys?: string[], method?: "PATCH") => (req: Request,res: Response) => {
    const body = keys ? Object.fromEntries(keys.filter(key=>req.body?.[key] !== undefined).map(key=>[key, req.body[key]])) : undefined;
    void proxyDemo(req,res,req.path,body,options,method);
  };
  router.get("/pages/:slug", (req, res) => {
    const tenant = options.demoTenant?.() ?? process.env.DEMO_TENANT_ID;
    if (!tenant || !uuid.test(tenant)) {
      res.status(503).json({success:false,error:{code:"DEMO_UNAVAILABLE",message:"Página no disponible."}});return;
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(req.params.slug) || req.params.slug.length > 64) {
      res.status(404).json({success:false,error:{code:"NOT_FOUND",message:"Página no disponible."}});return;
    }
    void proxyDemo(req,res,`/pages/${tenant}/${encodeURIComponent(req.params.slug)}`,undefined,options);
  });
  router.get("/catalog", (req, res) => {
    const tenant = options.demoTenant?.() ?? process.env.DEMO_TENANT_ID;
    if (!tenant || !uuid.test(tenant)) {
      res.status(503).json({success:false,error:{code:"DEMO_UNAVAILABLE",message:"Demo no disponible."}});return;
    }
    void proxyDemo(req,res,`/catalog/${tenant}`,undefined,options);
  });
  router.get("/:demoId",check,pass());
  router.post("/:demoId/sessions",check,pass(["requestId","conversationLocale"]));
  router.get("/:demoId/sessions/:sessionId",check,pass());
  router.patch("/:demoId/sessions/:sessionId/locale",check,pass(["conversationLocale"]));
  // The public gateway permits GET/POST preflights; the internal update remains PATCH.
  router.post("/:demoId/sessions/:sessionId/locale",check,pass(["conversationLocale"], "PATCH"));
  router.post("/:demoId/sessions/:sessionId/messages",check,pass(["message","requestId","conversationLocale"]));
  router.post("/:demoId/sessions/:sessionId/contacts",check,pass(["requestId","name","email","phone","company"]));
  router.get("/:demoId/sessions/:sessionId/templates",check,pass());
  router.get("/:demoId/sessions/:sessionId/templates/:templateId",check,pass());
  router.post("/:demoId/sessions/:sessionId/documents",check,pass(["requestId","templateId","fieldValues","format","conversationLocale"]));
  router.get("/:demoId/sessions/:sessionId/documents/:documentId/download",check,pass());
  return router;
}
