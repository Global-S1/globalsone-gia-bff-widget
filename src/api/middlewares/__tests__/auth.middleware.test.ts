// Importados explícitamente, no por `globals: true`: el tsconfig de este repo
// restringe typeRoots, así que "vitest/globals" no resuelve como tipo.
import { beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";

import { authMiddleware } from "../auth.middleware";

/**
 * Primera suite de este repositorio, que hasta hoy no tenía ninguna —y que ni
 * siquiera podía instalarse, porque su pnpm-workspace.yaml no declaraba
 * `packages`.
 *
 * Se cubre `authMiddleware` porque hoy está **escrito y sin montar**: lo exporta
 * este módulo y no lo importa ningún fichero del repositorio. Probarlo no lo
 * monta —montarlo cambia quién puede llamar al BFF y eso se decide en la ola de
 * permisos, no en la de pruebas—, pero deja la red puesta para el día que se
 * monte, que es cuando un fallo aquí se convierte en un agujero de acceso.
 */

const SECRETO = "secreto-de-pruebas-no-usar-fuera";

function contexto(headers: Record<string, string> = {}, path = "/v1/chat/create-chat") {
  const req = { headers: { ...headers }, path } as unknown as Request;
  const json = vi.fn();
  const status = vi.fn(() => ({ json })) as unknown as Response["status"];
  const res = { status, json } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next, status, json };
}

describe("authMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deja pasar las rutas públicas de salud sin pedir credencial", () => {
    const { req, res, next, status } = contexto({}, "/v1/health");

    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });

  it("rechaza con 401 una petición sin cabecera de autorización", () => {
    const { req, res, next, status, json } = contexto();

    authMiddleware(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: "UNAUTHORIZED" }),
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("rechaza una cabecera que no es del tipo Bearer", () => {
    const { req, res, next, status } = contexto({ authorization: "Basic dXNlcjpwYXNz" });

    authMiddleware(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rechaza un Bearer sin token detrás", () => {
    const { req, res, next, status } = contexto({ authorization: "Bearer" });

    authMiddleware(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("acepta un token válido y propaga la identidad hacia los servicios de abajo", () => {
    const token = jwt.sign({ sub: "user-A", roles: ["Client"] }, SECRETO, {
      expiresIn: "5m",
    });
    const { req, res, next, status } = contexto({ authorization: `Bearer ${token}` });

    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
    expect(req.headers["x-user-id"]).toBe("user-A");
    expect(req.headers["x-user-roles"]).toBe("Client");
  });

  it("rechaza un token firmado con OTRO secreto y lo llama token inválido", () => {
    const token = jwt.sign({ sub: "user-A" }, "otro-secreto-cualquiera");
    const { req, res, next, status, json } = contexto({ authorization: `Bearer ${token}` });

    authMiddleware(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: "INVALID_TOKEN", message: "Invalid token" }),
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("distingue un token caducado de uno inválido", () => {
    // No es cosmético: al que llama le sirve saber si tiene que renovar o si su
    // credencial nunca fue buena.
    const token = jwt.sign({ sub: "user-A" }, SECRETO, { expiresIn: "-1s" });
    const { req, res, next, json } = contexto({ authorization: `Bearer ${token}` });

    authMiddleware(req, res, next);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ message: "Token has expired" }),
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("devuelve el identificador de correlación que llegó, para poder seguir el rechazo", () => {
    const { req, res, next, json } = contexto({ "x-correlation-id": "corr-123" });

    authMiddleware(req, res, next);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: "corr-123" }),
    );
  });
});
