/**
 * Request context that is propagated to all service calls.
 * Contains authentication info, correlation ID, and other request metadata.
 */
export interface IRequestContext {
  /** Unique correlation ID for distributed tracing */
  correlationId: string;

  /** Authenticated user ID */
  userId?: string;

  /** User's email */
  userEmail?: string;

  /** User's roles */
  userRoles?: string[];

  /** Original authorization header (to forward to backend services) */
  authorizationHeader?: string;

  /** Request timestamp */
  timestamp: Date;

  /** Client IP address */
  clientIp?: string;

  /** User agent string */
  userAgent?: string;

  /**
   * La organización de la sesión. Sólo la traen las peticiones del panel
   * incrustado (`src/widgets/panel-leads`), donde la pone el gateway tras el
   * `auth_request`; el chat no tiene sesión y la deja sin fijar.
   */
  tenantId?: string;

  /** Los permisos resueltos por ms-auth en esta petición (sólo el panel). */
  userPermissions?: string[];
}
