# 🤖 BFF Widget

Backend for Frontend de **los widgets incrustables de GIA**: el chat flotante `<chat-float>` y el panel de leads `<gia-panel-leads>`. Orquesta las llamadas a los microservicios de la plataforma GIA y expone una API estable y agregada para lo que se pega en webs de terceros.

## Un módulo por widget

Todos los widgets entran por **este** BFF (es la puerta común de lo que se incrusta fuera), pero **cada widget vive en su carpeta** bajo `src/widgets/<widget>/`, con sus rutas, su contexto, sus clientes de servicio, su auditoría y sus pruebas. Lo único compartido es la maquinaria: `server.ts`, el cliente HTTP base (`src/bff/infrastructure/service-clients/base-service-client.ts`) y la configuración de servicios (`config/backend-services.json`). La regla es que **un cambio en un widget no toca a otro**: si para algo del panel hace falta cambiar un cliente del chat, ese algo va al módulo del panel.

| Widget | Módulo | Puerta en el gateway | Sesión |
| :--- | :--- | :--- | :--- |
| Chat `<chat-float>` | `src/api/` (el original) | `/v1/widget/` → `/v1/chat`, `/v1/widget`, `/v1/fichero` (el prefijo se quita) | ninguna: visitante anónimo, `unique-tenant-token` |
| Panel de leads `<gia-panel-leads>` | `src/widgets/panel-leads/` | `/v1/panel/` → `/v1/panel/...` (el prefijo se **conserva**) | token del panel (`purpose: "panel"`), revalidado en ms-auth en cada petición |

Un widget nuevo es una carpeta nueva en `src/widgets/`, montada con su prefijo en `src/api/api.ts`, y una `location` propia en el gateway.

Orquesta: **ms-agents** (chat / IA), **ms-leads** (Gia Leads: lead, conversación y clasificación del visitante), **ms-auth** (validación de token de organización / RBAC) y **ms-customers** (datos de cliente / tenant).

### 🚥 Mapa de Infraestructura (Regla del 20)

| Servicio | Puerto Interno | Descripción |
| :--- | :---: | :--- |
| **API Gateway** | 80 | Punto de entrada único (Nginx) |
| **ms-auth** | 3020 | Autenticación y RBAC |
| **ms-agents** | 3040 | Agentes e IA (chatbot) |
| **ms-customers** | 3000 | Clientes / tenants |
| **ms-leads** | 3150 | Gia Leads (segunda puerta del chat) |
| **bff-globaloffice** | 3060 | BFF para Global Office |
| **bff-backoffice** | 3080 | BFF para Backoffice |
| **bff-frontoffice** | 3110 | BFF para Front Office |
| **bff-widget** | 3000 | BFF para el GIA Widget |

> El BFF escucha internamente en el puerto **3000** y **no publica puertos al host**: la comunicación entre contenedores de la red `coolify` se resuelve por nombre (`bff-widget-gia-dev` / `-prod`), no por el puerto expuesto.

## 🚀 Desarrollo Local

Este BFF usa un sistema de Hot Refresh dentro de Docker.

1. Copiar `.env.example` a `.env`.
2. Copiar `docker-compose.override.example.yaml` a `docker-compose.override.yaml`.
3. Ejecutar `docker-compose up -d --build`.

La red `coolify` es externa; debe existir previamente (la crea el orquestador Coolify). Redis y los microservicios upstream se consumen por DNS interno (`redis-global-gia-dev`, `ms-auth-gia-dev`, `ms-agents-gia-dev`, `ms-customers-gia-dev`, `ms-leads-gia-dev`, y para el panel `ms-messaging-gia-dev` y `ms-audit-gia-dev`).

## 🧩 El panel incrustado de leads (`src/widgets/panel-leads`)

La puerta por la que un producto anfitrión (un ERP, un CRM) opera los leads y la bandeja de una organización desde su pantalla, sin que su gente tenga contraseña de GIA (ADR-046, ADR-047; SPEC-268/271/273/275). No hay lógica de negocio nueva: los datos salen de ms-leads.

**Cómo entra alguien.** 1) El **servidor** del anfitrión firma una aserción con su clave privada y la canjea: `POST /v1/panel/canje {asercion}` → `201 {vale, expiraEn}`. La aserción es un JWS compacto (RS256 o ES256) con cabecera `kid` = id de la credencial registrada en el backoffice y claims `sub` (id de la persona en el anfitrión), `name`, `origin`, `iat`, `exp` (≤ 5 min), `jti`; `email` opcional. Cualquier fallo responde el mismo `403 {"message":"No se pudo emitir la sesión"}`. 2) El **navegador** cambia el vale, una vez y antes de un minuto: `POST /v1/panel/sesion {vale}` → `200 {token, expiresIn, tenantId, userId, role, permissions[], persona}`. 3) Con ese token pide las vistas; no hay refresh: renovar es volver a canjear. 4) Baja: `POST /v1/panel/bajas {asercion}`.

Esas tres rutas son las únicas sin `auth_request` en el gateway; se reenvían a ms-auth (`/v1/auth/internal/panel/*`) con el token de servicio y sin reintentos. Todo lo demás llega con la identidad que ms-auth resolvió (`X-User-Id`, `X-Tenant-Id`, `X-User-Permissions`…) y pasa por la **puerta del panel** (`middlewares/puerta-del-panel.middleware.ts`): 401 si el bearer no es del panel, si el `Origin` no es el que el token lleva dentro o si la organización del token no es la de la sesión. Después, cada ruta declara su permiso (`leads:read` / `leads:attend`, sin comodín).

| Método y ruta | Permiso | Qué devuelve |
| :--- | :---: | :--- |
| `GET /v1/panel/leads/panel` | `leads:read` | `{leads[], solicitudesDeBorrado[]}`, con `degradado[]` si lo pendiente no vino |
| `GET /v1/panel/leads/pendientes` | `leads:read` | las solicitudes de borrado |
| `GET /v1/panel/leads/leads/:leadId/historial` | `leads:read` | la ficha, con `contactos[].actorNombre` y `clases[{id,nombre}]` para corregir la suya |
| `GET /v1/panel/leads/leads/:leadId/clasificaciones` | `leads:read` | el historial de clasificaciones |
| `PUT /v1/panel/leads/leads/:leadId/clase` `{clase, explicacion?}` | `leads:attend` | la clasificación registrada |
| `PUT /v1/panel/leads/leads/:leadId/contacto` `{nombre?, correo?, telefono?}` | `leads:attend` | el lead; ausente no toca, texto pone, `null` vacía |
| `DELETE /v1/panel/leads/leads/:leadId` | `leads:attend` | `204` |
| `GET /v1/panel/leads/conversaciones?estado=` | `leads:read` | `{conversaciones[]}` con `asignadaANombre` |
| `GET /v1/panel/leads/conversaciones/:id/ficha` | `leads:read` | hilo + `lead` + `consumo` + `agente`; sólo el hilo es imprescindible |
| `GET /v1/panel/leads/conversaciones/:id` | `leads:read` | el hilo y su `plazo` |
| `POST /v1/panel/leads/conversaciones/:id/{tomar,liberar,devolver-al-agente}` | `leads:attend` | la conversación; un `409` trae `detalle.laTiene` y `laTieneNombre` |
| `POST /v1/panel/leads/conversaciones/:id/responder` `{texto}` | `leads:attend` | `201` el mensaje |
| `GET /v1/panel/leads/conversaciones/:id/{recursos,consultas}` | `leads:attend` | las herramientas del agente que atiende ESTA conversación |
| `POST /v1/panel/leads/conversaciones/:id/recursos/:recursoId` `{texto}` | `leads:attend` | `201`; un recurso ajeno es `404` |
| `POST /v1/panel/leads/conversaciones/:id/consultas/:consultaId` | `leads:attend` | lo que devolvió la consulta |

No hay catálogo, canales ni ajustes por esta puerta (SPEC-271). Toda lectura y acción publica un evento en ms-audit por Redis con `service: "bff-widget"`, `payload.superficie: "panel-incrustado"` y `payload.origen` (SPEC-273), con tope de un segundo: registrar nunca tumba el trabajo. Variables propias del módulo: `MS_MESSAGING_URL` (qué agente atiende una cuenta de canal) y `MS_AUDIT_URL` (salud); `MS_DOCUMENTS_URL` (ficheros de los recursos) e `INTERNAL_SERVICE_TOKEN` ya existían. Pendiente: SPEC-272 (bandeja en vivo), no incluido; la bandeja se refresca a mano.

## 💬 El chat del widget

`POST /v1/chat/create-chat` — **el único endpoint que consume `<chat-float>`**.

```
headers: unique-tenant-token · ip-address
body:    { message, uniqueTenantToken, agentId?, chatSessionId?, ipAddress?, visitorId? }
```

**Hay dos puertas y las elige el BFF** (SPEC-167 · ADR-034). Antes de atender
consulta `GET /v1/agents/:id/widget-config` de ms-agents (SPEC-162), lo memoriza
por agente durante `BFF_CACHE_DEFAULT_TTL`, y según el interruptor:

- `leadsEnabled: false`, sin `agentId`, sin `visitorId`, o **si la consulta
  falla** → ms-agents, exactamente como siempre.
- `leadsEnabled: true` → `POST /v1/widget/mensaje` de ms-leads, con la
  organización en `x-tenant-id` (sale de `widget-config`: este BFF tiene un
  *token* de organización, no su identificador).

**La respuesta tiene la misma forma por las dos puertas** — `200 text/plain` con
el texto — para que el componente que ya existe siga sirviendo:

| | ms-agents | ms-leads |
| :--- | :--- | :--- |
| cuerpo | el texto, servido según se escribe | el texto, entero de una vez |
| `Chat-Session-Id` | la sesión de ms-agents | *(no se emite)* |
| `Contact-Form-Url` | *(no se emite)* | el formulario del tenant, sólo si hubo derivación (RF-020) |

En error: `{ success: false, message }` — `message` es lo que el widget enseña a
quien escribe. Las dos cabeceras nuevas van en `exposedHeaders` del CORS; sin
eso el navegador no deja al widget leerlas.

## 🩺 Health

- `GET /health` — health raíz (usado por el healthcheck del contenedor).
- `GET /v1/health` — health detallado del servicio.
- `GET /v1/health/live` — liveness probe.
- `GET /v1/health/ready` — readiness probe (verifica los MS upstream).
- `GET /v1/health/detailed` — estado agregado de los MS upstream.

## 🧱 Stack

Express 4 · TypeScript (commonjs, ES2022) · pnpm 9.15.4 · Node 20 · undici (HTTP saliente) · pino (logs) · redis (cache) · arquitectura por capas (api → bff/application → bff/domain → bff/infrastructure) con `entities/shared` como núcleo transversal.

## Licencia

ISC - GlobalS1
