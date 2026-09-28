/**
 * Preparación común de las pruebas.
 *
 * La configuración lee `BFF_JWT_SECRET` al importarse y, si no está, **cae a la
 * cadena literal `"change-me"`**. Fijarlo aquí hace las pruebas deterministas y,
 * de paso, evita que una suite pase por usar ese valor por defecto.
 */

process.env.BFF_JWT_SECRET ??= "secreto-de-pruebas-no-usar-fuera";
// El panel incrustado (src/widgets/panel-leads) lee el token de servicio y las
// direcciones de sus servicios; en las pruebas los clientes se sustituyen y
// estos valores sólo tienen que existir.
process.env.INTERNAL_SERVICE_TOKEN ??= "token-interno-de-pruebas";
process.env.MS_AUTH_URL ??= "http://ms-auth.test";
process.env.MS_LEADS_URL ??= "http://ms-leads.test";
process.env.MS_AGENTS_URL ??= "http://ms-agents.test";
process.env.MS_MESSAGING_URL ??= "http://ms-messaging.test";
process.env.MS_AUDIT_URL ??= "http://ms-audit.test";
