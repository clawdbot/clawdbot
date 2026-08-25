// Wizard session helpers track onboarding session ids and state.
import { randomUUID } from "node:crypto";
import {
  MAX_WIZARD_QR_EXPIRES_IN_MS,
  type WizardStep as ProtocolWizardStep,
} from "../../packages/gateway-protocol/src/index.js";
import { QR_PNG_DATA_URL_MAX_LENGTH } from "../../packages/gateway-protocol/src/schema/primitives.js";
import { renderQrPngDataUrlWithinLimit } from "../media/qr-image.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import {
  DEVICE_CODE_PHISHING_WARNING,
  WizardCancelledError,
  type WizardProgress,
  type WizardPrompter,
  type WizardQrCodeParams,
} from "./prompts.js";

// WizardSession exposes interactive setup as a step/answer protocol for remote
// clients while reusing the same WizardPrompter contract as the local CLI.
type ProtocolWizardQrStep = Extract<ProtocolWizardStep, { type: "qr" }>;
type ProtocolWizardNonQrStep = Exclude<ProtocolWizardStep, ProtocolWizardQrStep>;
type WizardQrStep = Omit<ProtocolWizardQrStep, "qrDataUrl" | "expiresInMs"> & {
  qrDataUrl?: string;
  qrExpiresAtMs?: number;
};
type WizardQrStepInput = Omit<WizardQrStep, "canCancel">;
export type WizardStep = ProtocolWizardNonQrStep | WizardQrStep;
type WizardNonQrStepInput = Omit<ProtocolWizardNonQrStep, "id">;

export class WizardClientCapabilityError extends Error {
  constructor() {
    super("wizard: this QR step requires a QR-capable client");
    this.name = "WizardClientCapabilityError";
  }
}

/** Keep credential-bearing steps behind the capability negotiated by this client. */
export function assertWizardStepClientCapability(
  step: Pick<WizardStep, "type">,
  supportsQrCode: boolean,
): void {
  if (step.type === "qr" && !supportsQrCode) {
    throw new WizardClientCapabilityError();
  }
}

type WizardStepInputRequirement = "always" | "never" | "client-executor";

const WIZARD_STEP_INPUT_REQUIREMENT_BY_TYPE = {
  note: "never",
  select: "always",
  text: "always",
  confirm: "always",
  multiselect: "always",
  progress: "never",
  action: "client-executor",
  qr: "never",
} as const satisfies Record<WizardStep["type"], WizardStepInputRequirement>;

/** Whether a step needs a user answer instead of client or gateway acknowledgement. */
export function wizardStepAwaitsInput(step: WizardStep): boolean {
  const requirement = WIZARD_STEP_INPUT_REQUIREMENT_BY_TYPE[step.type];
  switch (requirement) {
    case "always":
      return true;
    case "never":
      return false;
    case "client-executor":
      return step.executor === "client";
  }
  const unhandledRequirement: never = requirement;
  return unhandledRequirement;
}

/** Remove secret prefill before a wizard step crosses a client boundary. */
function sanitizeWizardStepForClient(step: WizardStep): ProtocolWizardStep {
  if (step.type === "qr") {
    if (!step.qrDataUrl) {
      throw new Error("wizard: QR presentation is no longer active");
    }
    const { qrExpiresAtMs, ...clientStep } = step;
    return {
      ...clientStep,
      qrDataUrl: step.qrDataUrl,
      ...(qrExpiresAtMs !== undefined
        ? { expiresInMs: Math.max(0, qrExpiresAtMs - Date.now()) }
        : {}),
    };
  }
  if (step.sensitive !== true || step.initialValue === undefined) {
    return step;
  }
  const safe = { ...step };
  delete safe.initialValue;
  return safe;
}

type WizardSessionStatus = "running" | "done" | "cancelled" | "error";

type WizardNextResult = {
  done: boolean;
  step?: WizardStep;
  status: WizardSessionStatus;
  error?: string;
  channels?: string[];
  accounts?: Array<{ channel: string; accountId: string }>;
  preparedModelRef?: string;
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
  readonly qrCode?: NonNullable<WizardPrompter["qrCode"]>;

  constructor(
    private session: WizardSession,
    supportsQrCode: boolean,
  ) {
    if (supportsQrCode) {
      this.qrCode = async <T>(params: WizardQrCodeParams<T>): Promise<T> => {
        if (
          params.expiresInMs !== undefined &&
          (!Number.isSafeInteger(params.expiresInMs) ||
            params.expiresInMs < 0 ||
            params.expiresInMs > MAX_WIZARD_QR_EXPIRES_IN_MS)
        ) {
          throw new RangeError(
            `expiresInMs must be an integer from 0 through ${MAX_WIZARD_QR_EXPIRES_IN_MS}.`,
          );
        }
        const qrExpiresAtMs =
          params.expiresInMs === undefined ? undefined : Date.now() + params.expiresInMs;
        if (qrExpiresAtMs !== undefined && !Number.isSafeInteger(qrExpiresAtMs)) {
          throw new RangeError("expiresInMs exceeds the supported presentation deadline.");
        }
        let producerSettled = false;
        const settled = params.settled.finally(() => {
          producerSettled = true;
        });
        // Rendering can outlive an early producer rejection; presentQr still
        // observes and normalizes this same eventual outcome.
        void settled.catch(() => undefined);
        const qrDataUrl = await renderQrPngDataUrlWithinLimit(
          params.text,
          QR_PNG_DATA_URL_MAX_LENGTH,
        );
        // Let a producer resolved in the renderer's completion turn update the
        // tracker before presentQr makes the credential-bearing step visible.
        await Promise.resolve();
        return await this.session.presentQr(
          {
            id: randomUUID(),
            type: "qr",
            title: params.title,
            ...(params.message ? { message: params.message } : {}),
            qrDataUrl,
            ...(qrExpiresAtMs !== undefined ? { qrExpiresAtMs } : {}),
            executor: "gateway",
          },
          { promise: settled, isSettled: () => producerSettled },
        );
      };
    }
  }

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
    await this.prompt({
      type: "note",
      title,
      message,
      executor: "client",
    });
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
      ...(params.expiresInMinutes ? [`Code expires in ${params.expiresInMinutes} minutes.`] : []),
      // Device-code phishing works by getting the victim to enter the attacker's
      // code, so the warning has to cover received codes, not just shared ones.
      // Unconditional: codes delivered over a chat channel are the risky case and
      // carry no expiry hint. Matches the Codex CLI prompt.
      DEVICE_CODE_PHISHING_WARNING,
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
    await this.prompt({
      type: "note",
      message,
      format: "plain",
      executor: "client",
    });
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

  private async prompt(step: WizardNonQrStepInput): Promise<unknown> {
    return await this.session.awaitAnswer(this.createStep(step));
  }

  private createStep(step: WizardNonQrStepInput): ProtocolWizardNonQrStep {
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
  private readonly runnerPromise: Promise<void>;
  private currentStep: WizardStep | null = null;
  private progressSteps: WizardStep[] = [];
  private deliveredProgressStepIds = new Set<string>();
  private stepDeferred: Deferred<WizardStep | null> | null = null;
  private pendingTerminalResolution = false;
  private cancellationLocked = false;
  private settled = false;
  private pendingExternalUrl: string | undefined;
  private deliveredPassiveStepId: string | undefined;
  private rejectQrExpiry: (() => void) | undefined;
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
  private preparedModelRef: string | undefined;
  private readonly ownerKey: string | undefined;

  constructor(
    private runner: (
      prompter: WizardPrompter,
      signal: AbortSignal,
      session: WizardSession,
    ) => Promise<void>,
    options?: { timeoutMs?: number; supportsQrCode?: boolean; ownerKey?: string },
  ) {
    this.ownerKey = options?.ownerKey;
    const prompter = new WizardSessionPrompter(this, options?.supportsQrCode === true);
    if (options?.timeoutMs !== undefined) {
      this.expiryTimer = setTimeout(() => this.cancel(), options.timeoutMs);
      this.expiryTimer.unref?.();
    }
    this.runnerPromise = this.run(prompter);
  }

  /** Match Gateway-owned sessions while leaving local wizard sessions unbound. */
  isOwnedBy(ownerKey: string | undefined): boolean {
    return this.ownerKey === undefined || this.ownerKey === ownerKey;
  }

  async next(options?: { supportsQrCode?: boolean }): Promise<WizardNextResult> {
    const progressStep = this.progressSteps.shift();
    if (progressStep) {
      this.rememberDeliveredProgressStep(progressStep.id);
      return { done: false, step: progressStep, status: this.status };
    }
    if (this.currentStep) {
      assertWizardStepClientCapability(this.currentStep, options?.supportsQrCode === true);
      if (this.currentStep.type === "qr" && this.deliveredPassiveStepId === this.currentStep.id) {
        if (!this.stepDeferred) {
          this.stepDeferred = createDeferredCore();
        }
        const step = await this.stepDeferred.promise;
        return step ? { done: false, step, status: this.status } : this.terminalResult();
      }
      if (this.currentStep.type === "qr") {
        this.deliveredPassiveStepId = this.currentStep.id;
      }
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
      this.stepDeferred = createDeferredCore();
    }
    const step = await this.stepDeferred.promise;
    if (step) {
      assertWizardStepClientCapability(step, options?.supportsQrCode === true);
      if (step.type === "qr") {
        this.deliveredPassiveStepId = step.id;
      }
      return { done: false, step, status: this.status };
    }
    return this.terminalResult();
  }

  private terminalResult(): WizardNextResult {
    return {
      done: true,
      status: this.status,
      error: this.error,
      ...(this.configuredAccounts
        ? {
            channels: [...new Set(this.configuredAccounts.map((entry) => entry.channel))],
            accounts: this.configuredAccounts.map((entry) => ({ ...entry })),
          }
        : {}),
      ...(this.status === "done" && this.preparedModelRef
        ? { preparedModelRef: this.preparedModelRef }
        : {}),
    };
  }

  /** Record what the channels flow actually configured (channels flow only). */
  setConfiguredAccounts(accounts: ReadonlyArray<{ channel: string; accountId: string }>) {
    this.configuredAccounts = accounts.map((entry) => ({ ...entry }));
  }

  /** Record the exact provider-owned model prepared by a setup flow. */
  setPreparedModelRef(modelRef: string) {
    this.preparedModelRef = modelRef;
  }

  async answer(stepId: string, value: unknown): Promise<string | undefined> {
    if (this.currentStep?.id === stepId && this.currentStep.type === "qr") {
      throw new Error("wizard: QR steps settle through their producer");
    }
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
    this.clearCurrentStep();
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
    this.clearCurrentStep();
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

  /** Project one owned step, retiring an elapsed QR before any client can receive it. */
  projectStepForClient(step: WizardStep): ProtocolWizardStep | null {
    return this.retireQrIfExpired(step) ? null : sanitizeWizardStepForClient(step);
  }

  private pushStep(step: WizardStep) {
    this.deliveredPassiveStepId = undefined;
    this.currentStep = step;
    this.resolveStep(step);
  }

  /** @internal Present a QR until its producer settles; clients cannot answer it. */
  async presentQr<T>(
    step: WizardQrStepInput,
    settlement: { promise: Promise<T>; isSettled: () => boolean },
  ): Promise<T> {
    if (this.status !== "running") {
      throw new Error("wizard: session not running");
    }
    // A completed producer invalidates its credential-bearing QR. This check
    // and projection are synchronous so settlement cannot interleave them.
    if (!settlement.isSettled()) {
      this.pushStep({ ...step, canCancel: !this.cancellationLocked });
    }
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectCancelled!: (error: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectCancelled = reject;
    });
    const onAbort = () => rejectCancelled(new WizardCancelledError());
    this.signal.addEventListener("abort", onAbort, { once: true });
    const waits: Array<Promise<T>> = [settlement.promise, cancelled];
    const expired = new Error("wizard: QR presentation expired; restart setup to retry");
    if (step.qrExpiresAtMs !== undefined) {
      waits.push(
        new Promise<T>((_resolve, reject) => {
          this.rejectQrExpiry = () => reject(expired);
          expiryTimer = setTimeout(
            () => this.retireQrIfExpired(step),
            Math.max(0, step.qrExpiresAtMs! - Date.now()),
          );
          expiryTimer.unref?.();
        }),
      );
    }
    try {
      const result = await Promise.race(waits);
      this.lockCancellation();
      return result;
    } catch (error) {
      if (this.signal.aborted || error instanceof WizardCancelledError) {
        throw new WizardCancelledError();
      }
      if (error === expired) {
        throw expired;
      }
      throw new Error("wizard: QR presentation failed; retry setup", { cause: error });
    } finally {
      if (expiryTimer) {
        clearTimeout(expiryTimer);
      }
      this.signal.removeEventListener("abort", onAbort);
      if (this.currentStep?.id === step.id) {
        this.clearCurrentStep();
      }
    }
  }

  private clearCurrentStep() {
    if (this.currentStep?.type === "qr") {
      delete this.currentStep.qrDataUrl;
      delete this.currentStep.qrExpiresAtMs;
    }
    this.currentStep = null;
    this.deliveredPassiveStepId = undefined;
    this.rejectQrExpiry = undefined;
  }

  private retireQrIfExpired(step: WizardStep): boolean {
    if (step.type !== "qr" || step.qrExpiresAtMs === undefined || step.qrExpiresAtMs > Date.now()) {
      return false;
    }
    if (this.currentStep?.id === step.id) {
      const rejectExpiry = this.rejectQrExpiry;
      this.clearCurrentStep();
      rejectExpiry?.();
    } else {
      delete step.qrDataUrl;
      delete step.qrExpiresAtMs;
    }
    return true;
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
      this.clearCurrentStep();
      this.settled = true;
      if (this.expiryTimer) {
        clearTimeout(this.expiryTimer);
      }
      this.resolveStep(null);
    }
  }

  async awaitAnswer(
    step: ProtocolWizardNonQrStep,
    validate?: (value: string) => string | undefined,
  ): Promise<unknown> {
    if (this.status !== "running") {
      throw new Error("wizard: session not running");
    }
    this.pushStep(step);
    const deferred = createDeferredCore<unknown>();
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

  /** Whether the runner has stopped and can no longer mutate setup state. */
  isSettled(): boolean {
    return this.settled;
  }

  /** Resolves after the runner can no longer mutate setup state. */
  whenSettled(): Promise<void> {
    return this.runnerPromise;
  }

  getError(): string | undefined {
    return this.error;
  }
}
