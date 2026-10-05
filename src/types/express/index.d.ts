import { IRequestContext } from "../../bff/domain/interfaces/request-context.interface";
import type { ClaimsDelPanel } from "../../widgets/panel-leads/middlewares/puerta-del-panel.middleware";

declare global {
  namespace Express {
    interface Request {
      user?: {
        sub: string;
        email?: string;
        roles?: string[];
        [key: string]: unknown;
      };
      context?: IRequestContext;
      /** Lo que la puerta del panel incrustado leyó del token, ya comprobado. */
      panel?: ClaimsDelPanel;
    }
  }
}

export {};
