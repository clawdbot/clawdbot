import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { isTarget, routeKey } from "./catalog-target.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import type { DraftSubmissionFlow } from "./draft-submission-flow.ts";
import type { NewSessionRouteData } from "./location.ts";

type DraftTitleInput = {
  client: Pick<GatewayBrowserClient, "request">;
  agentId: string;
  ownerKey?: string;
  message: string;
  model?: string;
};

function sameDraft(left: DraftTitleInput | null, right: DraftTitleInput | null): boolean {
  return (
    left?.client === right?.client &&
    left?.agentId === right?.agentId &&
    left?.ownerKey === right?.ownerKey &&
    left?.message === right?.message &&
    left?.model === right?.model
  );
}

/** Owns disposable title work for New Session, never the chat route. */
export class NewSessionTitleController implements ReactiveController {
  private current: DraftTitleInput | null = null;
  private title: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active = false;
  private pending = false;
  private readyAt = 0;

  private connected = false;
  private composing = false;
  private submitted: DraftTitleInput | null = null;

  constructor(
    host: ReactiveControllerHost,
    private readonly read: () => {
      context: ApplicationContext | undefined;
      data: NewSessionRouteData | undefined;
      place: DraftPlaceState;
      submission: DraftSubmissionFlow;
      dictating: boolean;
    },
  ) {
    host.addController(this);
  }

  hostConnected() {
    this.connected = true;
  }
  hostUpdated() {
    this.sync(this.input());
  }
  hostDisconnected() {
    this.connected = false;
    this.sync(null);
    this.submitted = null;
  }

  setComposing(composing: boolean) {
    this.composing = composing;
    this.hostUpdated();
  }

  takePreparedTitle(): string | undefined {
    const input = this.input();
    const title = sameDraft(this.current, input) ? (this.title ?? undefined) : undefined;
    this.submitted = input ?? this.submitted;
    this.sync(null);
    return title;
  }

  private sync(input: DraftTitleInput | null) {
    const message = input?.message.trim() ?? "";
    const next =
      input && message.length >= 12 && !message.startsWith("/") ? { ...input, message } : null;
    if (sameDraft(this.current, next)) {
      return;
    }
    clearTimeout(this.timer);
    this.current = next;
    this.title = null;
    this.pending = next !== null;
    this.readyAt = Date.now() + 1_000;
    this.schedule();
  }

  private schedule() {
    if (!this.pending || this.active) {
      return;
    }
    this.timer = setTimeout(() => void this.prepare(), Math.max(0, this.readyAt - Date.now()));
  }

  private async prepare() {
    const current = this.current;
    if (!current || !this.pending) {
      return;
    }
    this.pending = false;
    this.active = true;
    try {
      const result = await current.client.request<{ title: string | null }>(
        "sessions.title.prepare",
        {
          agentId: current.agentId,
          message: truncateUtf16Safe(current.message, 1_000),
          ...(current.model ? { model: current.model } : {}),
        },
        { timeoutMs: 20_000 },
      );
      // Object identity fences edits, route changes, privacy changes, and teardown,
      // including a draft that changes away and then back during the request.
      if (this.current === current) {
        this.title = result.title;
      }
    } catch {
      // Speculation must never block Send or leak a provider error into the draft.
      // An unchanged failed draft is not retried until the operator edits it.
    } finally {
      this.active = false;
      this.schedule();
    }
  }

  private input(): DraftTitleInput | null {
    const { context, data, place, submission, dictating } = this.read();
    const snapshot = context?.gateway.snapshot;
    // Native prompts belong to the selected CLI, never OpenClaw title inference.
    if (
      !this.connected ||
      isTarget(data) ||
      this.composing ||
      dictating ||
      submission.submitting ||
      submission.visibility === "incognito" ||
      submission.pendingPlacement.sessionKey ||
      !place.agentId ||
      !canCallGatewayMethod(snapshot, "sessions.title.prepare", "operator.write") ||
      !snapshot?.client
    ) {
      return null;
    }
    const input = {
      client: snapshot.client,
      ownerKey: routeKey(data),
      agentId: place.agentId,
      message: submission.message.trim(),
      model: place.modelControl.selected,
    };
    // A failed navigation/retry may leave this page mounted after creation. The
    // submitted draft cannot start more inference; only a new draft can do so.
    return sameDraft(input, this.submitted) ? null : input;
  }
}
