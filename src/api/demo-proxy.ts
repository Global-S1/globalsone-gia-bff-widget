import { Request, Response } from "express";
import { request } from "undici";

export interface DemoProxyOptions {
  demoTenant?: () => string | undefined;
  baseUrl?: () => string;
  internalToken?: () => string;
}

/** Never use blanket proxy trust for an IP-enforced anonymous quota. */
export function trustedDemoProxies(value = process.env.TRUSTED_PROXIES): false | string[] {
  if (!value?.trim()) return false;
  const proxies = value.split(",").map(part => part.trim()).filter(Boolean);
  if (proxies.some(part => ["true", "*", "0.0.0.0/0", "::/0"].includes(part))) {
    throw new Error("TRUSTED_PROXIES must explicitly identify trusted proxy addresses or subnets");
  }
  return proxies;
}

export async function proxyDemo(req: Request, res: Response, path: string, body: unknown, options: DemoProxyOptions) {
  const baseUrl = options.baseUrl?.() ?? process.env.MS_AGENTS_URL;
  const token = options.internalToken?.() ?? process.env.INTERNAL_SERVICE_TOKEN;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (!baseUrl || !token) {
    res.status(503).json({ success: false, error: { code: "DEMO_UNAVAILABLE", message: "La demo no está disponible temporalmente." } });
    return;
  }
  const headers: Record<string,string> = {
    "content-type": "application/json", "x-internal-token": token,
    "x-demo-ip": req.ip || req.socket.remoteAddress || "",
  };
  const session = req.get("x-demo-session");
  if (session) headers["x-demo-session"] = session;
  const language = req.get("accept-language");
  if (language) headers["accept-language"] = language;
  try {
    const upstream = await request(`${baseUrl.replace(/\/$/, "")}/v1/demo${path}`, {
      method: req.method as "GET" | "POST",
      headers, body: body === undefined ? undefined : JSON.stringify(body),
      headersTimeout: 120000, bodyTimeout: 120000,
      maxRedirections: 0,
    });
    res.status(upstream.statusCode);
    for (const name of ["content-type", "content-disposition", "retry-after"]) {
      const value = upstream.headers[name];
      if (value) res.setHeader(name, value);
    }
    upstream.body.on("error", () => res.destroy());
    res.on("close", () => upstream.body.destroy());
    upstream.body.pipe(res);
  } catch {
    if (!res.headersSent) res.status(502).json({ success: false, error: { code: "DEMO_UPSTREAM_ERROR", message: "No se pudo completar la solicitud. Puedes reintentar." } });
    else res.end();
  }
}
