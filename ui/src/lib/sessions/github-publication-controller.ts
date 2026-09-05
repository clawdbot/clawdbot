import { readGitHubPublicationSelectionRejectedError } from "@openclaw/gateway-protocol/gateway-error-details";
import type { Static } from "typebox";
import type {
  GitHubPublicationPublisher,
  GitHubPublicationSelection,
  SessionGitHubOptionsResultSchema,
  SessionGitHubPublicationResult,
  SessionGitHubStatusResult,
} from "../../../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../format-error.ts";
import { generateUUID } from "../uuid.ts";

export type GitHubPublicationOptions = Static<typeof SessionGitHubOptionsResultSchema>;
type GitHubPublicationPresentation = {
  canWrite: boolean;
  personalReady: boolean;
  isPresented: () => boolean;
  isCurrent: () => boolean;
};
type PublicationOwner = {
  client: Pick<GatewayBrowserClient, "request">;
  sessionKey: string;
  isCurrent: () => boolean;
  reserve: () => void;
  release: () => void;
  unbound: () => void;
};
type Presentation = {
  scope: GitHubPublicationPresentation | null;
  changed: (() => void) | null;
};
export type GitHubPublicationPresentationBinding = {
  sync: (scope: GitHubPublicationPresentation) => void;
  view: () => GitHubPublicationView | undefined;
  reset: () => void;
  detach: () => void;
  readonly result: SessionGitHubPublicationResult | null;
};
export type GitHubPublicationView = {
  busy: boolean;
  canWrite: boolean;
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
  private readonly presentations = new Set<Presentation>();
  private version = 0;
  private busy = false;
  private options: GitHubPublicationOptions | null = null;
  private selection: GitHubPublicationSelection | null = null;
  private attempt: { idempotencyKey: string; selection: GitHubPublicationSelection } | null = null;
  result: SessionGitHubPublicationResult | null = null;
  private confirmation: SessionGitHubStatusResult["confirmation"] = null;
  private error: string | null = null;
  private reviewedRequestId: string | null = null;

  constructor(private readonly owner: PublicationOwner) {}

  get hasBindings(): boolean {
    return this.presentations.size > 0;
  }

  reset(): void {
    this.owner.release();
    this.version += 1;
    this.busy = false;
    this.options = null;
    this.selection = null;
    this.attempt = null;
    this.result = null;
    this.confirmation = null;
    this.error = null;
    this.reviewedRequestId = null;
  }

  private changed(): void {
    for (const presentation of this.presentations) {
      presentation.changed?.();
    }
  }

  private presented(presentation: Presentation): boolean {
    return (
      this.presentations.has(presentation) &&
      this.owner.isCurrent() &&
      presentation.scope?.isCurrent() === true &&
      presentation.scope.isPresented()
    );
  }

  private retireIdleOptions(): void {
    if (
      !this.busy &&
      !this.locked &&
      !this.result &&
      !this.error &&
      ![...this.presentations].some((presentation) => this.presented(presentation))
    ) {
      this.reset();
    }
  }

  bind(changed: () => void): GitHubPublicationPresentationBinding {
    const presentation: Presentation = { scope: null, changed };
    this.presentations.add(presentation);
    const getResult = () => this.result;
    return {
      sync: (scope) => {
        if (!this.presentations.has(presentation)) {
          return;
        }
        presentation.scope = scope;
        this.retireIdleOptions();
        if (
          this.presented(presentation) &&
          !this.busy &&
          !this.options &&
          !this.result &&
          !this.error
        ) {
          void this.refresh(presentation);
        }
      },
      view: () => this.view(presentation),
      get result() {
        return getResult();
      },
      reset: () => {
        if (this.presented(presentation)) {
          this.reset();
          this.changed();
        }
      },
      detach: () => {
        presentation.scope = null;
        presentation.changed = null;
        this.presentations.delete(presentation);
        this.retireIdleOptions();
        if (!this.hasBindings) {
          this.owner.unbound();
        }
      },
    };
  }

  private get locked(): boolean {
    return this.attempt !== null || (this.result !== null && !terminal(this.result));
  }

  private choose(presentation: Presentation, source: "shared" | "personal"): void {
    const options = this.options;
    if (
      !options ||
      this.locked ||
      this.busy ||
      !this.presented(presentation) ||
      !presentation.scope?.canWrite
    ) {
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
    this.version += 1;
    this.changed();
  }

  private async run(
    presentation: Presentation,
    action: (scope: PublicationOwner, current: () => boolean) => Promise<void>,
  ): Promise<void> {
    if (!this.presented(presentation) || this.busy) {
      return;
    }
    const version = ++this.version;
    const current = () => this.version === version && this.owner.isCurrent();
    this.busy = true;
    this.error = null;
    this.changed();
    try {
      await action(this.owner, current);
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
    scope: PublicationOwner,
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

  private async refresh(presentation: Presentation): Promise<void> {
    await this.run(presentation, async (scope, current) => {
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
        this.owner.reserve();
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

  private async publish(presentation: Presentation): Promise<void> {
    const selection = this.attempt?.selection ?? this.selection;
    if (
      !presentation.scope?.canWrite ||
      !selection ||
      terminal(this.result) ||
      (selection.source === "personal" && !presentation.scope.personalReady) ||
      (this.locked && !this.attempt)
    ) {
      return;
    }
    await this.run(presentation, async (owner, current) => {
      this.owner.reserve();
      const firstInvocation = this.attempt === null;
      const attempt = this.attempt ?? { idempotencyKey: generateUUID(), selection };
      this.attempt = attempt;
      const result = await owner.client
        .request<SessionGitHubPublicationResult>("sessions.github.publish", {
          sessionKey: owner.sessionKey,
          ...attempt,
        })
        .catch((error: unknown) => {
          // A rejected retry says nothing about an earlier same-key call still preparing.
          if (
            firstInvocation &&
            current() &&
            this.attempt === attempt &&
            readGitHubPublicationSelectionRejectedError(error)?.idempotencyKey ===
              attempt.idempotencyKey
          ) {
            this.owner.release();
            this.attempt = null;
            this.selection = null;
            this.options = null;
          }
          throw error;
        });
      if (!current()) {
        return;
      }
      this.applyResult(result);
      if (result.status === "needs_confirmation") {
        await this.readStatus(owner, current, result.requestId);
      }
    });
  }

  private async confirm(presentation: Presentation): Promise<void> {
    const confirmation = this.confirmation;
    const requestId = this.result?.requestId;
    if (
      !confirmation ||
      !requestId ||
      !presentation.scope?.canWrite ||
      !presentation.scope.personalReady
    ) {
      return;
    }
    await this.run(presentation, async (scope, current) => {
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

  private view(presentation: Presentation): GitHubPublicationView | undefined {
    const scope = presentation.scope;
    if (!scope || !this.presented(presentation)) {
      return undefined;
    }
    const version = this.version;
    // Each callback belongs to the displayed operation state, not whichever
    // publication or confirmation happens to occupy this session later.
    const invoke = (action: () => void) => {
      if (version === this.version && this.presented(presentation)) {
        action();
      }
    };
    return {
      busy: this.busy,
      canWrite: scope.canWrite,
      locked: this.locked,
      options: this.options,
      selection: this.attempt?.selection ?? this.selection,
      result: this.result,
      confirmation: this.confirmation,
      error: this.error,
      personalReady: scope.personalReady,
      onSelect:
        scope.canWrite && !this.result && !this.locked
          ? (source) => invoke(() => this.choose(presentation, source))
          : undefined,
      onPublish:
        scope.canWrite && (!this.locked || this.attempt !== null) && !terminal(this.result)
          ? () => invoke(() => void this.publish(presentation))
          : undefined,
      onConfirm:
        scope.canWrite && this.confirmation
          ? () => invoke(() => void this.confirm(presentation))
          : undefined,
      onRefresh: () => invoke(() => void this.refresh(presentation)),
      // Acknowledgement releases local custody; publication and confirmation remain write-gated.
      onNewAction: terminal(this.result)
        ? () =>
            invoke(() => {
              if (this.busy) {
                return;
              }
              this.owner.release();
              this.reviewedRequestId = this.result?.requestId ?? null;
              this.result = null;
              this.confirmation = null;
              this.selection = null;
              this.attempt = null;
              void this.refresh(presentation);
            })
        : undefined,
    };
  }
}
