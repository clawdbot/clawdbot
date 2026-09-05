import type {
  WizardStartResult,
  WizardStatusResult,
} from "../../../../packages/gateway-protocol/src/schema/wizard.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SystemAgentSetupActivateParams, WizardNextResult } from "../../api/types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isSetupAdmissionBusyError, isWizardNotFoundError } from "../../lib/gateway-errors.ts";
import { generateUUID } from "../../lib/uuid.ts";
import {
  MODEL_SETUP_AUTH_START_TIMEOUT_MS,
  MODEL_SETUP_WIZARD_NEXT_TIMEOUT_MS,
  type ModelSetupWizardState,
  wizardStateFromResult,
} from "./state.ts";

export type ModelSetupWizardStartMethod =
  | "openclaw.setup.auth.start"
  | "openclaw.setup.prepare.start"
  | "openclaw.setup.activate.start";

export type ModelSetupWizardCompletion = {
  startMethod: ModelSetupWizardStartMethod;
  preparedModelRef?: string;
  activationTargetId?: string;
  modelActivation?: WizardNextResult["modelActivation"];
  isCurrent?: () => boolean;
};

type WizardTerminalObserver = (
  result: WizardNextResult,
  admissionRejected?: true,
) => (() => boolean) | void;

type WizardRunnerOptions = {
  getClient: () => GatewayBrowserClient | null;
  getAgentId: () => string | null;
  onChange: (state: ModelSetupWizardState) => void;
  onStart?: (
    method: ModelSetupWizardStartMethod,
    activation?: SystemAgentSetupActivateParams,
  ) => WizardTerminalObserver | undefined;
  requestFailedMessage: () => string;
  cancelledMessage: () => string;
  sessionExpiredMessage: () => string;
};

type WizardSession = {
  client: GatewayBrowserClient;
  sessionId: string;
  abortController: AbortController;
  startMethod: ModelSetupWizardStartMethod;
  activationTargetId?: string;
  admissionRejected?: true;
  onTerminalResult?: WizardTerminalObserver;
};

export class ModelSetupWizardRunner {
  private currentState: ModelSetupWizardState = { phase: "idle" };
  private session: WizardSession | null = null;

  constructor(private readonly options: WizardRunnerOptions) {}

  get state(): ModelSetupWizardState {
    return this.currentState;
  }

  async start(
    authChoice: string,
    startMethod: Exclude<
      ModelSetupWizardStartMethod,
      "openclaw.setup.activate.start"
    > = "openclaw.setup.auth.start",
  ): Promise<ModelSetupWizardCompletion | null> {
    return this.startSession(authChoice, startMethod, { authChoice });
  }

  activate(
    params: SystemAgentSetupActivateParams,
    targetId: string,
  ): Promise<ModelSetupWizardCompletion | null> {
    return this.startSession(
      params.authChoice ?? params.kind,
      "openclaw.setup.activate.start",
      params,
      targetId,
    );
  }

  private async startSession(
    authChoice: string,
    startMethod: ModelSetupWizardStartMethod,
    params: { authChoice: string } | SystemAgentSetupActivateParams,
    activationTargetId?: string,
  ): Promise<ModelSetupWizardCompletion | null> {
    const client = this.options.getClient();
    if (!client || this.currentState.phase !== "idle") {
      return null;
    }
    const session: WizardSession = {
      client,
      sessionId: generateUUID(),
      abortController: new AbortController(),
      startMethod,
      activationTargetId,
      onTerminalResult: this.options.onStart?.(startMethod, "kind" in params ? params : undefined),
    };
    this.session = session;
    this.setState({ phase: "starting", authChoice });
    try {
      const agentId = this.options.getAgentId();
      const request = client
        .request<WizardStartResult>(
          startMethod,
          {
            sessionId: session.sessionId,
            ...params,
            ...(agentId ? { agentId } : {}),
          },
          { timeoutMs: null },
        )
        .catch((error: unknown): WizardStartResult => {
          if (!isSetupAdmissionBusyError(error)) {
            throw error;
          }
          session.admissionRejected = true;
          // Normalize only the retained start's proven non-admission, including
          // late replies after deadline/disposal, through exact terminal cleanup.
          return {
            sessionId: session.sessionId,
            done: true,
            status: "error",
            error: formatUiError(error, this.options.requestFailedMessage()),
          };
        });
      const started = await this.awaitWizardStart(session, request);
      if (session !== this.session && !started.done) {
        // Admission can finish after cancellation; release only its original session.
        await this.cancelSession(session);
        return null;
      }
      if (started.done) {
        return this.applyResult(session, authChoice, started);
      }
      return await this.requestNext(session, authChoice);
    } catch (error) {
      this.handleError(error, session);
      return null;
    }
  }

  async answer(value: unknown, includeValue = true): Promise<ModelSetupWizardCompletion | null> {
    const state = this.currentState;
    const session = this.session;
    if (state.phase !== "step" || state.busy || !session) {
      return null;
    }
    this.setState({ ...state, busy: true, validationError: null });
    const answer = includeValue ? { stepId: state.step.id, value } : { stepId: state.step.id };
    try {
      return await this.requestNext(session, state.authChoice, answer);
    } catch (error) {
      this.handleError(error, session);
      return null;
    }
  }

  async cancel(options: { settleActiveRequest?: boolean } = {}): Promise<void> {
    const session = this.session;
    if (!options.settleActiveRequest) {
      session?.abortController.abort();
    }
    this.session = null;
    this.setState({ phase: "idle" });
    if (session) {
      await this.cancelSession(session);
    }
  }

  close(): void {
    this.session?.abortController.abort();
    this.session = null;
    this.setState({ phase: "idle" });
  }

  fail(message: string): void {
    this.session = null;
    this.setState({ phase: "error", message });
  }

  private async awaitWizardStart(
    session: WizardSession,
    request: Promise<WizardStartResult>,
  ): Promise<WizardStartResult> {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Gateway request abort/deadline retirement discards the late session needed for cleanup.
    const retainedRequest = request.then(async (result) => {
      if (timedOut) {
        if (result.done) {
          this.reportTerminalResult(session, result);
        } else {
          await this.cancelSession(session);
        }
      }
      return result;
    });
    try {
      return await Promise.race([
        retainedRequest,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(
              new Error(
                `gateway request timed out after ${MODEL_SETUP_AUTH_START_TIMEOUT_MS}ms: ${session.startMethod}`,
              ),
            );
          }, MODEL_SETUP_AUTH_START_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async requestNext(
    session: WizardSession,
    authChoice: string,
    answer?: { stepId: string; value?: unknown },
  ): Promise<ModelSetupWizardCompletion | null> {
    const { client, sessionId, abortController } = session;
    const signal = abortController.signal;
    let nextAnswer = answer;
    while (true) {
      const result = await client.request<WizardNextResult>(
        "wizard.next",
        { sessionId, ...(nextAnswer ? { answer: nextAnswer } : {}) },
        { timeoutMs: MODEL_SETUP_WIZARD_NEXT_TIMEOUT_MS, signal },
      );
      const completion = this.applyResult(session, authChoice, result);
      if (session !== this.session || completion) {
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
    session: WizardSession,
    authChoice: string,
    result: WizardNextResult,
  ): ModelSetupWizardCompletion | null {
    const isCurrent = this.reportTerminalResult(session, result);
    if (session !== this.session) {
      return null;
    }
    if (isCurrent?.() === false) {
      this.close();
      return null;
    }
    const next = wizardStateFromResult(
      authChoice,
      result,
      result.status === "cancelled"
        ? this.options.cancelledMessage()
        : this.options.requestFailedMessage(),
    );
    if (result.done) {
      this.session = null;
    }
    this.setState(next);
    if (next.phase !== "done") {
      return null;
    }
    return {
      startMethod: session.startMethod,
      ...(session.activationTargetId ? { activationTargetId: session.activationTargetId } : {}),
      ...(isCurrent ? { isCurrent } : {}),
      ...(next.preparedModelRef ? { preparedModelRef: next.preparedModelRef } : {}),
      ...(result.modelActivation ? { modelActivation: result.modelActivation } : {}),
    };
  }

  private handleError(error: unknown, session: WizardSession): void {
    if (session !== this.session) {
      return;
    }
    this.session = null;
    session.abortController.abort();
    const sessionExpired = isWizardNotFoundError(error);
    if (!sessionExpired) {
      void this.cancelSession(session);
    }
    const message = sessionExpired
      ? this.options.sessionExpiredMessage()
      : formatUiError(error, this.options.requestFailedMessage());
    this.setState({ phase: "error", message });
  }

  private async cancelSession(session: WizardSession): Promise<void> {
    try {
      const result = await session.client.request<WizardStatusResult>(
        "wizard.cancel",
        { sessionId: session.sessionId },
        { timeoutMs: MODEL_SETUP_AUTH_START_TIMEOUT_MS },
      );
      if (result.status === "cancelled" || result.status === "error") {
        this.reportTerminalResult(session, { done: true, ...result });
      }
    } catch {
      // The Gateway may already have completed or purged the session.
    }
  }

  private reportTerminalResult(
    session: WizardSession,
    result: WizardNextResult,
  ): (() => boolean) | void {
    // Confirmed failure/cancellation owns exact receipt cleanup after presentation retires.
    // Success and visible state still require this runner's live session.
    const failed = result.status === "cancelled" || result.status === "error";
    if (result.done && (session === this.session || failed)) {
      return session.admissionRejected
        ? session.onTerminalResult?.(result, true)
        : session.onTerminalResult?.(result);
    }
  }

  private setState(state: ModelSetupWizardState): void {
    this.currentState = state;
    this.options.onChange(state);
  }
}
