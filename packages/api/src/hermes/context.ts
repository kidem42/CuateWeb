import type { Request } from 'express';
import type { ServerRequest } from '../types/http';

export function hermesRequestContext(request: Request): {
  principal?: { id: string; tenantId?: string };
  config?: object;
} {
  const req = request as ServerRequest;
  return {
    principal: req.user ? { id: req.user.id, tenantId: req.user.tenantId } : undefined,
    config: req.config?.config?.hermes,
  };
}
