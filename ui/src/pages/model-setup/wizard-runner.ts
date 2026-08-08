import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SystemAgentSetupAuthStartResult, WizardNextResult } from "../../api/types.ts";
import { isWizardNotFoundError } from "../../lib/gateway-errors.ts";
import {
  MODEL_SETUP_AUTH_START_TIMEOUT_MS,
  MODEL_SETUP_WIZARD_NEXT_TIMEOUT_MS,
  type ModelSetupWizardState,
  wizardStateFromResult,
} from "./state.ts";

export type ModelSetupWizardStartMethod =
  | "openclaw.setup.auth.start"
  | "openclaw.setup.prepare.start";

type WizardRunnerOptions = {
  getClient: () => GatewayBrowserClient | null;
  onChange: (state: ModelSetupWizardState) => void;
  onDone: (startMethod: ModelSetupWizardStartMethod, preparedModelRef?: string) => void;
  requestFailedMessage: () => string;
  cancelledMessage: () => string;
  sessionExpiredMessage: () => string;
};

export class ModelSetupWizardRunner {
  private currentState: ModelSetupWizardState = { phase: "idle" };
  private sessionId: string | null = null;
  private abortController: AbortController | null = null;
  private generation = 0;
  private startMethod: ModelSetupWizardStartMethod = "openclaw.setup.auth.start";

  constructor(private readonly options: WizardRunnerOptions) {}

  get state(): ModelSetupWizardState {
    return this.currentState;
  }

  async start(
    authChoice: string,
    startMethod: ModelSetupWizardStartMethod = "openclaw.setup.auth.start",
  ): Promise<void> {
    const client = this.options.getClient();
    if (!client || this.currentState.phase !== "idle") {
      return;
    }
    const generation = ++this.generation;
    const sessionId = crypto.randomUUID();
    const abortController = new AbortController();
    this.sessionId = sessionId;
    this.abortController = abortController;
    this.startMethod = startMethod;
    this.setState({ phase: "starting", authChoice });
    try {
      const started = await client.request<SystemAgentSetupAuthStartResult>(
        startMethod,
        { sessionId, authChoice },
        { timeoutMs: MODEL_SETUP_AUTH_START_TIMEOUT_MS, signal: abortController.signal },
      );
      if (generation !== this.generation) {
        return;
      }
      if (started.done) {
        this.applyResult(authChoice, started);
        return;
      }
      await this.requestNext(authChoice, undefined, generation);
    } catch (error) {
      this.handleError(error, generation);
    }
  }

  async answer(value: unknown, includeValue = true): Promise<void> {
    const state = this.currentState;
    if (state.phase !== "step" || state.busy || !this.sessionId) {
      return;
    }
    const generation = this.generation;
    this.setState({ ...state, busy: true, validationError: null });
    const answer = includeValue ? { stepId: state.step.id, value } : { stepId: state.step.id };
    try {
      await this.requestNext(state.authChoice, answer, generation);
    } catch (error) {
      this.handleError(error, generation);
    }
  }

  async cancel(): Promise<void> {
    const client = this.options.getClient();
    const sessionId = this.sessionId;
    this.generation += 1;
    this.sessionId = null;
    this.abortController?.abort();
    this.abortController = null;
    this.setState({ phase: "idle" });
    if (!client || !sessionId) {
      return;
    }
    try {
      await client.request(
        "wizard.cancel",
        { sessionId },
        { timeoutMs: MODEL_SETUP_AUTH_START_TIMEOUT_MS },
      );
    } catch {
      // The gateway may have already completed or purged the session.
    }
  }

  close(): void {
    this.generation += 1;
    this.sessionId = null;
    this.abortController?.abort();
    this.abortController = null;
    this.setState({ phase: "idle" });
  }

  fail(message: string): void {
    this.sessionId = null;
    this.abortController = null;
    this.setState({ phase: "error", message });
  }

  private async requestNext(
    authChoice: string,
    answer: { stepId: string; value?: unknown } | undefined,
    generation: number,
  ): Promise<void> {
    const client = this.options.getClient();
    const sessionId = this.sessionId;
    const signal = this.abortController?.signal;
    if (!client || !sessionId || !signal) {
      return;
    }
    const result = await client.request<WizardNextResult>(
      "wizard.next",
      { sessionId, ...(answer ? { answer } : {}) },
      { timeoutMs: MODEL_SETUP_WIZARD_NEXT_TIMEOUT_MS, signal },
    );
    if (generation !== this.generation) {
      return;
    }
    this.applyResult(authChoice, result);
  }

  private applyResult(authChoice: string, result: WizardNextResult): void {
    const next = wizardStateFromResult(
      authChoice,
      result,
      result.status === "cancelled"
        ? this.options.cancelledMessage()
        : this.options.requestFailedMessage(),
    );
    this.setState(next);
    if (next.phase === "done") {
      this.sessionId = null;
      this.abortController = null;
      this.options.onDone(this.startMethod, next.preparedModelRef);
      return;
    }
    // Gateway-executed steps (download/pull progress) carry no input controls,
    // so nothing would ever ask for the next one. Keep polling: the session
    // long-polls until the next update or the terminal result, so this renders
    // live progress instead of freezing on the first frame.
    if (next.phase === "step" && next.step.executor === "gateway") {
      const generation = this.generation;
      void this.requestNext(authChoice, undefined, generation).catch((error: unknown) => {
        this.handleError(error, generation);
      });
    }
  }

  private handleError(error: unknown, generation: number): void {
    if (generation !== this.generation) {
      return;
    }
    const client = this.options.getClient();
    const sessionId = this.sessionId;
    this.sessionId = null;
    this.abortController?.abort();
    this.abortController = null;
    const sessionExpired = isWizardNotFoundError(error);
    if (!sessionExpired && client && sessionId) {
      void client
        .request("wizard.cancel", { sessionId }, { timeoutMs: MODEL_SETUP_AUTH_START_TIMEOUT_MS })
        .catch(() => {
          // The failed request may have already completed or purged the session.
        });
    }
    const message = sessionExpired
      ? this.options.sessionExpiredMessage()
      : error instanceof Error && error.message.trim()
        ? error.message
        : this.options.requestFailedMessage();
    this.setState({ phase: "error", message });
  }

  private setState(state: ModelSetupWizardState): void {
    this.currentState = state;
    this.options.onChange(state);
  }
}
