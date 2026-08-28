import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import { ControlUiGitHubError } from "./control-ui-github-api.js";

const RATE_LIMIT_FALLBACK_MS = 60_000;
const CAPACITY_RETRY_MS = 1_000;
const CACHE_LIMIT = 200;

export type ResolvedGitHubUserIdentity = { accountId: number; login: string };

class GitHubUserIdentityCoordinator {
  private readonly backoffs = new Map<string, number>();
  private pendingLookups = 0;
  private queue = new KeyedAsyncQueue();

  lookup(params: {
    credentialScope: string;
    request: () => Promise<ResolvedGitHubUserIdentity>;
  }): Promise<ResolvedGitHubUserIdentity> {
    const backoffRemaining = this.backoffRemaining(params.credentialScope);
    if (backoffRemaining > 0) {
      return Promise.reject(this.rateLimitError(backoffRemaining));
    }
    if (this.pendingLookups >= CACHE_LIMIT) {
      return Promise.reject(this.capacityError());
    }
    return this.queue.enqueue(
      params.credentialScope,
      async () => {
        const queuedBackoffRemaining = this.backoffRemaining(params.credentialScope);
        if (queuedBackoffRemaining > 0) {
          throw this.rateLimitError(queuedBackoffRemaining);
        }
        try {
          return await params.request();
        } catch (error) {
          if (error instanceof ControlUiGitHubError && error.statusCode === 429) {
            const retryAfterMs = error.retryAfterMs ?? RATE_LIMIT_FALLBACK_MS;
            this.setBackoff(params.credentialScope, retryAfterMs);
          }
          throw error;
        }
      },
      {
        onEnqueue: () => {
          this.pendingLookups += 1;
        },
        onSettle: () => {
          this.pendingLookups -= 1;
        },
      },
    );
  }

  reset(): void {
    this.backoffs.clear();
    this.pendingLookups = 0;
    this.queue = new KeyedAsyncQueue();
  }

  private backoffRemaining(credentialScope: string): number {
    const blockedUntil = this.backoffs.get(credentialScope) ?? 0;
    const remaining = Math.max(0, blockedUntil - Date.now());
    if (remaining === 0) {
      this.backoffs.delete(credentialScope);
    }
    return remaining;
  }

  private capacityError(): ControlUiGitHubError {
    return new ControlUiGitHubError(
      429,
      `GitHub identity lookup capacity reached; retry after ${CAPACITY_RETRY_MS}ms`,
      { retryAfterMs: CAPACITY_RETRY_MS },
    );
  }

  private rateLimitError(retryAfterMs: number): ControlUiGitHubError {
    return new ControlUiGitHubError(
      429,
      `GitHub identity lookup rate limited; retry after ${retryAfterMs}ms`,
      { retryAfterMs },
    );
  }

  private setBackoff(credentialScope: string, retryAfterMs: number): void {
    // GitHub quotas belong to the credential (or anonymous source IP), so one
    // quota response stops every identity lookup in that scope until reset.
    this.backoffs.delete(credentialScope);
    this.backoffs.set(credentialScope, Date.now() + retryAfterMs);
    while (this.backoffs.size > CACHE_LIMIT) {
      const oldestKey = this.backoffs.keys().next().value;
      if (typeof oldestKey !== "string") {
        return;
      }
      this.backoffs.delete(oldestKey);
    }
  }
}

export const githubUserIdentityCoordinator = new GitHubUserIdentityCoordinator();
