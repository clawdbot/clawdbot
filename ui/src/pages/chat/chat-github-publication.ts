import type { Static } from "typebox";
import type {
  GitHubPublicationPublisher,
  GitHubPublicationSelection,
  SessionGitHubOptionsResultSchema,
  SessionGitHubPublicationResult,
  SessionGitHubStatusResult,
} from "../../../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { generateUUID } from "../../lib/uuid.ts";

export type GitHubPublicationOptions = Static<typeof SessionGitHubOptionsResultSchema>;
export type GitHubPublicationScope = {
  client: Pick<GatewayBrowserClient, "request">;
  key: string;
  sessionKey: string;
  canWrite: boolean;
  personalReady: boolean;
  isCurrent: () => boolean;
};
export type GitHubPublicationView = {
  busy: boolean;
  locked: boolean;
  options: GitHubPublicationOptions | null;
  selection: GitHubPublicationSelection | null;
  result: SessionGitHubPublicationResult | null;
  confirmation: SessionGitHubStatusResult["confirmation"];
  error: string | null;
  personalReady: boolean;
  onSelect?: (source: "shared" | "personal") => void;
  onPublish?: () => void;
  onConfirm?: () => void;
  onRefresh: () => void;
  onNewAction?: () => void;
};

function terminal(result: SessionGitHubPublicationResult | null): boolean {
  return result?.status === "published" || result?.status === "failed";
}

export function selectedGitHubPublisher(
  selection: GitHubPublicationSelection | null,
): GitHubPublicationPublisher | undefined {
  return selection?.source === "personal"
    ? { source: "personal", ...selection.account }
    : selection?.expected;
}

/** Owns one session's explicit publication; connection/access changes retire every response. */
export class GitHubPublicationController {
  private scope: GitHubPublicationScope | null = null;
  private version = 0;
  private busy = false;
  private options: GitHubPublicationOptions | null = null;
  private selection: GitHubPublicationSelection | null = null;
  private attempt: { idempotencyKey: string; selection: GitHubPublicationSelection } | null = null;
  result: SessionGitHubPublicationResult | null = null;
  private confirmation: SessionGitHubStatusResult["confirmation"] = null;
  private error: string | null = null;
  private reviewedRequestId: string | null = null;

  constructor(private readonly changed: () => void) {}

  reset(): void {
    this.version += 1;
    this.scope = null;
    this.busy = false;
    this.options = null;
    this.selection = null;
    this.attempt = null;
    this.result = null;
    this.confirmation = null;
    this.error = null;
    this.reviewedRequestId = null;
  }

  sync(scope: GitHubPublicationScope | null): void {
    if (!scope || !scope.isCurrent()) {
      this.reset();
      return;
    }
    if (this.scope?.key === scope.key && this.scope.client === scope.client) {
      this.scope = scope;
      return;
    }
    this.reset();
    this.scope = scope;
    void this.refresh();
  }

  private get locked(): boolean {
    return this.attempt !== null || (this.result !== null && !terminal(this.result));
  }

  private choose(source: "shared" | "personal"): void {
    const options = this.options;
    if (!options || this.locked || this.busy || !this.scope?.isCurrent()) {
      return;
    }
    const personal = options.personal;
    this.selection =
      source === "shared"
        ? options.shared
          ? { source, expected: options.shared }
          : null
        : personal?.state === "connected" && personal.account && personal.generation
          ? { source, account: personal.account, generation: personal.generation }
          : null;
    this.changed();
  }

  private async run(
    action: (scope: GitHubPublicationScope, current: () => boolean) => Promise<void>,
  ): Promise<void> {
    const scope = this.scope;
    if (!scope?.isCurrent() || this.busy) {
      return;
    }
    const version = ++this.version;
    const current = () =>
      this.version === version && this.scope?.key === scope.key && scope.isCurrent();
    this.busy = true;
    this.error = null;
    this.changed();
    try {
      await action(scope, current);
    } catch (error) {
      if (current()) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.version === version) {
        if (current()) {
          this.busy = false;
        } else {
          this.reset();
        }
        this.changed();
      }
    }
  }

  private applyResult(result: SessionGitHubPublicationResult): void {
    this.result = result;
    this.confirmation = null;
    if (terminal(result)) {
      this.attempt = null;
    }
  }

  private async readStatus(
    scope: GitHubPublicationScope,
    current: () => boolean,
    requestId: string,
  ): Promise<void> {
    const status = await scope.client.request<SessionGitHubStatusResult>("sessions.github.status", {
      sessionKey: scope.sessionKey,
      requestId,
    });
    if (current()) {
      this.applyResult(status.result);
      this.confirmation = status.confirmation;
    }
  }

  private async refresh(): Promise<void> {
    await this.run(async (scope, current) => {
      if (this.result?.publisher?.source === "personal" && !terminal(this.result)) {
        await this.readStatus(scope, current, this.result.requestId);
        return;
      }
      const options = await scope.client.request<GitHubPublicationOptions>(
        "sessions.github.options",
        {
          sessionKey: scope.sessionKey,
        },
      );
      if (!current()) {
        return;
      }
      this.options = options;
      if (
        !this.locked &&
        !this.result &&
        options.pendingPersonal &&
        options.pendingPersonal.result.requestId !== this.reviewedRequestId
      ) {
        this.applyResult(options.pendingPersonal.result);
        this.confirmation = options.pendingPersonal.confirmation;
      }
      // Connecting My GitHub never changes the shared default. An in-flight
      // attempt retains the exact account/generation even if fresh options differ.
      if (!this.locked && !this.selection && options.shared) {
        this.selection = { source: "shared", expected: options.shared };
      }
    });
  }

  private async publish(): Promise<void> {
    const scope = this.scope;
    const selection = this.attempt?.selection ?? this.selection;
    if (
      !scope?.canWrite ||
      !selection ||
      terminal(this.result) ||
      (selection.source === "personal" && !scope.personalReady) ||
      (this.locked && !this.attempt)
    ) {
      return;
    }
    await this.run(async (owner, current) => {
      const attempt = this.attempt ?? { idempotencyKey: generateUUID(), selection };
      this.attempt = attempt;
      const result = await owner.client.request<SessionGitHubPublicationResult>(
        "sessions.github.publish",
        {
          sessionKey: owner.sessionKey,
          ...attempt,
        },
      );
      if (!current()) {
        return;
      }
      this.applyResult(result);
      if (result.status === "needs_confirmation") {
        await this.readStatus(owner, current, result.requestId);
      }
    });
  }

  private async confirm(): Promise<void> {
    const confirmation = this.confirmation;
    const requestId = this.result?.requestId;
    if (!confirmation || !requestId || !this.scope?.canWrite || !this.scope.personalReady) {
      return;
    }
    await this.run(async (scope, current) => {
      const result = await scope.client.request<SessionGitHubPublicationResult>(
        "sessions.github.confirm",
        {
          sessionKey: scope.sessionKey,
          requestId,
          generation: confirmation.generation,
          account: confirmation.account,
          requestDigest: confirmation.requestDigest,
        },
      );
      if (current()) {
        this.applyResult(result);
        if (result.status === "needs_confirmation") {
          await this.readStatus(scope, current, requestId);
        }
      }
    });
  }

  view(): GitHubPublicationView | undefined {
    const scope = this.scope;
    if (!scope?.isCurrent()) {
      return undefined;
    }
    return {
      busy: this.busy,
      locked: this.locked,
      options: this.options,
      selection: this.attempt?.selection ?? this.selection,
      result: this.result,
      confirmation: this.confirmation,
      error: this.error,
      personalReady: scope.personalReady,
      onSelect:
        scope.canWrite && !this.result && !this.locked
          ? (source) => this.choose(source)
          : undefined,
      onPublish:
        scope.canWrite && (!this.locked || this.attempt !== null) && !terminal(this.result)
          ? () => void this.publish()
          : undefined,
      onConfirm: scope.canWrite && this.confirmation ? () => void this.confirm() : undefined,
      onRefresh: () => void this.refresh(),
      onNewAction:
        scope.canWrite && terminal(this.result)
          ? () => {
              if (this.busy || !scope.isCurrent()) {
                return;
              }
              this.reviewedRequestId = this.result?.requestId ?? null;
              this.result = null;
              this.confirmation = null;
              this.selection = null;
              this.attempt = null;
              void this.refresh();
            }
          : undefined,
    };
  }
}
