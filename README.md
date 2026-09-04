# 🤖 BFF Widget

Backend for Frontend del **GIA Widget** (chatbot flotante `<chat-float>`). Orquesta las llamadas a los microservicios de la plataforma GIA y expone una API estable y agregada para el widget embebible.

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

La red `coolify` es externa; debe existir previamente (la crea el orquestador Coolify). Redis y los microservicios upstream se consumen por DNS interno (`redis-global-gia-dev`, `ms-auth-gia-dev`, `ms-agents-gia-dev`, `ms-customers-gia-dev`, `ms-leads-gia-dev`).

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
