/**
 * SPEC-271 — la puerta del panel sólo abre para su propio token. Se prueba
 * montada en un Express mínimo, con una ruta detrás que dice si se llegó.
 */
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { contextoDelPanel } from "../middlewares/contexto.middleware";
import { normalizarOrigen, puertaDelPanel } from "../middlewares/puerta-del-panel.middleware";
import { ORG, ORIGEN, cabecerasDeSesion, tokenDelBackoffice, tokenDelPanel } from "./token-del-panel";

function app() {
  const a = express();
  a.use(express.json());
  a.use(contextoDelPanel);
  a.get("/leads/panel", puertaDelPanel, (req, res) => {
    res.json({ llego: true, panel: req.panel });
  });
  return a;
}

describe("La puerta del panel", () => {
  it("un token del panel, desde su origen y su organización, entra", async () => {
    const r = await request(app()).get("/leads/panel").set(cabecerasDeSesion()).set("authorization", `Bearer ${tokenDelPanel()}`);

    expect(r.status).toBe(200);
    expect(r.body.panel).toMatchObject({ purpose: "panel", origin: ORIGEN, tenantId: ORG, credentialId: "cred-erp" });
  });

  it("sin bearer no entra", async () => {
    const r = await request(app()).get("/leads/panel").set(cabecerasDeSesion());
    expect(r.status).toBe(401);
  });

  it("un token del backoffice no entra aunque tenga permisos de leads de sobra: se rechaza por lo que es", async () => {
    const r = await request(app())
      .get("/leads/panel")
      .set(cabecerasDeSesion())
      .set("authorization", `Bearer ${tokenDelBackoffice()}`);

    expect(r.status).toBe(401);
    expect(r.body.message).toMatch(/token del panel/);
  });

  it("desde otro origen no entra: copiado a otra web deja de servir", async () => {
    const r = await request(app())
      .get("/leads/panel")
      .set(cabecerasDeSesion(undefined, "https://otro.example"))
      .set("authorization", `Bearer ${tokenDelPanel()}`);
    expect(r.status).toBe(401);
  });

  it("sin Origin tampoco: un cliente que no es navegador no hereda nada", async () => {
    const cabeceras = cabecerasDeSesion();
    delete cabeceras.origin;
    const r = await request(app()).get("/leads/panel").set(cabeceras).set("authorization", `Bearer ${tokenDelPanel()}`);
    expect(r.status).toBe(401);
  });

  it("el origen se compara normalizado: mayúsculas y barra final son el mismo", async () => {
    const r = await request(app())
      .get("/leads/panel")
      .set(cabecerasDeSesion(undefined, "https://ERP.acme.com/"))
      .set("authorization", `Bearer ${tokenDelPanel()}`);
    expect(r.status).toBe(200);
  });

  it("si la organización del token no es la de la sesión, no entra", async () => {
    const r = await request(app())
      .get("/leads/panel")
      .set(cabecerasDeSesion())
      .set("authorization", `Bearer ${tokenDelPanel({ tenantId: "org-ajena" })}`);
    expect(r.status).toBe(401);
  });

  it("basura en vez de un token no entra", async () => {
    const r = await request(app()).get("/leads/panel").set(cabecerasDeSesion()).set("authorization", "Bearer no.es");
    expect(r.status).toBe(401);
  });
});

describe("normalizarOrigen", () => {
  it("deja esquema, host y puerto, en minúsculas", () => {
    expect(normalizarOrigen("https://ERP.acme.com/")).toBe("https://erp.acme.com");
    expect(normalizarOrigen("http://localhost:5173")).toBe("http://localhost:5173");
  });
  it("lo que no es un origen es null", () => {
    expect(normalizarOrigen("erp.acme.com")).toBeNull();
    expect(normalizarOrigen("null")).toBeNull();
    expect(normalizarOrigen(undefined)).toBeNull();
    expect(normalizarOrigen("ftp://x.y")).toBeNull();
  });
});
