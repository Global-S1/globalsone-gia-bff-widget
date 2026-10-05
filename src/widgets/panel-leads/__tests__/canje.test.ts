/**
 * SPEC-268 — las tres rutas públicas del canje reenvían a ms-auth y
 * conservan lo que contestó: código y cuerpo. El cliente se sustituye.
 */
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cliente = vi.hoisted(() => ({
  canjear: vi.fn(),
  abrirSesion: vi.fn(),
  darDeBaja: vi.fn(),
}));
vi.mock("../clientes/auth-panel.client", () => ({
  getAuthPanelClient: () => cliente,
}));

import { server } from "../../../server";

beforeEach(() => vi.clearAllMocks());

describe("El canje, visto desde fuera", () => {
  it("POST /v1/canje reenvía la aserción y devuelve el vale con el 201 de ms-auth", async () => {
    cliente.canjear.mockResolvedValue({ success: true, statusCode: 201, data: { vale: "v-1", expiraEn: 60 } });

    const r = await request(server()).post("/v1/panel/canje").send({ asercion: "a.b.c" });

    expect(r.status).toBe(201);
    expect(r.body).toEqual({ success: true, data: { vale: "v-1", expiraEn: 60 } });
    expect(cliente.canjear).toHaveBeenCalledWith("a.b.c", expect.objectContaining({ correlationId: expect.any(String) }));
  });

  it("un canje rechazado sale con el 403 y el mensaje único de ms-auth", async () => {
    cliente.canjear.mockResolvedValue({
      success: false,
      statusCode: 403,
      error: { code: "403", message: "No se pudo emitir la sesión", service: "auth", details: { success: false, kindMessage: "No se pudo emitir la sesión" } },
    });

    const r = await request(server()).post("/v1/panel/canje").send({ asercion: "a.b.c" });

    expect(r.status).toBe(403);
    expect(r.body).toEqual({ success: false, message: "No se pudo emitir la sesión" });
  });

  it("POST /v1/sesion cambia el vale por el token", async () => {
    cliente.abrirSesion.mockResolvedValue({
      success: true,
      statusCode: 200,
      data: { token: "t", expiresIn: 600, tenantId: "org-acme", role: "lector", permissions: ["leads:read"], persona: { id: "emp-42", nombre: "Ana" } },
    });

    const r = await request(server()).post("/v1/panel/sesion").send({ vale: "v-1" });

    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ token: "t", expiresIn: 600 });
    expect(cliente.abrirSesion).toHaveBeenCalledWith("v-1", expect.anything());
  });

  it("un vale usado sale con el 401 de ms-auth", async () => {
    cliente.abrirSesion.mockResolvedValue({
      success: false,
      statusCode: 401,
      error: { code: "401", message: "x", service: "auth", details: { kindMessage: "El vale no es válido o ya se usó" } },
    });

    const r = await request(server()).post("/v1/panel/sesion").send({ vale: "v-1" });

    expect(r.status).toBe(401);
    expect(r.body.message).toBe("El vale no es válido o ya se usó");
  });

  it("POST /v1/bajas reenvía la aserción", async () => {
    cliente.darDeBaja.mockResolvedValue({ success: true, statusCode: 200, data: null });

    const r = await request(server()).post("/v1/panel/bajas").send({ asercion: "a.b.c" });

    expect(r.status).toBe(200);
    expect(cliente.darDeBaja).toHaveBeenCalledWith("a.b.c", expect.anything());
  });

  it("si ms-auth no contesta, se dice con un 5xx y no se inventa una sesión", async () => {
    cliente.canjear.mockResolvedValue({ success: false, statusCode: 503, error: { code: "CONNECTION_ERROR", message: "Cannot connect to auth-service", service: "auth" } });

    const r = await request(server()).post("/v1/panel/canje").send({ asercion: "a.b.c" });

    expect(r.status).toBe(503);
    expect(r.body.success).toBe(false);
  });
});
