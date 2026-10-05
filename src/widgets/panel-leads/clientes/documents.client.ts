import { request } from "undici";

/**
 * Lo único que el panel le pide a ms-documents: los ficheros de los recursos
 * de un agente, para que la vista de recursos marque los que faltan (igual
 * que en el backoffice). **No es el cliente de ficheros del chat**: aquél
 * sirve bytes por su llave a un visitante anónimo; éste lista metadatos para
 * una persona con sesión, y la organización viene de esa sesión.
 *
 * `x-internal-token` —sin "service"— es el nombre que exige ESTE servicio
 * (ver el comentario del cliente del chat).
 */
export const DocumentsServiceClient = {
  async recursosDeAgente(organizationId: string | undefined, agentId: string): Promise<{ id: string }[]> {
    const baseUrl = (process.env.MS_DOCUMENTS_URL || "").replace(/\/$/, "");
    if (baseUrl === "") return [];
    const respuesta = await request(`${baseUrl}/v1/agent-resources/agent/${encodeURIComponent(agentId)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "x-internal-token": process.env.INTERNAL_SERVICE_TOKEN || "",
        ...(organizationId ? { "x-tenant-id": organizationId } : {}),
      },
      headersTimeout: 5000,
      bodyTimeout: 5000,
    });
    if (respuesta.statusCode !== 200) {
      await respuesta.body.dump();
      return [];
    }
    const cuerpo = (await respuesta.body.json()) as { data?: { id: string }[] };
    return cuerpo.data ?? [];
  },
};
