import { randomUUID } from "node:crypto";
import { WizardCancelledError, type WizardProgress, type WizardPrompter } from "./prompts.js";

export type WizardStepOption = {
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
};

export type WizardSessionStatus = "running" | "done" | "cancelled" | "error";

export type WizardNextResult = {
  done: boolean;
  step?: WizardStep;
  status: WizardSessionStatus;
  error?: string;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
  }): Promise<string> {
    const res = await this.prompt({
      type: "text",
      message: params.message,
      initialValue: params.initialValue,
      placeholder: params.placeholder,
      executor: "client",
    });
    const value =
      res === null || res === undefined
        ? ""
        : typeof res === "string"
          ? res
          : typeof res === "number" || typeof res === "boolean" || typeof res === "bigint"
            ? String(res)
            : "";
    const error = params.validate?.(value);
    if (error) {
      throw new Error(error);
    }
    return value;
  }

  async confirm(params: { message: string; initialValue?: boolean }): Promise<boolean> {
    const res = await this.prompt({
      type: "confirm",
      message: params.message,
      initialValue: params.initialValue,
      executor: "client",
    });
    return Boolean(res);
  }

  progress(_label: string): WizardProgress {
    return {
      update: (_message) => {},
      stop: (_message) => {},
    };
  }

  private async prompt(step: Omit<WizardStep, "id">): Promise<unknown> {
    return await this.session.awaitAnswer({
      ...step,
      id: randomUUID(),
    });
  }
}

export class WizardSession {
  private currentStep: WizardStep | null = null;
  private stepDeferred: Deferred<WizardStep | null> | null = null;
  private pendingTerminalResolution = false;
  private answerDeferred = new Map<string, Deferred<unknown>>();
  private status: WizardSessionStatus = "running";
  private error: string | undefined;

  constructor(private runner: (prompter: WizardPrompter) => Promise<void>) {
    const prompter = new WizardSessionPrompter(this);
    void this.run(prompter);
  }

  async next(): Promise<WizardNextResult> {
    if (this.currentStep) {
      return { done: false, step: this.currentStep, status: this.status };
    }
    if (this.pendingTerminalResolution) {
      this.pendingTerminalResolution = false;
      return { done: true, status: this.status, error: this.error };
    }
    if (this.status !== "running") {
      return { done: true, status: this.status, error: this.error };
    }
    if (!this.stepDeferred) {
      this.stepDeferred = createDeferred();
    }
    const step = await this.stepDeferred.promise;
    if (step) {
      return { done: false, step, status: this.status };
    }
    return { done: true, status: this.status, error: this.error };
  }

  async answer(stepId: string, value: unknown): Promise<void> {
    const deferred = this.answerDeferred.get(stepId);
    if (!deferred) {
      throw new Error("wizard: no pending step");
    }
    this.answerDeferred.delete(stepId);
    this.currentStep = null;
    deferred.resolve(value);
  }

  cancel() {
    if (this.status !== "running") {
      return;
    }
    this.status = "cancelled";
    this.error = "cancelled";
    this.currentStep = null;
    for (const [, deferred] of this.answerDeferred) {
      deferred.reject(new WizardCancelledError());
    }
    this.answerDeferred.clear();
    this.resolveStep(null);
  }

  pushStep(step: WizardStep) {
    this.currentStep = step;
    this.resolveStep(step);
  }

  private async run(prompter: WizardPrompter) {
    try {
      await this.runner(prompter);
      this.status = "done";
    } catch (err) {
      if (err instanceof WizardCancelledError) {
        this.status = "cancelled";
        this.error = err.message;
      } else {
        this.status = "error";
        this.error = String(err);
      }
    } finally {
      this.resolveStep(null);
    }
  }

  async awaitAnswer(step: WizardStep): Promise<unknown> {
    if (this.status !== "running") {
      throw new Error("wizard: session not running");
    }
    this.pushStep(step);
    const deferred = createDeferred<unknown>();
    this.answerDeferred.set(step.id, deferred);
    return await deferred.promise;
  }

  private resolveStep(step: WizardStep | null) {
    if (!this.stepDeferred) {
      if (step === null) {
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
