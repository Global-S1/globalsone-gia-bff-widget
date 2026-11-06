import express from "express";
import request from "supertest";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
const config = vi.hoisted(() => ({ name: "leads", baseUrl: "", timeout: 300, retries: 0, healthPath: "/health" }));
vi.mock("../../../bff/infrastructure/config/backend-services.config", () => ({ getServiceConfig: () => config, ServiceKeys: { LEADS: "leads" } }));
const audit = vi.hoisted(() => ({ publishAudit: vi.fn(async () => { }) }));
vi.mock("../auditoria/audit-publisher", () => audit);
import { leadsRoutes } from "../routes/leads.routes";
import { puertaDelPanel } from "../middlewares/puerta-del-panel.middleware";
import { tokenDelPanel, cabecerasDeSesion } from "./token-del-panel";
let upstream: Server;
let unavailable = false;
let status = 200;
let captures: any[] = [];
beforeAll(async () => { upstream = createServer(async (req, res) => { if (unavailable) {
    req.socket.destroy();
    return;
} let raw = ""; for await (const b of req)
    raw += b; captures.push({ url: req.url, method: req.method, headers: req.rawHeaders, body: raw ? JSON.parse(raw) : undefined }); res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(status === 200 ? { ordenColumnas: ["class-1", "sin_clasificar"], version: 3 } : { error: "upstream rejected" })); }); await new Promise<void>(r => upstream.listen(0, "127.0.0.1", r)); config.baseUrl = `http://127.0.0.1:${(upstream.address() as any).port}`; });
afterAll(async () => { await new Promise<void>(r => upstream.close(() => r())); });
beforeEach(() => { status = 200; unavailable = false; captures = []; vi.clearAllMocks(); });
function app() { const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.context = { correlationId: "test", timestamp: new Date(), tenantId: req.get("x-tenant-id") ?? "org-acme", userId: req.get("x-user-id") ?? undefined, userPermissions: (req.get("x-user-permissions") ?? "").split(",") }; next(); }); app.use(puertaDelPanel); app.use("/leads", leadsRoutes()); return app; }
function call(method: "get" | "put", permissions = "leads:read", user = "user-ana") { return request(app())[method]("/leads/preferencias/tablero?userId=intruder&tenantId=other").set("x-user-id", user).set("x-user-permissions", permissions).set(cabecerasDeSesion(permissions)).set("x-user-id", user).set("authorization", `Bearer ${tokenDelPanel()}`); }
describe("authenticated personal board preference proxy", () => {
    it("reads exact upstream path with one trusted identity header each", async () => { const r = await call("get"); expect(r.status).toBe(200); expect(r.body).toEqual({ success: true, data: { ordenColumnas: ["class-1", "sin_clasificar"], version: 3 } }); expect(captures[0].url).toBe("/v1/preferencias/tablero"); for (const [name, value] of [["x-user-id", "user-ana"], ["x-tenant-id", "org-acme"]]) {
        const headers = captures[0].headers;
        expect(headers.filter((v: string, i: number) => i % 2 === 0 && v.toLowerCase() === name)).toHaveLength(1);
        expect(headers[headers.findIndex((v: string, i: number) => i % 2 === 0 && v.toLowerCase() === name) + 1]).toBe(value);
    } });
    it("allows read-only user to save exact payload and revision", async () => { const body = { ordenColumnas: ["sin_clasificar", "class-1"], version: 2 }; expect((await call("put").send(body)).status).toBe(200); expect(captures[0]).toMatchObject({ method: "PUT", url: "/v1/preferencias/tablero", body }); });
    it.each(["get", "put"] as const)("requires read permission for %s", async (method) => { expect((await call(method, "leads:attend").send({ ordenColumnas: [], version: 0 })).status).toBe(403); expect(captures).toHaveLength(0); });
    it.each(["", "user-ana,other", "   "])("rejects missing or ambiguous identity %s", async (user) => { expect((await call("get", "leads:read", user)).status).toBe(400); expect(captures).toHaveLength(0); });
    it("does not turn an unavailable upstream into an empty preference", async () => { unavailable = true; const r = await call("get"); expect(r.status).toBeGreaterThanOrEqual(500); expect(r.body.success).toBe(false); expect(r.body.data).toBeUndefined(); });
    it("preserves write conflict without retry", async () => { status = 409; const r = await call("put").send({ ordenColumnas: [], version: 2 }); expect(r.status).toBe(409); expect(captures).toHaveLength(1); });
    it("rejects identity spoofing fields", async () => { expect((await call("put").send({ ordenColumnas: [], version: 0, userId: "other", tenantId: "other" })).status).toBe(400); expect(captures).toHaveLength(0); });
    it.each([400, 401, 403, 409, 503])("preserves upstream %s without false success", async (code) => { status = code; const r = await call("get"); expect(r.status).toBe(code); expect(r.body.success).toBe(false); expect(r.body.data).toBeUndefined(); });
    it("audits both personal preference operations with origin and identity", async () => { await call("get"); await call("put").send({ ordenColumnas: [], version: 2 }); expect(audit.publishAudit).toHaveBeenCalledTimes(2); expect(audit.publishAudit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "org-acme", actorId: "user-ana", resource: "lead_board_preference", action: "UPDATE_BOARD_PREFERENCE", payload: expect.objectContaining({ origen: "https://erp.acme.com", superficie: "panel-incrustado" }) })); });
    it("rejects a claim and context user mismatch", async () => { expect((await call("get", "leads:read", "other")).status).toBe(401); expect(captures).toHaveLength(0); });
});
