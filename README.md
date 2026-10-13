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

## Demo pública DICEA

La API `/v1/demo/:demoId` admite solo las rutas de demo; no expone los endpoints administrativos. El identificador público no es el token de organización del widget antiguo. La sesión privada viaja en `X-Demo-Session`. El BFF descarta cabeceras de identidad e IP aportadas por el visitante y transmite únicamente la IP resuelta por Express.

Configurar `MS_AGENTS_URL`, `INTERNAL_SERVICE_TOKEN` y `TRUSTED_PROXIES` (direcciones/CIDR explícitos de los proxies confiables). Vacío usa la IP del socket: detrás de un gateway, todos compartirían su cupo hasta configurar correctamente los proxies. Los proxies de borde deben normalizar las cabeceras reenviadas; no confiar globalmente en Internet. El gateway debe permitir `X-Demo-Session` en CORS y exponer `Content-Disposition` para descargas; los cambios correspondientes están en el worktree api-gateway de esta tarea.

Las respuestas y descargas llevan `Cache-Control: no-store`. Los errores del servicio conservan su código HTTP. No se reintentan peticiones automáticamente en el BFF; el cliente reenvía el mismo `requestId` al recuperar una solicitud incierta.

Pruebas: `pnpm test:demo` (compilación y pruebas HTTP con upstream aislado). Base pública detrás del gateway: `https://<gateway>/v1/widget/v1`.

Prueba integrada entre repositorios: con los worktrees `globalsone-gia-ms-agents`, `globalsone-gia-bff-backoffice` y este BFF como hermanos, compilar los tres y ejecutar `DEMO_SMOKE_DATABASE_URL=postgres://...@127.0.0.1:<puerto>/demo_documents node tests/integration/stack-smoke.cjs`. Usar una base local desechable: el test crea y elimina un esquema aislado. Comprueba configuración, conversación, reintentos, cupo por IP, contactos y descargas con modelo/documentos simulados. `DEMO_PREVIEW=1` deja una página local en el puerto 4179 para comprobar el widget; iniciar además su Vite en 4178 y terminar la prueba con SIGTERM para limpiar el esquema.

`GET /v1/demo/catalog` alimenta `/demo` del frontoffice sin login. Configurar `DEMO_TENANT_ID` con el UUID del tenant del sitio; solo se listan sus demos habilitadas. No acepta seleccionar tenant mediante query/cabeceras. Si falta configuración, devuelve 503. La habilitación y los límites se gestionan por agente desde el backoffice existente.
