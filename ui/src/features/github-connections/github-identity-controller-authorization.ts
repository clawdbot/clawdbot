import { resolveSafeTimeoutDelayMs } from "@openclaw/gateway-client/browser";
import type { UsersGitHubAuthorizePollResult } from "../../../../packages/gateway-protocol/src/schema/users.ts";
import type {
  ToolsGitHubAuthorizePollResult,
  ToolsGitHubAuthorizeStartResult,
} from "../../api/types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  cancelAuthorizationRequest,
  githubAuthorizationMethod,
  type AuthorizationOperation,
  type GitHubAuthorizationState,
  type GitHubIdentityHost,
  type RequestOwner,
} from "./github-identity-controller-shared.ts";

type AuthorizationPollResult = ToolsGitHubAuthorizePollResult | UsersGitHubAuthorizePollResult;
type AuthorizationHost = GitHubIdentityHost & {
  isCurrent: (owner: RequestOwner) => boolean;
  begin: (owner: RequestOwner) => void;
  finish: (owner: RequestOwner, succeeded: boolean) => void;
  applySuccess: (
    owner: RequestOwner,
    result: Extract<AuthorizationPollResult, { status: "success" }>,
    refreshError: string | null,
  ) => void;
};

// The device flow owns timers and cancellation; callers own connection/access fences
// and the distinct personal-credential or shared-configuration mutation boundary.
export class GitHubDeviceAuthorizationController {
  state: GitHubAuthorizationState = { phase: "idle" };
  private operation: AuthorizationOperation | null = null;
  constructor(private readonly host: AuthorizationHost) {}

  get active(): boolean {
    return this.operation !== null;
  }

  private isCurrent(operation: AuthorizationOperation) {
    return this.operation === operation && this.host.isCurrent(operation.owner);
  }

  retire(notifyServer: boolean) {
    const operation = this.operation;
    this.operation = null;
    this.state = { phase: "idle" };
    if (!operation) {
      return;
    }
    if (operation.timer !== undefined) {
      clearTimeout(operation.timer);
    }
    operation.controller.abort();
    if (notifyServer) {
      cancelAuthorizationRequest(operation);
    }
  }

  restore(owner: RequestOwner, start: ToolsGitHubAuthorizeStartResult) {
    if (this.active || !this.host.isCurrent(owner)) {
      return;
    }
    const operation: AuthorizationOperation = {
      owner,
      controller: new AbortController(),
      requestId: start.requestId,
      start,
      displayExpiresAtMs: Date.now() + start.expiresInMs,
    };
    this.operation = operation;
    this.present(operation, "code");
    this.schedule(operation, start.pollAfterMs);
  }

  private present(
    operation: AuthorizationOperation,
    phase: "code" | "pending" | "network_error" | "cancelling" | "finishing" | "cancel_error",
    slowedDown?: boolean,
  ) {
    if (!operation.start) {
      return;
    }
    this.state = {
      ...operation.start,
      displayExpiresAtMs: operation.displayExpiresAtMs ?? Date.now(),
      phase,
      ...(operation.cancelError ? { message: operation.cancelError } : {}),
      ...(slowedDown ? { slowedDown: true } : {}),
    };
    this.host.requestUpdate();
  }

  async start(owner: RequestOwner) {
    const operation: AuthorizationOperation = { owner, controller: new AbortController() };
    this.operation = operation;
    this.state = { phase: "starting" };
    this.host.requestUpdate();
    try {
      const target = owner.target;
      const result = await owner.client.request<ToolsGitHubAuthorizeStartResult>(
        githubAuthorizationMethod(owner, "start"),
        target.kind === "personal" ? {} : { scope: target.scope, agentId: target.agentId },
        { signal: operation.controller.signal },
      );
      operation.requestId = result.requestId;
      operation.start = result;
      operation.displayExpiresAtMs = Date.now() + result.expiresInMs;
      if (!this.isCurrent(operation)) {
        cancelAuthorizationRequest(operation);
        return;
      }
      if (operation.cancelRequested) {
        await this.finishCancellation(operation);
        return;
      }
      this.present(operation, "code");
      this.schedule(operation, result.pollAfterMs);
    } catch (error) {
      if (!this.isCurrent(operation)) {
        return;
      }
      this.operation = null;
      this.state = { phase: "failed", message: formatUiError(error) };
      this.host.requestUpdate();
    }
  }

  async cancel() {
    const operation = this.operation;
    if (!operation || operation.cancelRequested || operation.cancelInFlight) {
      return;
    }
    operation.cancelRequested = true;
    operation.cancelError = undefined;
    if (operation.start) {
      this.present(operation, "cancelling");
    } else {
      this.state = { phase: "cancelling" };
      this.host.requestUpdate();
    }
    if (operation.requestId) {
      await this.finishCancellation(operation);
    }
  }

  private async finishCancellation(operation: AuthorizationOperation) {
    if (!operation.requestId || operation.cancelInFlight || !this.isCurrent(operation)) {
      return;
    }
    operation.cancelInFlight = true;
    try {
      const result = await operation.owner.client.request<{ cancelled: boolean }>(
        githubAuthorizationMethod(operation.owner, "cancel"),
        { requestId: operation.requestId },
      );
      if (!this.isCurrent(operation)) {
        return;
      }
      if (result.cancelled) {
        this.retire(false);
        this.host.finish(operation.owner, false);
        this.host.requestUpdate();
        return;
      }
      operation.cancelTooLate = true;
      this.present(operation, "finishing");
    } catch (error) {
      if (!this.isCurrent(operation)) {
        return;
      }
      operation.cancelRequested = false;
      operation.cancelError = formatUiError(error);
      this.present(operation, "cancel_error");
    } finally {
      operation.cancelInFlight = false;
    }
    // A cancellation made during start has no poll timer yet.
    if (operation.timer === undefined && !operation.pollInFlight) {
      this.schedule(operation, operation.start!.pollAfterMs);
    }
  }

  private schedule(operation: AuthorizationOperation, delayMs: number) {
    if (!this.isCurrent(operation) || !operation.start) {
      return;
    }
    if (operation.timer !== undefined) {
      clearTimeout(operation.timer);
    }
    operation.timer = setTimeout(
      () => {
        operation.timer = undefined;
        if (this.isCurrent(operation)) {
          void this.poll(operation);
        }
      },
      resolveSafeTimeoutDelayMs(delayMs, { minMs: 0 }),
    );
  }

  private async requestPoll(operation: AuthorizationOperation) {
    const request = () =>
      operation.owner.client.request<AuthorizationPollResult>(
        githubAuthorizationMethod(operation.owner, "poll"),
        { requestId: operation.requestId },
        { signal: operation.controller.signal },
      );
    if (operation.owner.target.kind === "personal") {
      return { result: await request(), refreshError: null };
    }
    if (!this.host.runExternalMutation) {
      throw new Error("Shared GitHub configuration is unavailable.");
    }
    const mutation = await this.host.runExternalMutation(
      (client) => {
        if (client !== operation.owner.client) {
          throw new Error("Connection changed before GitHub authorization was checked.");
        }
        return request();
      },
      {
        canDispatch: () => this.isCurrent(operation),
        dispatchError: "Access changed before GitHub authorization was checked.",
        shouldRefresh: (result) => result.status === "success",
      },
    );
    if (!mutation.ok) {
      throw new Error(mutation.error);
    }
    return {
      result: mutation.value,
      refreshError: mutation.refresh.ok ? null : mutation.refresh.error,
    };
  }

  private async poll(operation: AuthorizationOperation) {
    if (!operation.requestId || !operation.start || !this.isCurrent(operation)) {
      return;
    }
    this.present(
      operation,
      operation.cancelTooLate ? "finishing" : operation.cancelError ? "cancel_error" : "pending",
    );
    operation.pollInFlight = true;
    this.host.begin(operation.owner);
    let succeeded = false;
    try {
      const { result, refreshError } = await this.requestPoll(operation);
      if (!this.isCurrent(operation)) {
        return;
      }
      if (
        result.status === "pending" ||
        result.status === "slow_down" ||
        result.status === "network_error"
      ) {
        const phase = operation.cancelTooLate
          ? "finishing"
          : operation.cancelError
            ? "cancel_error"
            : result.status === "network_error"
              ? "network_error"
              : "pending";
        this.present(operation, phase, result.status === "slow_down");
        this.schedule(operation, result.retryAfterMs);
        return;
      }
      if (result.status === "success") {
        this.host.applySuccess(operation.owner, result, refreshError);
        this.state = { phase: "idle" };
        succeeded = true;
      } else {
        this.state = { phase: result.status };
      }
      this.operation = null;
    } catch (error) {
      if (this.isCurrent(operation)) {
        this.operation = null;
        this.state = { phase: "failed", message: formatUiError(error) };
      }
    } finally {
      operation.pollInFlight = false;
      this.host.finish(operation.owner, succeeded);
    }
  }
}
