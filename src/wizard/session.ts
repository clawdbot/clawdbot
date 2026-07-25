// Wizard session helpers track onboarding session ids and state.
import { randomUUID } from "node:crypto";
import { createDeferred, type Deferred } from "../shared/deferred.js";
import { WizardCancelledError, type WizardProgress, type WizardPrompter } from "./prompts.js";

// WizardSession exposes interactive setup as a step/answer protocol for remote
// clients while reusing the same WizardPrompter contract as the local CLI.
type WizardStepOption = {
  value: unknown;
  label: string;
  hint?: string;
};

export type WizardStep = {
  id: string;
  type: "note" | "select" | "text" | "confirm" | "multiselect" | "progress" | "action";
  title?: string;
  message?: string;
  format?: "plain";
  options?: WizardStepOption[];
  initialValue?: unknown;
  placeholder?: string;
  sensitive?: boolean;
  executor?: "gateway" | "client";
  externalUrl?: string;
  deviceCode?: {
    code: string;
    expiresInMinutes?: number;
    message?: string;
  };
};

type WizardSessionStatus = "running" | "done" | "cancelled" | "error";

type WizardNextResult = {
  done: boolean;
  step?: WizardStep;
  status: WizardSessionStatus;
  error?: string;
  channels?: string[];
  accounts?: Array<{ channel: string; accountId: string }>;
};

function normalizeTextAnswer(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return undefined;
}

class WizardSessionPrompter implements WizardPrompter {
  constructor(private session: WizardSession) {}

  async intro(title: string): Promise<void> {
    await this.prompt({
      type: "note",
      title,
      message: "",
      executor: "client",
    });
  }

  async outro(message: string): Promise<void> {
    await this.prompt({
      type: "note",
      title: "Done",
      message,
      executor: "client",
    });
  }

  async note(message: string, title?: string): Promise<void> {
    await this.prompt({ type: "note", title, message, executor: "client" });
  }

  async deviceCode(params: {
    title: string;
    code: string;
    expiresInMinutes?: number;
    message?: string;
  }): Promise<void> {
    const fallbackMessage = [
      params.message ?? "Enter this one-time code on the provider's sign-in page.",
      `Code: ${params.code}`,
      ...(params.expiresInMinutes
        ? [`Code expires in ${params.expiresInMinutes} minutes. Never share it.`]
        : []),
    ].join("\n");
    await this.prompt({
      type: "note",
      title: params.title,
      message: fallbackMessage,
      deviceCode: {
        code: params.code,
        ...(params.expiresInMinutes ? { expiresInMinutes: params.expiresInMinutes } : {}),
        ...(params.message ? { message: params.message } : {}),
      },
      executor: "client",
    });
  }

  async plain(message: string): Promise<void> {
    await this.prompt({ type: "note", message, format: "plain", executor: "client" });
  }

  async select<T>(params: {
    message: string;
    options: Array<{ value: T; label: string; hint?: string }>;
    initialValue?: T;
  }): Promise<T> {
    const res = await this.prompt({
      type: "select",
      message: params.message,
      options: params.options.map((opt) => ({
        value: opt.value,
        label: opt.label,
        hint: opt.hint,
      })),
      initialValue: params.initialValue,
      executor: "client",
    });
    return res as T;
  }

  async multiselect<T>(params: {
    message: string;
    options: Array<{ value: T; label: string; hint?: string }>;
    initialValues?: T[];
  }): Promise<T[]> {
    const res = await this.prompt({
      type: "multiselect",
      message: params.message,
      options: params.options.map((opt) => ({
        value: opt.value,
        label: opt.label,
        hint: opt.hint,
      })),
      initialValue: params.initialValues,
      executor: "client",
    });
    return (Array.isArray(res) ? res : []) as T[];
  }

  async text(params: {
    message: string;
    initialValue?: string;
    placeholder?: string;
    validate?: (value: string) => string | undefined;
    sensitive?: boolean;
  }): Promise<string> {
    const res = await this.session.awaitAnswer(
      this.createStep({
        type: "text",
        message: params.message,
        initialValue: params.initialValue,
        placeholder: params.placeholder,
        sensitive: params.sensitive,
        executor: "client",
      }),
      params.validate,
    );
    const value =
      res === null || res === undefined
        ? ""
        : typeof res === "string"
          ? res
          : typeof res === "number" || typeof res === "boolean" || typeof res === "bigint"
            ? String(res)
            : "";
    return value;
  }

  async confirm(params: Parameters<WizardPrompter["confirm"]>[0]): Promise<boolean> {
    const res = await this.prompt({
      type: "confirm",
      message: params.message,
      initialValue: params.initialValue,
      executor: "client",
    });
    return Boolean(res);
  }

  progress(label: string): WizardProgress {
    let stopped = false;
    this.session.pushProgress(label);
    return {
      update: (message) => {
        if (!stopped) {
          this.session.pushProgress(message);
        }
      },
      stop: (message) => {
        if (stopped) {
          return;
        }
        stopped = true;
        if (message) {
          this.session.pushProgress(message);
        }
      },
    };
  }

  async openUrl(url: string): Promise<void> {
    this.session.queueExternalUrl(url);
  }

  private async prompt(step: Omit<WizardStep, "id">): Promise<unknown> {
    return await this.session.awaitAnswer(this.createStep(step));
  }

  private createStep(step: Omit<WizardStep, "id">): WizardStep {
    // Each emitted step receives an id so remote clients can answer the exact
    // pending prompt and stale answers can be rejected. Explicit browser
    // destinations bind to the very next step regardless of its input type.
    const externalUrl = this.session.consumeExternalUrl();
    return {
      ...step,
      ...(externalUrl ? { externalUrl } : {}),
      id: randomUUID(),
    };
  }
}

export class WizardSession {
  private readonly abortController = new AbortController();
  private readonly expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private currentStep: WizardStep | null = null;
  private progressSteps: WizardStep[] = [];
  private deliveredProgressStepIds = new Set<string>();
  private stepDeferred: Deferred<WizardStep | null> | null = null;
  private pendingTerminalResolution = false;
  private cancellationLocked = false;
  private pendingExternalUrl: string | undefined;
  private answerDeferred = new Map<
    string,
    {
      deferred: Deferred<unknown>;
      text: boolean;
      validate?: (value: string) => string | undefined;
    }
  >();
  private status: WizardSessionStatus = "running";
  private error: string | undefined;
  private configuredAccounts: Array<{ channel: string; accountId: string }> | undefined;

  constructor(
    private runner: (
      prompter: WizardPrompter,
      signal: AbortSignal,
      session: WizardSession,
    ) => Promise<void>,
    options?: { timeoutMs?: number },
  ) {
    const prompter = new WizardSessionPrompter(this);
    if (options?.timeoutMs !== undefined) {
      this.expiryTimer = setTimeout(() => this.cancel(), options.timeoutMs);
      this.expiryTimer.unref?.();
    }
    void this.run(prompter);
  }

  async next(): Promise<WizardNextResult> {
    const progressStep = this.progressSteps.shift();
    if (progressStep) {
      this.rememberDeliveredProgressStep(progressStep.id);
      return { done: false, step: progressStep, status: this.status };
    }
    if (this.currentStep) {
      return { done: false, step: this.currentStep, status: this.status };
    }
    if (this.pendingTerminalResolution) {
      this.pendingTerminalResolution = false;
      return this.terminalResult();
    }
    if (this.status !== "running") {
      return this.terminalResult();
    }
    if (!this.stepDeferred) {
      this.stepDeferred = createDeferred();
    }
    const step = await this.stepDeferred.promise;
    if (step) {
      return { done: false, step, status: this.status };
    }
    return this.terminalResult();
  }

  private terminalResult(): WizardNextResult {
    if (!this.configuredAccounts) {
      return { done: true, status: this.status, error: this.error };
    }
    return {
      done: true,
      status: this.status,
      error: this.error,
      channels: [...new Set(this.configuredAccounts.map((entry) => entry.channel))],
      accounts: this.configuredAccounts.map((entry) => ({ ...entry })),
    };
  }

  /** Record what the channels flow actually configured (channels flow only). */
  setConfiguredAccounts(accounts: ReadonlyArray<{ channel: string; accountId: string }>) {
    this.configuredAccounts = accounts.map((entry) => ({ ...entry }));
  }

  async answer(stepId: string, value: unknown): Promise<string | undefined> {
    const pending = this.answerDeferred.get(stepId);
    if (!pending) {
      // Gateway-owned progress steps never block the provider run. Older
      // clients still acknowledge every rendered step, so accept that stale
      // acknowledgement while newer clients poll without an answer.
      if (this.deliveredProgressStepIds.delete(stepId)) {
        return undefined;
      }
      throw new Error("wizard: no pending step");
    }
    const normalizedValue = pending.text ? normalizeTextAnswer(value) : value;
    if (pending.text && normalizedValue === undefined) {
      return "wizard: text answer must be a scalar value";
    }
    const validationError = pending.validate?.(normalizedValue as string) ?? undefined;
    if (validationError) {
      return validationError;
    }
    this.answerDeferred.delete(stepId);
    this.currentStep = null;
    pending.deferred.resolve(normalizedValue);
    return undefined;
  }

  cancel(): boolean {
    if (this.status !== "running" || this.cancellationLocked) {
      return false;
    }
    this.status = "cancelled";
    this.error = "cancelled";
    this.abortController.abort(new WizardCancelledError());
    this.currentStep = null;
    for (const [, pending] of this.answerDeferred) {
      // Reject all pending prompt promises so the runner can unwind through its
      // normal cancellation path.
      pending.deferred.reject(new WizardCancelledError());
    }
    this.answerDeferred.clear();
    this.progressSteps = [];
    this.deliveredProgressStepIds.clear();
    this.resolveStep(null);
    return true;
  }

  /** The underlying mutation crossed its durable commit point and must finish. */
  lockCancellation() {
    this.cancellationLocked = true;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  pushStep(step: WizardStep) {
    this.currentStep = step;
    this.resolveStep(step);
  }

  pushProgress(message: string) {
    if (this.status !== "running") {
      return;
    }
    const step: WizardStep = {
      id: randomUUID(),
      type: "progress",
      message,
      executor: "gateway",
    };
    if (this.stepDeferred) {
      this.rememberDeliveredProgressStep(step.id);
      this.resolveStep(step);
      return;
    }
    // Keep the oldest unread event and the newest snapshot. This preserves the
    // initial label while bounding bursty pull updates between client polls.
    if (this.progressSteps.length >= 2) {
      this.progressSteps[this.progressSteps.length - 1] = step;
      return;
    }
    this.progressSteps.push(step);
  }

  private rememberDeliveredProgressStep(stepId: string) {
    this.deliveredProgressStepIds.add(stepId);
    if (this.deliveredProgressStepIds.size <= 64) {
      return;
    }
    const oldest = this.deliveredProgressStepIds.values().next().value;
    if (oldest) {
      this.deliveredProgressStepIds.delete(oldest);
    }
  }

  queueExternalUrl(url: string) {
    this.pendingExternalUrl = url;
  }

  consumeExternalUrl(): string | undefined {
    const url = this.pendingExternalUrl;
    this.pendingExternalUrl = undefined;
    return url;
  }

  private async run(prompter: WizardPrompter) {
    try {
      await this.runner(prompter, this.signal, this);
      if (this.status === "running") {
        this.status = "done";
      }
    } catch (err) {
      if (this.status !== "running") {
        return;
      }
      if (err instanceof WizardCancelledError) {
        this.status = "cancelled";
        this.error = err.message;
      } else {
        this.status = "error";
        this.error = String(err);
      }
    } finally {
      if (this.expiryTimer) {
        clearTimeout(this.expiryTimer);
      }
      this.resolveStep(null);
    }
  }

  async awaitAnswer(
    step: WizardStep,
    validate?: (value: string) => string | undefined,
  ): Promise<unknown> {
    if (this.status !== "running") {
      throw new Error("wizard: session not running");
    }
    this.pushStep(step);
    const deferred = createDeferred<unknown>();
    this.answerDeferred.set(step.id, { deferred, text: step.type === "text", validate });
    return await deferred.promise;
  }

  private resolveStep(step: WizardStep | null) {
    if (!this.stepDeferred) {
      if (step === null) {
        // The runner can finish immediately after an answer before next() has
        // installed a waiter; remember that terminal state for the next poll.
        this.pendingTerminalResolution = true;
      }
      return;
    }
    const deferred = this.stepDeferred;
    this.stepDeferred = null;
    deferred.resolve(step);
  }

  getStatus(): WizardSessionStatus {
    return this.status;
  }

  getError(): string | undefined {
    return this.error;
  }
}
