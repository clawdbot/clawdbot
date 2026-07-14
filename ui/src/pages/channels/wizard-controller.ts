// Drives a gateway channel-setup wizard session (wizard.start flow "channels")
// as a step/answer state machine for the Control UI wizard modal.

type WizardGatewayClient = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
};

// The browser gateway client does not expose per-request timeouts, so race a
// local ceiling; stale late responses are cleaned up by the generation guard.
async function requestWithTimeout<T>(
  client: WizardGatewayClient,
  method: string,
  params: unknown,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      client.request<T>(method, params),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`wizard request timed out: ${method}`)),
          WIZARD_STEP_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export type ChannelWizardStepOption = {
  value: unknown;
  label: string;
  hint?: string;
};

export type ChannelWizardStep = {
  id: string;
  type: "note" | "select" | "text" | "confirm" | "multiselect" | "progress" | "action";
  title?: string;
  message?: string;
  format?: "plain";
  options?: ChannelWizardStepOption[];
  initialValue?: unknown;
  placeholder?: string;
  sensitive?: boolean;
  executor?: "gateway" | "client";
  externalUrl?: string;
  deviceCode?: { code: string; expiresInMinutes?: number; message?: string };
};

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

  constructor(
    private readonly getClient: () => WizardGatewayClient | null,
    private readonly onChange: () => void,
    // Known channel ids from the status snapshot. Presentation only: lets a
    // browse-all session title/link the wizard for the picked channel; the
    // completion behavior keys off the gateway-reported accounts instead.
    private readonly isKnownChannel: (value: string) => boolean = () => false,
  ) {}

  get state(): ChannelWizardState {
    return this.currentState;
  }

  get activeChannel(): string | null {
    return this.channel;
  }

  async start(channel: string | null): Promise<void> {
    const client = this.getClient();
    if (!client) {
      return;
    }
    const generation = ++this.generation;
    this.sessionId = null;
    this.channel = channel;
    this.stepIndex = 0;
    this.setState({ phase: "starting", channel });
    try {
      const result = await requestWithTimeout<WizardNextResult>(client, "wizard.start", {
        flow: "channels",
        ...(channel ? { channel } : {}),
      });
      if (this.generation !== generation) {
        // The modal was closed/superseded mid-start, but the gateway already
        // created a running session; cancel it or later starts get rejected.
        if (result.sessionId && !result.done) {
          void client.request("wizard.cancel", { sessionId: result.sessionId }).catch(() => {});
        }
        return;
      }
      this.sessionId = result.sessionId ?? null;
      this.applyResult(result);
    } catch (err) {
      if (this.generation !== generation) {
        return;
      }
      this.setState({ phase: "error", channel, message: String(err) });
    }
  }

  async answer(value: unknown): Promise<void> {
    const client = this.getClient();
    const current = this.currentState;
    if (!client || !this.sessionId || current.phase !== "step" || current.busy) {
      return;
    }
    const generation = this.generation;
    if (current.step.type === "select" && typeof value === "string" && this.isKnownChannel(value)) {
      this.channel ??= value;
    }
    this.setState({ ...current, busy: true, validationError: null });
    try {
      const result = await requestWithTimeout<WizardNextResult>(client, "wizard.next", {
        sessionId: this.sessionId,
        answer: { stepId: current.step.id, value },
      });
      if (this.generation !== generation) {
        return;
      }
      this.applyResult(result);
    } catch (err) {
      if (this.generation !== generation) {
        return;
      }
      this.setState({ phase: "error", channel: this.channel, message: String(err) });
    }
  }

  async cancel(): Promise<void> {
    const client = this.getClient();
    const sessionId = this.sessionId;
    this.generation += 1;
    this.sessionId = null;
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
      this.setState({
        phase: "step",
        channel: this.channel,
        step: result.step,
        stepIndex: this.stepIndex,
        busy: false,
        validationError: result.error ?? null,
      });
      return;
    }
    if (result.status === "done") {
      this.sessionId = null;
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
      this.channel = null;
      this.setState({ phase: "idle" });
      return;
    }
    this.sessionId = null;
    this.setState({
      phase: "error",
      channel: this.channel,
      message: result.error ?? "Wizard failed.",
    });
  }

  private setState(next: ChannelWizardState): void {
    this.currentState = next;
    this.onChange();
  }
}
