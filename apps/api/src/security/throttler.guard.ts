import { type ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerRequest,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { ProblemError } from '../common/problem.js';
import { API_DEPS, type ApiDeps } from '../deps.js';
import { ApiMetricsService } from '../observability/metrics.service.js';

export type ThrottleGroupName = 'upload' | 'review' | 'read';

export const THROTTLE_GROUP_KEY = 'api:throttle_group';

export const ThrottleGroup = (group: ThrottleGroupName) => SetMetadata(THROTTLE_GROUP_KEY, group);

/**
 * In-memory per-IP throttler (spec §8):
 * - Keys strictly on Express `req.ip` (which trusts X-Forwarded-For ONLY from TRUST_PROXY_CIDR).
 * - Applies per-group limits from ApiConfig (upload 10/min, review 120/min, read 600/min).
 * - Emits RFC 9457 429 RATE_LIMITED and increments `rate_limited_total`.
 */
@Injectable()
export class ApiThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    @Inject(Reflector) reflector: Reflector,
    @Inject(API_DEPS) private readonly deps: ApiDeps,
    @Inject(ApiMetricsService) private readonly metrics: ApiMetricsService,
  ) {
    super(options, storageService, reflector);
  }

  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const ip =
      typeof req['ip'] === 'string' && req['ip'].length > 0
        ? req['ip']
        : ((req['socket'] as { remoteAddress?: string } | undefined)?.remoteAddress ?? 'unknown');
    return Promise.resolve(ip);
  }

  private resolveGroup(context: ExecutionContext): ThrottleGroupName {
    return (
      this.reflector.getAllAndOverride<ThrottleGroupName | undefined>(THROTTLE_GROUP_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'read'
    );
  }

  private limitFor(group: ThrottleGroupName): number {
    switch (group) {
      case 'upload':
        return this.deps.config.THROTTLE_UPLOAD_LIMIT;
      case 'review':
        return this.deps.config.THROTTLE_REVIEW_LIMIT;
      case 'read':
        return this.deps.config.THROTTLE_READ_LIMIT;
    }
  }

  protected override generateKey(context: ExecutionContext, suffix: string, name: string): string {
    const group = this.resolveGroup(context);
    return `${name}:${group}:${suffix}`;
  }

  protected override handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const group = this.resolveGroup(requestProps.context);
    return super.handleRequest({
      ...requestProps,
      limit: this.limitFor(group),
    });
  }

  protected override throwThrottlingException(): Promise<void> {
    this.metrics.incRateLimited();
    throw new ProblemError('RATE_LIMITED', 'Too many requests');
  }
}
