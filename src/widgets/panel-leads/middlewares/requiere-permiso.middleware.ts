import type { NextFunction, Request, Response } from "express";

/**
 * Los dos permisos que el panel incrustado conoce (ADR-046 §4, ADR-051):
 * mirar y atender. Los de canales, catálogo y widget no existen en esta
 * puerta porque no hay ruta que los pida (SPEC-271).
 */
export const PERMISOS_DE_LEADS = {
  /** Ver el panel, la bandeja, la ficha y las conversaciones. */
  VER: "leads:read",
  /** Tomar, liberar, devolver, responder y corregir. */
  ATENDER: "leads:attend",
} as const;

/**
 * Cada ruta declara su permiso. Los permisos llegan en `X-User-Permissions`,
 * resueltos por ms-auth desde la membresía en cada petición (ADR-046 §6).
 *
 * **Sin comodín.** En el backoffice `*` deja pasar al super administrador;
 * aquí nadie pasa por encima: por esta puerta entra gente de un producto
 * ajeno, y un rol de la casa con más de lo que dice sería justo lo que
 * ADR-046 acota.
 */
export function requierePermiso(permiso: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const concedidos = req.context?.userPermissions ?? [];
    if (concedidos.includes(permiso)) {
      next();
      return;
    }
    // 403 y no 404: quien llega aquí ya demostró quién es. Se dice qué permiso
    // falta para que el tenant, que es quien elige el rol de la credencial,
    // sepa qué cambiar.
    res.status(403).json({
      success: false,
      message: "No tienes el permiso necesario para esta acción",
      permisoRequerido: permiso,
    });
  };
}
