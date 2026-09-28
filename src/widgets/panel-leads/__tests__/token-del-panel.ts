/**
 * Un token del panel de mentira: tres partes base64url, sin firma válida.
 * Basta porque esta puerta NO verifica la firma —la verificó ms-auth en el
 * gateway—, sólo lee qué token es.
 */
export function tokenConClaims(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.firma-de-mentira`;
}

export const ORIGEN = "https://erp.acme.com";
export const ORG = "org-acme";

export function tokenDelPanel(extra: Record<string, unknown> = {}): string {
  return tokenConClaims({
    userId: "user-ana",
    tenantId: ORG,
    role: "Panel incrustado · atiende",
    purpose: "panel",
    typ: "panel",
    origin: ORIGEN,
    credentialId: "cred-erp",
    ...extra,
  });
}

export function tokenDelBackoffice(): string {
  return tokenConClaims({ userId: "user-ana", tenantId: ORG, role: "Admin", typ: "access", permissions: "leads:read,leads:attend" });
}

/** Las cabeceras que el gateway inyecta tras el auth_request, más el Origin del navegador. */
export function cabecerasDeSesion(permisos = "leads:read,leads:attend", origen = ORIGEN): Record<string, string> {
  return {
    "x-user-id": "user-ana",
    "x-tenant-id": ORG,
    "x-user-role": "Panel incrustado · atiende",
    "x-user-permissions": permisos,
    "x-user-email": "ana@acme.com",
    origin: origen,
  };
}
