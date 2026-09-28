import { createClient } from "redis";

const AUDIT_TOPIC = "audit.event";

interface AuditEvent {
  tenantId: string;
  actorId: string;
  actorRole?: string;
  actorEmail?: string;
  action: string;
  resource: string;
  resourceId?: string;
  resourceName?: string;
  payload?: unknown;
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
  service: string;
}

let publisher: ReturnType<typeof createClient> | null = null;

async function getPublisher() {
  if (!publisher) {
    publisher = createClient({
      socket: {
        host: process.env.REDIS_HOST || "redis-global-gia",
        port: parseInt(process.env.REDIS_PORT || "6379"),
        reconnectStrategy: (retries) => Math.min(retries * 200, 2000),
      },
      // Spread condicional: pasar `password: undefined` haría que node-redis
      // mandara AUTH igualmente, y un Redis sin requirepass rechaza la conexión
      // con "ERR Client sent AUTH, but no password is set".
      ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
    });
    publisher.on("error", (err: Error) => console.error("[audit] Redis error:", err));
    await publisher.connect();
  }
  return publisher;
}

export async function publishAudit(event: AuditEvent): Promise<void> {
  try {
    const client = await getPublisher();
    await client.publish(AUDIT_TOPIC, JSON.stringify(event));
  } catch (err) {
    console.error("[audit] Failed to publish audit event:", err);
  }
}
