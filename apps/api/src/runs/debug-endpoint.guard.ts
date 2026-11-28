import { type CanActivate, Inject, Injectable } from '@nestjs/common';
import { ProblemError } from '../common/problem.js';
import { API_DEPS, type ApiDeps } from '../deps.js';

/**
 * Gates debug-only endpoints BEFORE Nest parameter/query pipes execute so disabled routes
 * always return 404 ROUTE_NOT_FOUND rather than leaking 400 validation errors (spec §7.5 & §8).
 */
@Injectable()
export class DebugEndpointGuard implements CanActivate {
  constructor(@Inject(API_DEPS) private readonly deps: ApiDeps) {}

  canActivate(): boolean {
    if (!this.deps.config.DEBUG_ENDPOINTS) {
      throw new ProblemError('ROUTE_NOT_FOUND', 'Route not found');
    }
    return true;
  }
}
