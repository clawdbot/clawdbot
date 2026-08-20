// Drives a gateway channel-setup wizard session (wizard.start flow "channels")
// as a step/answer state machine for the Control UI wizard modal.
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { WizardStep } from "../../api/types.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { isWizardNotFoundError } from "../../lib/gateway-errors.ts";

type WizardGatewayClient = Pick<GatewayBrowserClient, "request">;

// Keep the wire request alive behind a local ceiling: protocol-level timeouts
// discard late responses, but wizard.start carries the session id needed for cleanup.
async function requestWithTimeout<T>(
  client: WizardGatewayClient,
  method: string,
  params: unknown,
  onLateResult?: (result: T) => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const request = client.request<T>(method, params).then((result) => {
    if (timedOut) {
      onLateResult?.(result);
    }
    return result;
  });
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`wizard request timed out: ${method}`));
        }, WIZARD_STEP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export type ChannelWizardStep = WizardStep;

type WizardNextResult = {
  sessionId?: string;
  done: boolean;
  step?: ChannelWizardStep;
  status?: "running" | "done" | "cancelled" | "error";
  error?: string;
  // What the gateway flow actually configured (terminal result only).
  channels?: string[];
  accounts?: Array<{ channel: string; accountId: string }>;
};

function cancelRunningWizardResult(client: WizardGatewayClient, result: WizardNextResult): void {
  if (!result.sessionId || result.done) {
    return;
  }
  // A start response can outlive its owning UI generation. Release only live
  // sessions; the gateway already purges terminal results before responding.
  void client.request("wizard.cancel", { sessionId: result.sessionId }).catch(() => {});
}

export type ChannelWizardState =
  | { phase: "idle" }
  | { phase: "starting"; channel: string | null }
  | {
      phase: "step";
      channel: string | null;
      step: ChannelWizardStep;
      stepIndex: number;
      busy: boolean;
      validationError: string | null;
    }
  | {
      phase: "done";
      channel: string | null;
      channels: readonly string[];
      accounts: ReadonlyArray<{ channel: string; accountId: string }>;
    }
  | { phase: "error"; channel: string | null; message: string };

// Long ceiling: a single step can wrap a slow gateway-side effect such as a
// catalog plugin install; the modal stays interactive via the busy flag.
const WIZARD_STEP_TIMEOUT_MS = 120_000;

export class ChannelWizardController {
  private currentState: ChannelWizardState = { phase: "idle" };
  private sessionId: string | null = null;
  private channel: string | null = null;
  private stepIndex = 0;
  private generation = 0;
  private abortController: AbortController | null = null;

  constructor(
    private readonly getClient: () => WizardGatewayClient | null,
    private readonly onChange: () => void,
    // Known channel ids from the status snapshot. Presentation only: lets a
    // browse-all session title/link the wizard for the picked channel; the
    // completion behavior keys off the gateway-reported accounts instead.
    private readonly isKnownChannel: (value: string) => boolean,
    private readonly sessionExpiredMessage: () => string,
  ) {}

  get state(): ChannelWizardState {
    return this.currentState;
  }

  async start(channel: string | null): Promise<void> {
    const client = this.getClient();
    if (!client) {
      return;
    }
    const generation = ++this.generation;
    this.abortController?.abort();
    this.abortController = new AbortController();
    this.sessionId = null;
    this.channel = channel;
    this.stepIndex = 0;
    this.setState({ phase: "starting", channel });
    try {
      const result = await requestWithTimeout<WizardNextResult>(
        client,
        "wizard.start",
        {
          flow: "channels",
          ...(channel ? { channel } : {}),
        },
        (lateResult) => cancelRunningWizardResult(client, lateResult),
      );
      if (this.generation !== generation) {
        // The modal was closed/superseded mid-start, but the gateway already
        // created a running session; cancel it or later starts get rejected.
        cancelRunningWizardResult(client, result);
        return;
      }
      this.sessionId = result.sessionId ?? null;
      this.applyResult(result);
    } catch (err) {
      if (this.generation !== generation) {
        return;
      }
      this.setState({ phase: "error", channel, message: formatUiError(err) });
    }
  }

  async answer(value: unknown): Promise<void> {
    const current = this.currentState;
    if (!this.getClient() || !this.sessionId || current.phase !== "step" || current.busy) {
      return;
    }
    const generation = this.generation;
    if (current.step.type === "select" && typeof value === "string" && this.isKnownChannel(value)) {
      this.channel ??= value;
    }
    this.setState({ ...current, busy: true, validationError: null });
    await this.advance(generation, { stepId: current.step.id, value });
  }

  private async advance(
    generation: number,
    answer?: { stepId: string; value: unknown },
  ): Promise<void> {
    const client = this.getClient();
    const sessionId = this.sessionId;
    if (!client || !sessionId || this.generation !== generation) {
      return;
    }
    const signal = this.abortController?.signal;
    if (!answer && !signal) {
      return;
    }
    try {
      const params = {
        sessionId,
        ...(answer ? { answer } : {}),
      };
      const result = answer
        ? await requestWithTimeout<WizardNextResult>(client, "wizard.next", params)
        : await client.request<WizardNextResult>("wizard.next", params, {
            timeoutMs: null,
            ...(signal ? { signal } : {}),
          });
      if (this.generation !== generation) {
        return;
      }
      this.applyResult(result);
    } catch (err) {
      if (this.generation !== generation) {
        return;
      }
      if (isWizardNotFoundError(err)) {
        this.sessionId = null;
        this.abortController?.abort();
        this.abortController = null;
        this.setState({
          phase: "error",
          channel: this.channel,
          message: this.sessionExpiredMessage(),
        });
        return;
      }
      this.setState({ phase: "error", channel: this.channel, message: formatUiError(err) });
    }
  }

  async cancel(): Promise<void> {
    const client = this.getClient();
    const sessionId = this.sessionId;
    this.generation += 1;
    this.sessionId = null;
    this.abortController?.abort();
    this.abortController = null;
    this.channel = null;
    this.setState({ phase: "idle" });
    if (client && sessionId) {
      try {
        await client.request("wizard.cancel", { sessionId });
      } catch {
        // Session may already be finished/purged; closing the modal wins.
      }
    }
  }

  private applyResult(result: WizardNextResult): void {
    if (!result.done && result.step) {
      this.stepIndex += 1;
      const gatewayOwned = result.step.executor === "gateway";
      this.setState({
        phase: "step",
        channel: this.channel,
        step: result.step,
        stepIndex: this.stepIndex,
        busy: gatewayOwned,
        validationError: result.error ? formatUiExternalText(result.error) : null,
      });
      if (gatewayOwned) {
        // Gateway-owned steps cannot consume an answer; next long-polls for
        // progress or completion while keeping this generation cancellable.
        void this.advance(this.generation);
      }
      return;
    }
    if (result.status === "done") {
      this.sessionId = null;
      this.abortController = null;
      // The gateway reports what the flow actually configured; the initially
      // requested channel is only a preselection and may have been skipped.
      const channels = result.channels ?? [];
      this.setState({
        phase: "done",
        channel: this.channel ?? channels[0] ?? null,
        channels,
        accounts: result.accounts ?? [],
      });
      return;
    }
    if (result.status === "cancelled") {
      this.sessionId = null;
      this.abortController = null;
      this.channel = null;
      this.setState({ phase: "idle" });
      return;
    }
    this.sessionId = null;
    this.abortController = null;
    this.setState({
      phase: "error",
      channel: this.channel,
      message: formatUiExternalText(result.error, "Wizard failed."),
    });
  }

  private setState(next: ChannelWizardState): void {
    this.currentState = next;
    this.onChange();
  }
}
