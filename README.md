# 🤖 BFF Widget

Backend for Frontend del **GIA Widget** (chatbot flotante `<chat-float>`). Orquesta las llamadas a los microservicios de la plataforma GIA y expone una API estable y agregada para el widget embebible.

Orquesta: **ms-agents** (chat / IA), **ms-auth** (validación de token de organización / RBAC) y **ms-customers** (datos de cliente / tenant).

### 🚥 Mapa de Infraestructura (Regla del 20)

| Servicio | Puerto Interno | Descripción |
| :--- | :---: | :--- |
| **API Gateway** | 80 | Punto de entrada único (Nginx) |
| **ms-auth** | 3020 | Autenticación y RBAC |
| **ms-agents** | 3040 | Agentes e IA (chatbot) |
| **ms-customers** | 3000 | Clientes / tenants |
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

La red `coolify` es externa; debe existir previamente (la crea el orquestador Coolify). Redis y los microservicios upstream se consumen por DNS interno (`redis-global-gia-dev`, `ms-auth-gia-dev`, `ms-agents-gia-dev`, `ms-customers-gia-dev`).

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
