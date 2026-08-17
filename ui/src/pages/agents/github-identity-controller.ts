import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ToolsGitHubStatusResult } from "../../api/types.ts";
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
  loading = false;
  busy = false;
  error: string | null = null;
  supported = false;
  configurable = false;
  tokenRevealed = false;

  private agentId: string | null = null;
  private client: GatewayBrowserClient | null = null;
  private connected = false;
  private clientRevision = -1;
  private agentRevision = -1;
  private requestRevision = 0;
  private effectiveFingerprint = "";
  private identityInitialized = false;
  private verificationQueued = false;
  private drafts: Record<GitHubIdentityScope, GitHubIdentityDraft> = {
    system: readDraft(undefined),
    agent: readDraft(undefined),
  };
  private draftDirty: Record<GitHubIdentityScope, boolean> = { system: false, agent: false };
  private configFingerprints: Record<GitHubIdentityScope, string> = { system: "", agent: "" };
  constructor(private readonly host: GitHubIdentityHost) {}

  private queueVerification() {
    if (this.verificationQueued || !this.supported || !this.connected || !this.agentId) {
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
    supported: boolean;
    configurable: boolean;
    clientRevision: number;
  }) {
    const clientChanged =
      this.client !== params.client ||
      this.connected !== params.connected ||
      this.clientRevision !== params.clientRevision;
    const agentChanged = this.agentId !== params.agentId;
    const capabilityChanged =
      this.supported !== params.supported || this.configurable !== params.configurable;
    if (clientChanged || agentChanged || capabilityChanged) {
      this.requestRevision += 1;
    }
    this.client = params.client;
    this.connected = params.connected;
    this.clientRevision = params.clientRevision;
    this.supported = params.supported;
    this.configurable = params.configurable;
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
    if (identityChanged) {
      this.requestRevision += 1;
    }
    if (clientChanged || agentChanged) {
      this.status = null;
      this.error = null;
      this.loading = false;
      this.busy = false;
      this.tokenRevealed = false;
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
    if (identityChanged) {
      this.status = null;
      this.error = null;
      this.loading = false;
      this.queueVerification();
    }
  }

  get draft(): GitHubIdentityDraft {
    return this.drafts[this.scope];
  }

  selectScope(scope: GitHubIdentityScope) {
    this.scope = scope;
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
    if (status.agentId !== owner.agentId) {
      throw new Error("Gateway returned GitHub identity status for a different agent.");
    }
    this.status = status;
    this.drafts = { ...this.drafts, [scope]: nextDraft };
    this.draftDirty = { ...this.draftDirty, [scope]: false };
    this.tokenRevealed = false;
    this.error = refreshError
      ? `GitHub identity was updated, but its configuration refresh failed: ${refreshError}`
      : null;
  }

  async verify() {
    if (!this.supported || this.loading || this.busy) {
      return;
    }
    const owner = this.captureRequest();
    if (!owner) {
      return;
    }
    this.loading = true;
    this.error = null;
    this.host.requestUpdate();
    try {
      const status = await owner.client.request<ToolsGitHubStatusResult>("tools.github.status", {
        agentId: owner.agentId,
      });
      if (this.isCurrent(owner)) {
        if (status.agentId !== owner.agentId) {
          throw new Error("Gateway returned GitHub identity status for a different agent.");
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
    if (!this.client || !this.connected || !this.agentId || !this.configurable || this.busy) {
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
    this.loading = false;
    this.busy = true;
    this.error = null;
    this.host.requestUpdate();
    let stored = false;
    let secretName = "";
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
    } catch (error) {
      if (stored) {
        await this.deleteSetupHandoff(owner.client, secretName);
      }
      if (this.isCurrent(owner)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.isCurrent(owner)) {
        this.busy = false;
        this.host.requestUpdate();
      }
    }
  }

  async inherit() {
    const scope = this.scope;
    if (!this.configurable || this.busy) {
      return;
    }
    const owner = this.captureRequest();
    if (!owner) {
      return;
    }
    this.loading = false;
    this.busy = true;
    this.error = null;
    this.host.requestUpdate();
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
      }
    } catch (error) {
      if (this.isCurrent(owner)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.isCurrent(owner)) {
        this.busy = false;
        this.host.requestUpdate();
      }
    }
  }
}
