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

export type ModelSetupWizardCompletion = {
  startMethod: ModelSetupWizardStartMethod;
  preparedModelRef?: string;
};

type WizardRunnerOptions = {
  getClient: () => GatewayBrowserClient | null;
  onChange: (state: ModelSetupWizardState) => void;
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
  ): Promise<ModelSetupWizardCompletion | null> {
    const client = this.options.getClient();
    if (!client || this.currentState.phase !== "idle") {
      return null;
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
        return null;
      }
      if (started.done) {
        return this.applyResult(authChoice, started);
      }
      return await this.requestNext(authChoice, undefined, generation);
    } catch (error) {
      this.handleError(error, generation);
      return null;
    }
  }

  async answer(value: unknown, includeValue = true): Promise<ModelSetupWizardCompletion | null> {
    const state = this.currentState;
    if (state.phase !== "step" || state.busy || !this.sessionId) {
      return null;
    }
    const generation = this.generation;
    this.setState({ ...state, busy: true, validationError: null });
    const answer = includeValue ? { stepId: state.step.id, value } : { stepId: state.step.id };
    try {
      return await this.requestNext(state.authChoice, answer, generation);
    } catch (error) {
      this.handleError(error, generation);
      return null;
    }
  }

  async cancel(options: { settleActiveRequest?: boolean } = {}): Promise<void> {
    const client = this.options.getClient();
    const sessionId = this.sessionId;
    this.generation += 1;
    this.sessionId = null;
    if (!options.settleActiveRequest) {
      this.abortController?.abort();
    }
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
  ): Promise<ModelSetupWizardCompletion | null> {
    const client = this.options.getClient();
    const sessionId = this.sessionId;
    const signal = this.abortController?.signal;
    if (!client || !sessionId || !signal) {
      return null;
    }
    let nextAnswer = answer;
    while (true) {
      const result = await client.request<WizardNextResult>(
        "wizard.next",
        { sessionId, ...(nextAnswer ? { answer: nextAnswer } : {}) },
        { timeoutMs: MODEL_SETUP_WIZARD_NEXT_TIMEOUT_MS, signal },
      );
      if (generation !== this.generation) {
        return null;
      }
      const completion = this.applyResult(authChoice, result);
      if (completion) {
        return completion;
      }
      const next = this.currentState;
      if (next.phase !== "step" || next.step.executor !== "gateway") {
        return null;
      }
      // Gateway-owned progress has no user control to trigger the next poll.
      // Keep it in this request chain so its mutation owner settles with it.
      nextAnswer = undefined;
    }
  }

  private applyResult(
    authChoice: string,
    result: WizardNextResult,
  ): ModelSetupWizardCompletion | null {
    const next = wizardStateFromResult(
      authChoice,
      result,
      result.status === "cancelled"
        ? this.options.cancelledMessage()
        : this.options.requestFailedMessage(),
    );
    this.setState(next);
    if (next.phase !== "done") {
      return null;
    }
    this.sessionId = null;
    this.abortController = null;
    return {
      startMethod: this.startMethod,
      ...(next.preparedModelRef ? { preparedModelRef: next.preparedModelRef } : {}),
    };
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
