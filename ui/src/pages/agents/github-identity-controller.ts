import { resolveSafeTimeoutDelayMs } from "@openclaw/gateway-client/browser";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  ToolsGitHubAuthorizePollResult,
  ToolsGitHubAuthorizeStartResult,
  ToolsGitHubStatusResult,
} from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { resolveAgentConfig } from "../../lib/agents/display.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  runGitHubIdentityConfigure,
  runGitHubIdentityInherit,
} from "./github-identity-controller-mutations.ts";
import {
  cancelAuthorizationRequest,
  configFingerprint,
  readGitHubIdentityDraft,
  type AuthorizationOperation,
  type GitHubAuthorizationState,
  type GitHubIdentityDraft,
  type GitHubIdentityHost,
  type GitHubIdentityScope,
  type RequestOwner,
} from "./github-identity-controller-shared.ts";

export class GitHubIdentityController {
  status: ToolsGitHubStatusResult | null = null;
  scope: GitHubIdentityScope = "system";
  authorization: GitHubAuthorizationState = { phase: "idle" };
  loading = false;
  busy = false;
  error: string | null = null;
  statusReadable = false;
  configurable = false;
  authorizable = false;
  tokenRevealed = false;
  patVisible = false;

  private agentId: string | null = null;
  private client: GatewayBrowserClient | null = null;
  private connected = false;
  private clientRevision = -1;
  private agentRevision = -1;
  private requestRevision = 0;
  private displayedIdentityFingerprint = "";
  private identityInitialized = false;
  private verificationQueued = false;
  private confirmationPending = false;
  private mutationOwner: RequestOwner | null = null;
  private mutationIdentityChanged = false;
  private authorizationOperation: AuthorizationOperation | null = null;
  private drafts: Record<GitHubIdentityScope, GitHubIdentityDraft> = {
    system: readGitHubIdentityDraft(undefined),
    agent: readGitHubIdentityDraft(undefined),
  };
  private draftDirty: Record<GitHubIdentityScope, boolean> = { system: false, agent: false };
  private configFingerprints: Record<GitHubIdentityScope, string> = { system: "", agent: "" };

  constructor(private readonly host: GitHubIdentityHost) {}

  get authorizationActive(): boolean {
    return (
      this.authorization.phase === "starting" ||
      this.authorization.phase === "code" ||
      this.authorization.phase === "pending" ||
      this.authorization.phase === "network_error" ||
      this.authorization.phase === "cancelling" ||
      this.authorization.phase === "finishing" ||
      this.authorization.phase === "cancel_error"
    );
  }

  get connectionReady(): boolean {
    return this.connected && this.client !== null;
  }

  get draft(): GitHubIdentityDraft {
    return this.drafts[this.scope];
  }

  private queueVerification() {
    if (
      this.verificationQueued ||
      this.confirmationPending ||
      !this.statusReadable ||
      !this.connected ||
      !this.agentId ||
      this.authorizationActive
    ) {
      return;
    }
    this.verificationQueued = true;
    queueMicrotask(() => {
      this.verificationQueued = false;
      void this.verify();
    });
  }

  sync(params: {
    client: GatewayBrowserClient | null;
    connected: boolean;
    agentId: string | null;
    config: Record<string, unknown> | null;
    statusReadable: boolean;
    configurable: boolean;
    authorizable: boolean;
    clientRevision: number;
  }) {
    const clientChanged =
      this.client !== params.client ||
      this.connected !== params.connected ||
      this.clientRevision !== params.clientRevision;
    const agentChanged = this.agentId !== params.agentId;
    const capabilityChanged =
      this.statusReadable !== params.statusReadable ||
      this.configurable !== params.configurable ||
      this.authorizable !== params.authorizable;
    if (this.authorizationActive && (clientChanged || agentChanged || !params.authorizable)) {
      this.retireAuthorization(true);
      this.authorization = { phase: "idle" };
    }
    if (clientChanged || agentChanged || capabilityChanged) {
      this.requestRevision += 1;
    }
    this.client = params.client;
    this.connected = params.connected;
    this.clientRevision = params.clientRevision;
    this.statusReadable = params.statusReadable;
    this.configurable = params.configurable;
    this.authorizable = params.authorizable;
    this.agentId = params.agentId;
    if (agentChanged) {
      this.agentRevision += 1;
    }
    const resolved = params.agentId ? resolveAgentConfig(params.config, params.agentId) : null;
    const values = {
      system: resolved?.globalTools?.github,
      agent: resolved?.entry?.tools?.github,
    };
    const displayedScope = agentChanged ? (values.agent ? "agent" : "system") : this.scope;
    const displayedIdentityFingerprint = configFingerprint({
      effective: values.agent ?? values.system,
      selectedScope: displayedScope,
      selected: values[displayedScope],
    });
    const identityChanged =
      this.identityInitialized &&
      this.displayedIdentityFingerprint !== displayedIdentityFingerprint;
    this.displayedIdentityFingerprint = displayedIdentityFingerprint;
    this.identityInitialized = true;
    const mutationOwner = this.mutationOwner;
    const mutationOwnsIdentityChange =
      identityChanged && mutationOwner !== null && this.busy && this.isCurrent(mutationOwner);
    if (mutationOwnsIdentityChange) {
      this.mutationIdentityChanged = true;
    } else if (identityChanged) {
      this.requestRevision += 1;
      if (this.authorizationActive) {
        this.retireAuthorization(true);
        this.authorization = { phase: "idle" };
      }
    }
    if (clientChanged || agentChanged || capabilityChanged) {
      this.mutationOwner = null;
      this.mutationIdentityChanged = false;
    }
    if (clientChanged || agentChanged) {
      this.status = null;
      this.error = null;
      this.loading = false;
      this.busy = false;
      this.tokenRevealed = false;
      this.patVisible = false;
      this.authorization = { phase: "idle" };
      this.drafts = {
        system: readGitHubIdentityDraft(values.system),
        agent: readGitHubIdentityDraft(values.agent),
      };
      this.draftDirty = { system: false, agent: false };
      this.configFingerprints = {
        system: configFingerprint(values.system),
        agent: configFingerprint(values.agent),
      };
      this.scope = displayedScope;
      return;
    }
    if (capabilityChanged) {
      this.loading = false;
      this.busy = false;
    }
    for (const scope of ["system", "agent"] as const) {
      const fingerprint = configFingerprint(values[scope]);
      if (!this.draftDirty[scope] && this.configFingerprints[scope] !== fingerprint) {
        this.drafts = { ...this.drafts, [scope]: readGitHubIdentityDraft(values[scope]) };
        this.configFingerprints = { ...this.configFingerprints, [scope]: fingerprint };
      }
    }
    if (identityChanged && !mutationOwnsIdentityChange) {
      this.status = null;
      this.error = null;
      this.loading = false;
      this.queueVerification();
    }
  }

  selectScope(scope: GitHubIdentityScope) {
    if (scope === this.scope || this.authorizationActive) {
      return;
    }
    this.retireAuthorization(true);
    this.requestRevision += 1;
    this.scope = scope;
    this.status = null;
    this.error = null;
    this.tokenRevealed = false;
    this.authorization = { phase: "idle" };
    this.host.requestUpdate();
    this.queueVerification();
  }

  showPatFallback() {
    if (!this.authorizationActive) {
      this.patVisible = true;
      this.host.requestUpdate();
    }
  }

  hidePatFallback() {
    if (this.busy) {
      return;
    }
    this.patVisible = false;
    this.tokenRevealed = false;
    this.host.requestUpdate();
  }

  toggleTokenVisibility() {
    this.tokenRevealed = !this.tokenRevealed;
    this.host.requestUpdate();
  }

  setDraft(field: keyof GitHubIdentityDraft, value: string) {
    this.drafts = {
      ...this.drafts,
      [this.scope]: { ...this.drafts[this.scope], [field]: value },
    };
    this.draftDirty = { ...this.draftDirty, [this.scope]: true };
    this.host.requestUpdate();
  }

  dispose = () => this.retireAuthorization(true);

  private captureRequest(): RequestOwner | null {
    if (!this.client || !this.connected || !this.agentId) {
      return null;
    }
    return {
      client: this.client,
      agentId: this.agentId,
      clientRevision: this.clientRevision,
      agentRevision: this.agentRevision,
      requestRevision: ++this.requestRevision,
    };
  }

  private isCurrent(owner: RequestOwner): boolean {
    return (
      this.client === owner.client &&
      this.connected &&
      this.agentId === owner.agentId &&
      this.clientRevision === owner.clientRevision &&
      this.agentRevision === owner.agentRevision &&
      this.requestRevision === owner.requestRevision
    );
  }

  private isCurrentAuthorization(operation: AuthorizationOperation): boolean {
    return (
      this.authorizationOperation === operation &&
      this.scope === operation.scope &&
      this.authorizable &&
      this.isCurrent(operation.owner)
    );
  }

  private retireAuthorization(notifyServer: boolean) {
    const operation = this.authorizationOperation;
    this.authorizationOperation = null;
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

  async cancelAuthorization() {
    const operation = this.authorizationOperation;
    if (!operation || operation.cancelRequested || operation.cancelInFlight) {
      return;
    }
    operation.cancelRequested = true;
    operation.cancelError = undefined;
    this.authorization = operation.start
      ? {
          ...operation.start,
          displayExpiresAtMs: operation.displayExpiresAtMs ?? Date.now(),
          phase: "cancelling",
        }
      : { phase: "cancelling" };
    this.host.requestUpdate();
    if (operation.requestId) {
      await this.finishExplicitCancellation(operation);
    }
  }

  private async finishExplicitCancellation(operation: AuthorizationOperation) {
    if (
      !operation.requestId ||
      operation.cancelInFlight ||
      !this.isCurrentAuthorization(operation)
    ) {
      return;
    }
    operation.cancelInFlight = true;
    try {
      const result = await operation.owner.client.request<{ cancelled: boolean }>(
        "tools.github.authorize.cancel",
        { requestId: operation.requestId },
      );
      if (!this.isCurrentAuthorization(operation)) {
        return;
      }
      if (result.cancelled) {
        this.retireAuthorization(false);
        this.authorization = { phase: "idle" };
        this.busy = false;
        this.host.requestUpdate();
        return;
      }
      operation.cancelTooLate = true;
      this.authorization = {
        ...operation.start!,
        displayExpiresAtMs: operation.displayExpiresAtMs ?? Date.now(),
        phase: "finishing",
      };
      this.host.requestUpdate();
    } catch (error) {
      if (!this.isCurrentAuthorization(operation)) {
        return;
      }
      operation.cancelRequested = false;
      operation.cancelError = formatUiError(error);
      this.authorization = operation.start
        ? {
            ...operation.start,
            displayExpiresAtMs: operation.displayExpiresAtMs ?? Date.now(),
            phase: "cancel_error",
            message: operation.cancelError,
          }
        : { phase: "failed", message: operation.cancelError };
      this.host.requestUpdate();
    } finally {
      operation.cancelInFlight = false;
    }
  }

  private scheduleAuthorizationPoll(operation: AuthorizationOperation, delayMs: number) {
    if (!this.isCurrentAuthorization(operation) || !operation.start) {
      return;
    }
    if (operation.timer !== undefined) {
      clearTimeout(operation.timer);
    }
    const safeDelayMs = resolveSafeTimeoutDelayMs(delayMs, {
      minMs: 0,
    });
    operation.timer = setTimeout(() => {
      operation.timer = undefined;
      if (!this.isCurrentAuthorization(operation)) {
        return;
      }
      void this.pollAuthorization(operation);
    }, safeDelayMs);
  }

  async startAuthorization() {
    if (!this.authorizable || this.authorizationActive || this.busy) {
      return;
    }
    const owner = this.captureRequest();
    if (!owner) {
      return;
    }
    const operation: AuthorizationOperation = {
      owner,
      scope: this.scope,
      controller: new AbortController(),
    };
    this.authorizationOperation = operation;
    this.authorization = { phase: "starting" };
    this.error = null;
    this.patVisible = false;
    this.host.requestUpdate();
    try {
      const result = await owner.client.request<ToolsGitHubAuthorizeStartResult>(
        "tools.github.authorize.start",
        { scope: operation.scope, agentId: owner.agentId },
        { signal: operation.controller.signal },
      );
      operation.requestId = result.requestId;
      operation.start = result;
      operation.displayExpiresAtMs = Date.now() + result.expiresInMs;
      if (!this.isCurrentAuthorization(operation)) {
        cancelAuthorizationRequest(operation);
        return;
      }
      if (operation.cancelRequested) {
        await this.finishExplicitCancellation(operation);
        return;
      }
      this.authorization = {
        ...result,
        displayExpiresAtMs: operation.displayExpiresAtMs,
        phase: "code",
      };
      this.host.requestUpdate();
      this.scheduleAuthorizationPoll(operation, result.pollAfterMs);
    } catch (error) {
      if (!this.isCurrentAuthorization(operation)) {
        return;
      }
      this.authorizationOperation = null;
      if (!(error instanceof Error && error.name === "AbortError")) {
        this.authorization = { phase: "failed", message: formatUiError(error) };
        this.host.requestUpdate();
      }
    }
  }

  private async pollAuthorization(operation: AuthorizationOperation) {
    if (!operation.requestId || !operation.start || !this.isCurrentAuthorization(operation)) {
      return;
    }
    this.authorization = {
      ...operation.start,
      displayExpiresAtMs: operation.displayExpiresAtMs ?? Date.now(),
      phase: operation.cancelTooLate
        ? "finishing"
        : operation.cancelError
          ? "cancel_error"
          : "pending",
      ...(operation.cancelError ? { message: operation.cancelError } : {}),
    };
    this.mutationOwner = operation.owner;
    this.mutationIdentityChanged = false;
    this.busy = true;
    this.host.requestUpdate();
    let succeeded = false;
    try {
      const mutation = await this.host.runExternalMutation(
        (client) => {
          if (client !== operation.owner.client) {
            throw new Error("Connection changed before GitHub authorization was checked.");
          }
          return client.request<ToolsGitHubAuthorizePollResult>(
            "tools.github.authorize.poll",
            { requestId: operation.requestId },
            { signal: operation.controller.signal },
          );
        },
        {
          canDispatch: () => this.isCurrentAuthorization(operation),
          dispatchError: "Access changed before GitHub authorization was checked.",
        },
      );
      if (!mutation.ok) {
        throw new Error(mutation.error);
      }
      if (!this.isCurrentAuthorization(operation)) {
        return;
      }
      const result = mutation.value;
      if (result.status === "pending" || result.status === "slow_down") {
        this.authorization = {
          ...operation.start,
          displayExpiresAtMs: operation.displayExpiresAtMs ?? Date.now(),
          phase: operation.cancelTooLate
            ? "finishing"
            : operation.cancelError
              ? "cancel_error"
              : "pending",
          ...(operation.cancelError ? { message: operation.cancelError } : {}),
          ...(result.status === "slow_down" ? { slowedDown: true } : {}),
        };
        this.scheduleAuthorizationPoll(operation, result.retryAfterMs);
        return;
      }
      if (result.status === "network_error") {
        this.authorization = {
          ...operation.start,
          displayExpiresAtMs: operation.displayExpiresAtMs ?? Date.now(),
          phase: "network_error",
        };
        this.scheduleAuthorizationPoll(operation, result.retryAfterMs);
        return;
      }
      this.authorizationOperation = null;
      if (result.status === "success") {
        this.applyMutationStatus(
          operation.owner,
          operation.scope,
          result.githubStatus,
          { ...this.drafts[operation.scope], token: "" },
          mutation.refresh.ok ? null : mutation.refresh.error,
        );
        this.authorization = { phase: "idle" };
        succeeded = true;
        return;
      }
      this.authorization = { phase: result.status };
    } catch (error) {
      if (this.isCurrentAuthorization(operation)) {
        this.authorizationOperation = null;
        if (!(error instanceof Error && error.name === "AbortError")) {
          this.authorization = { phase: "failed", message: formatUiError(error) };
        }
      }
    } finally {
      this.finishMutation(operation.owner, succeeded);
    }
  }

  private finishMutation(owner: RequestOwner, succeeded: boolean) {
    if (this.mutationOwner !== owner) {
      return;
    }
    const verifyAfterSettle = this.mutationIdentityChanged && !succeeded;
    this.mutationOwner = null;
    this.mutationIdentityChanged = false;
    if (!this.isCurrent(owner)) {
      return;
    }
    this.busy = false;
    this.host.requestUpdate();
    if (verifyAfterSettle) {
      this.queueVerification();
    }
  }

  private applyMutationStatus(
    owner: RequestOwner,
    scope: GitHubIdentityScope,
    status: ToolsGitHubStatusResult,
    nextDraft: GitHubIdentityDraft,
    refreshError: string | null,
  ) {
    if (!this.isCurrent(owner)) {
      return;
    }
    if (
      status.agentId !== owner.agentId ||
      status.selectedScope !== scope ||
      status.selected.scope !== scope
    ) {
      throw new Error("Gateway returned GitHub identity status for a different target.");
    }
    this.status = status;
    this.drafts = { ...this.drafts, [scope]: nextDraft };
    this.draftDirty = { ...this.draftDirty, [scope]: false };
    this.tokenRevealed = false;
    this.patVisible = false;
    this.error = refreshError
      ? `GitHub identity was updated, but its configuration refresh failed: ${refreshError}`
      : null;
  }

  async verify() {
    if (
      !this.statusReadable ||
      this.loading ||
      this.busy ||
      this.confirmationPending ||
      this.authorizationActive
    ) {
      return;
    }
    const owner = this.captureRequest();
    const scope = this.scope;
    if (!owner) {
      return;
    }
    this.loading = true;
    this.error = null;
    this.host.requestUpdate();
    try {
      const status = await owner.client.request<ToolsGitHubStatusResult>("tools.github.status", {
        agentId: owner.agentId,
        selectedScope: scope,
      });
      if (this.isCurrent(owner)) {
        if (
          status.agentId !== owner.agentId ||
          status.selectedScope !== scope ||
          status.selected.scope !== scope
        ) {
          throw new Error("Gateway returned GitHub identity status for a different target.");
        }
        this.status = status;
      }
    } catch (error) {
      if (this.isCurrent(owner)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.isCurrent(owner)) {
        this.loading = false;
        this.host.requestUpdate();
      }
    }
  }

  async configure() {
    const scope = this.scope;
    const draft = { ...this.draft };
    if (
      !this.client ||
      !this.connected ||
      !this.agentId ||
      !this.configurable ||
      this.busy ||
      this.authorizationActive
    ) {
      return;
    }
    if (!draft.token.trim()) {
      this.error = t("agentTools.githubPasteToken");
      this.host.requestUpdate();
      return;
    }
    const owner = this.captureRequest();
    if (!owner) {
      return;
    }
    await runGitHubIdentityConfigure({
      ...this.createMutationOwner(owner, scope),
      draft,
    });
  }

  async inherit() {
    const scope = this.scope;
    if (!this.configurable || this.busy || this.authorizationActive) {
      return;
    }
    const owner = this.captureRequest();
    if (!owner) {
      return;
    }
    await runGitHubIdentityInherit({
      ...this.createMutationOwner(owner, scope),
      canContinue: () => this.configurable && !this.busy && !this.authorizationActive,
      setConfirmationPending: (pending) => {
        this.confirmationPending = pending;
      },
    });
  }

  private createMutationOwner(owner: RequestOwner, scope: GitHubIdentityScope) {
    return {
      owner,
      scope,
      isCurrent: () => this.isCurrent(owner),
      isConfigurable: () => this.configurable,
      runExternalMutation: this.host.runExternalMutation,
      begin: () => {
        this.mutationOwner = owner;
        this.mutationIdentityChanged = false;
        this.loading = false;
        this.busy = true;
        this.error = null;
        this.host.requestUpdate();
      },
      applyStatus: (
        status: ToolsGitHubStatusResult,
        nextDraft: GitHubIdentityDraft,
        refreshError: string | null,
      ) => this.applyMutationStatus(owner, scope, status, nextDraft, refreshError),
      finish: (succeeded: boolean) => this.finishMutation(owner, succeeded),
      setError: (error: string) => {
        this.error = error;
      },
    };
  }
}
