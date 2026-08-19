import { resolveSafeTimeoutDelayMs } from "@openclaw/gateway-client/browser";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  ToolsGitHubAuthorizePollResult,
  ToolsGitHubAuthorizeStartResult,
  ToolsGitHubStatusResult,
} from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { resolveAgentConfig } from "../../lib/agents/display.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { generateUUID } from "../../lib/uuid.ts";

type GitHubIdentityScope = "system" | "agent";
type GitHubIdentityDraft = { token: string; name: string; email: string };

type RequestOwner = {
  client: GatewayBrowserClient;
  agentId: string;
  clientRevision: number;
  agentRevision: number;
  requestRevision: number;
};

type AuthorizationPresentation = ToolsGitHubAuthorizeStartResult & {
  phase: "code" | "pending" | "network_error";
  slowedDown?: boolean;
  retryAtMs?: number;
};

type GitHubAuthorizationState =
  | { phase: "idle" }
  | { phase: "starting" }
  | AuthorizationPresentation
  | {
      phase: "access_denied" | "expired" | "incorrect_device_code" | "failed";
      message?: string;
    };

type AuthorizationOperation = {
  owner: RequestOwner;
  scope: GitHubIdentityScope;
  controller: AbortController;
  requestId?: string;
  start?: ToolsGitHubAuthorizeStartResult;
  timer?: ReturnType<typeof setTimeout>;
};

type GitHubIdentityHost = {
  requestUpdate: () => void;
  runExternalMutation: RuntimeConfigCapability["runExternalMutation"];
};

function configFingerprint(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function readDraft(value: unknown): GitHubIdentityDraft {
  const github = isRecord(value) ? value : undefined;
  const gitAuthor = isRecord(github?.gitAuthor) ? github.gitAuthor : undefined;
  return {
    token: "",
    name: typeof gitAuthor?.name === "string" ? gitAuthor.name : "",
    email: typeof gitAuthor?.email === "string" ? gitAuthor.email : "",
  };
}

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
  private effectiveFingerprint = "";
  private identityInitialized = false;
  private verificationQueued = false;
  private mutationOwner: RequestOwner | null = null;
  private mutationIdentityChanged = false;
  private authorizationOperation: AuthorizationOperation | null = null;
  private drafts: Record<GitHubIdentityScope, GitHubIdentityDraft> = {
    system: readDraft(undefined),
    agent: readDraft(undefined),
  };
  private draftDirty: Record<GitHubIdentityScope, boolean> = { system: false, agent: false };
  private configFingerprints: Record<GitHubIdentityScope, string> = { system: "", agent: "" };

  constructor(private readonly host: GitHubIdentityHost) {}

  get authorizationActive(): boolean {
    return (
      this.authorization.phase === "starting" ||
      this.authorization.phase === "code" ||
      this.authorization.phase === "pending" ||
      this.authorization.phase === "network_error"
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
    const effectiveFingerprint = configFingerprint(values.agent ?? values.system);
    const identityChanged =
      this.identityInitialized && this.effectiveFingerprint !== effectiveFingerprint;
    this.effectiveFingerprint = effectiveFingerprint;
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
      this.drafts = { system: readDraft(values.system), agent: readDraft(values.agent) };
      this.draftDirty = { system: false, agent: false };
      this.configFingerprints = {
        system: configFingerprint(values.system),
        agent: configFingerprint(values.agent),
      };
      this.scope = values.agent ? "agent" : "system";
      return;
    }
    if (capabilityChanged) {
      this.loading = false;
      this.busy = false;
    }
    for (const scope of ["system", "agent"] as const) {
      const fingerprint = configFingerprint(values[scope]);
      if (!this.draftDirty[scope] && this.configFingerprints[scope] !== fingerprint) {
        this.drafts = { ...this.drafts, [scope]: readDraft(values[scope]) };
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

  dispose() {
    this.retireAuthorization(true);
  }

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

  private cancelAuthorizationRequest(operation: AuthorizationOperation) {
    if (!operation.requestId) {
      return;
    }
    void operation.owner.client
      .request("tools.github.authorize.cancel", { requestId: operation.requestId })
      .catch(() => undefined);
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
      this.cancelAuthorizationRequest(operation);
    }
  }

  cancelAuthorization() {
    this.retireAuthorization(true);
    this.authorization = { phase: "idle" };
    this.busy = false;
    this.host.requestUpdate();
  }

  private scheduleAuthorizationPoll(operation: AuthorizationOperation, nextPollAtMs: number) {
    if (!this.isCurrentAuthorization(operation) || !operation.start) {
      return;
    }
    if (operation.timer !== undefined) {
      clearTimeout(operation.timer);
    }
    const expiresAtMs = operation.start.expiresAtMs;
    const scheduledAtMs = Math.min(nextPollAtMs, expiresAtMs);
    const delayMs = resolveSafeTimeoutDelayMs(Math.max(0, scheduledAtMs - Date.now()), {
      minMs: 0,
    });
    operation.timer = setTimeout(() => {
      operation.timer = undefined;
      if (!this.isCurrentAuthorization(operation)) {
        return;
      }
      if (Date.now() >= expiresAtMs) {
        this.authorizationOperation = null;
        this.authorization = { phase: "expired" };
        this.host.requestUpdate();
        return;
      }
      void this.pollAuthorization(operation);
    }, delayMs);
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
      if (!this.isCurrentAuthorization(operation)) {
        this.cancelAuthorizationRequest(operation);
        return;
      }
      this.authorization = { ...result, phase: "code" };
      this.host.requestUpdate();
      this.scheduleAuthorizationPoll(operation, result.nextPollAtMs);
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
    this.authorization = { ...operation.start, phase: "pending" };
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
          phase: "pending",
          ...(result.status === "slow_down" ? { slowedDown: true } : {}),
        };
        this.scheduleAuthorizationPoll(operation, result.nextPollAtMs);
        return;
      }
      if (result.status === "network_error") {
        this.authorization = {
          ...operation.start,
          phase: "network_error",
          retryAtMs: result.retryAtMs,
        };
        this.scheduleAuthorizationPoll(operation, result.retryAtMs);
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

  private async deleteSetupHandoff(client: GatewayBrowserClient, secretName: string) {
    await client.request("secrets.store.delete", { name: secretName }).catch(() => undefined);
  }

  private runConfigureMutation(owner: RequestOwner, params: Record<string, unknown>) {
    return this.host.runExternalMutation(
      (client) => {
        if (client !== owner.client) {
          throw new Error("Connection changed before the GitHub identity update started.");
        }
        return client.request<ToolsGitHubStatusResult>("tools.github.configure", params);
      },
      {
        canDispatch: () => this.isCurrent(owner) && this.configurable,
        dispatchError: "Access changed before the GitHub identity update started.",
      },
    );
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
    if (!this.statusReadable || this.loading || this.busy || this.authorizationActive) {
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
    const name = draft.name.trim();
    const email = draft.email.trim();
    const owner = this.captureRequest();
    if (!owner) {
      return;
    }
    this.mutationOwner = owner;
    this.mutationIdentityChanged = false;
    this.loading = false;
    this.busy = true;
    this.error = null;
    this.host.requestUpdate();
    let stored = false;
    let secretName = "";
    let succeeded = false;
    try {
      secretName = `github-setup-${generateUUID().replaceAll("-", "").toLowerCase()}`;
      await owner.client.request("secrets.store.set", {
        name: secretName,
        value: draft.token,
        kind: "secret",
        allowedHosts: [],
      });
      stored = true;
      if (!this.isCurrent(owner)) {
        await this.deleteSetupHandoff(owner.client, secretName);
        return;
      }
      const mutation = await this.runConfigureMutation(owner, {
        scope,
        agentId: owner.agentId,
        mode: "managed",
        secretName,
        ...(name || email
          ? {
              gitAuthor: {
                ...(name ? { name } : {}),
                ...(email ? { email } : {}),
              },
            }
          : {}),
      });
      if (!mutation.ok) {
        throw new Error(mutation.error);
      }
      stored = false;
      this.applyMutationStatus(
        owner,
        scope,
        mutation.value,
        { ...draft, token: "" },
        mutation.refresh.ok ? null : mutation.refresh.error,
      );
      succeeded = true;
    } catch (error) {
      if (stored) {
        await this.deleteSetupHandoff(owner.client, secretName);
      }
      if (this.isCurrent(owner)) {
        this.error = formatUiError(error);
      }
    } finally {
      this.finishMutation(owner, succeeded);
    }
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
    this.mutationOwner = owner;
    this.mutationIdentityChanged = false;
    this.loading = false;
    this.busy = true;
    this.error = null;
    this.host.requestUpdate();
    let succeeded = false;
    try {
      const mutation = await this.runConfigureMutation(owner, {
        scope,
        agentId: owner.agentId,
        mode: "inherit",
      });
      if (!mutation.ok) {
        throw new Error(mutation.error);
      }
      if (this.isCurrent(owner)) {
        this.applyMutationStatus(
          owner,
          scope,
          mutation.value,
          readDraft(undefined),
          mutation.refresh.ok ? null : mutation.refresh.error,
        );
        if (scope === "agent") {
          this.scope = "system";
        }
        succeeded = true;
      }
    } catch (error) {
      if (this.isCurrent(owner)) {
        this.error = formatUiError(error);
      }
    } finally {
      this.finishMutation(owner, succeeded);
    }
  }
}
