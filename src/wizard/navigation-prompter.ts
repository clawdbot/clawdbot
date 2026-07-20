// Prompt navigation wrapper for interactive setup history.
import type {
  WizardMultiSelectParams,
  WizardProgress,
  WizardPrompter,
  WizardSelectParams,
} from "./prompts.js";
import { WizardNavigationError } from "./prompts.js";

type PromptKind = "select" | "multiselect" | "text" | "confirm";
type WizardTextParams = Parameters<WizardPrompter["text"]>[0];
type WizardConfirmParams = Parameters<WizardPrompter["confirm"]>[0];

type PromptRecord = {
  kind: PromptKind;
  signature: string;
  answer: unknown;
  answerKey: string;
};

type PromptRequest<T, Params> = {
  kind: PromptKind;
  params: Params;
  signature: string;
  cacheAnswer: boolean;
  withInitial: (params: Params, answer: unknown) => Params;
  call: (params: Params) => Promise<T>;
};

const basePrompterByNavigationPrompter = new WeakMap<WizardPrompter, WizardPrompter>();

function unwrapNavigationPrompter(prompter: WizardPrompter): WizardPrompter {
  let current = prompter;
  let base = basePrompterByNavigationPrompter.get(current);
  while (base) {
    current = base;
    base = basePrompterByNavigationPrompter.get(current);
  }
  return current;
}

function inertProgress(): WizardProgress {
  return {
    update: () => {},
    stop: () => {},
  };
}

function stableKey(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function optionSignature(options: Array<{ value: unknown; label: string }>): string {
  return stableKey(options.map((option) => [stableKey(option.value), option.label]));
}

function buildPromptSignature(
  kind: PromptKind,
  params: { message: string; options?: Array<{ value: unknown; label: string }>; layout?: string },
): string {
  return stableKey({
    kind,
    message: params.message,
    options: params.options ? optionSignature(params.options) : undefined,
    layout: params.layout,
  });
}

function applyNavigation<Params extends { navigation?: unknown }>(
  params: Params,
  navigation: { canGoBack: boolean; canGoForward: boolean },
): Params {
  return {
    ...params,
    navigation,
  };
}

class WizardPromptNavigator {
  private cursor = 0;
  private targetIndex: number | undefined;
  private restartRequested = false;
  private boundaryBackRequested = false;
  private backNavigationDisabled = false;
  private records: Array<PromptRecord | undefined> = [];

  constructor(
    private readonly base: WizardPrompter,
    private readonly options: { allowBackFromStart?: boolean } = {},
  ) {
    basePrompterByNavigationPrompter.set(this.prompter, unwrapNavigationPrompter(base));
  }

  readonly prompter: WizardPrompter = {
    intro: async (title) => {
      if (!this.shouldSuppressOutput()) {
        await this.base.intro(title);
      }
    },
    outro: async (message) => {
      if (!this.shouldSuppressOutput()) {
        await this.base.outro(message);
      }
    },
    note: async (message, title) => {
      if (!this.shouldSuppressOutput()) {
        await this.base.note(message, title);
      }
    },
    ...(this.base.deviceCode
      ? {
          deviceCode: async (params) => {
            if (!this.shouldSuppressOutput()) {
              await this.base.deviceCode?.(params);
            }
          },
        }
      : {}),
    plain: async (message) => {
      if (!this.shouldSuppressOutput()) {
        await this.base.plain?.(message);
      }
    },
    select: async <T>(params: WizardSelectParams<T>) =>
      await this.prompt<T, WizardSelectParams<T>>({
        kind: "select",
        params,
        signature: buildPromptSignature("select", params),
        cacheAnswer: true,
        withInitial: (nextParams, answer) => ({
          ...nextParams,
          initialValue: answer as T,
        }),
        call: (nextParams) => this.base.select(nextParams),
      }),
    multiselect: async <T>(params: WizardMultiSelectParams<T>) =>
      await this.prompt<T[], WizardMultiSelectParams<T>>({
        kind: "multiselect",
        params,
        signature: buildPromptSignature("multiselect", params),
        cacheAnswer: true,
        withInitial: (nextParams, answer) => ({
          ...nextParams,
          initialValues: Array.isArray(answer) ? (answer as T[]) : nextParams.initialValues,
        }),
        call: (nextParams) => this.base.multiselect(nextParams),
      }),
    text: async (params) =>
      await this.prompt<string, WizardTextParams>({
        kind: "text",
        params,
        signature: buildPromptSignature("text", params),
        cacheAnswer: params.sensitive !== true,
        withInitial: (nextParams, answer) => ({
          ...nextParams,
          initialValue: typeof answer === "string" ? answer : nextParams.initialValue,
        }),
        call: (nextParams) => this.base.text(nextParams),
      }),
    confirm: async (params) =>
      await this.prompt<boolean, WizardConfirmParams>({
        kind: "confirm",
        params,
        signature: buildPromptSignature("confirm", params),
        cacheAnswer: true,
        withInitial: (nextParams, answer) => ({
          ...nextParams,
          initialValue: typeof answer === "boolean" ? answer : nextParams.initialValue,
        }),
        call: (nextParams) => this.base.confirm(nextParams),
      }),
    progress: (label) =>
      this.shouldSuppressOutput() ? inertProgress() : this.base.progress(label),
    ...(this.base.openUrl
      ? {
          openUrl: async (url) => {
            if (!this.shouldSuppressOutput()) {
              await this.base.openUrl?.(url);
            }
          },
        }
      : {}),
    disableBackNavigation: () => {
      this.backNavigationDisabled = true;
      this.targetIndex = undefined;
    },
  };

  beginPass() {
    this.cursor = 0;
    this.restartRequested = false;
    this.boundaryBackRequested = false;
  }

  hasRestartRequest(): boolean {
    return this.restartRequested;
  }

  hasBoundaryBackRequest(): boolean {
    return this.boundaryBackRequested;
  }

  private shouldSuppressOutput(): boolean {
    return this.targetIndex !== undefined && this.cursor <= this.targetIndex;
  }

  private matchingRecord(index: number, kind: PromptKind, signature: string) {
    const record = this.records[index];
    if (!record) {
      return undefined;
    }
    if (record.kind === kind && record.signature === signature) {
      return record;
    }
    this.records.splice(index);
    if (this.targetIndex !== undefined && index < this.targetIndex) {
      this.targetIndex = undefined;
    }
    return undefined;
  }

  private remember(index: number, request: PromptRequest<unknown, unknown>, answer: unknown) {
    if (!request.cacheAnswer) {
      this.records[index] = undefined;
      this.records.splice(index + 1);
      return;
    }

    const answerKey = stableKey(answer);
    const previous = this.records[index];
    this.records[index] = {
      kind: request.kind,
      signature: request.signature,
      answer,
      answerKey,
    };
    if (!previous || previous.answerKey !== answerKey || previous.signature !== request.signature) {
      this.records.splice(index + 1);
    }
  }

  private async prompt<T, Params extends { navigation?: unknown }>(
    request: PromptRequest<T, Params>,
  ): Promise<T> {
    const index = this.cursor;
    const record = this.matchingRecord(index, request.kind, request.signature);

    if (this.targetIndex !== undefined && index < this.targetIndex && record) {
      this.cursor = index + 1;
      return record.answer as T;
    }

    const paramsWithInitial = record
      ? request.withInitial(request.params, record.answer)
      : request.params;
    const paramsWithNavigation = applyNavigation(paramsWithInitial, {
      canGoBack:
        !this.backNavigationDisabled && (index > 0 || this.options.allowBackFromStart === true),
      canGoForward: record !== undefined,
    });

    try {
      const answer = await request.call(paramsWithNavigation);
      this.remember(index, request as PromptRequest<unknown, unknown>, answer);
      this.cursor = index + 1;
      if (this.targetIndex !== undefined && index >= this.targetIndex) {
        this.targetIndex = undefined;
      }
      return answer;
    } catch (error) {
      if (error instanceof WizardNavigationError) {
        if (error.direction === "forward" && record) {
          this.cursor = index + 1;
          this.targetIndex = undefined;
          return record.answer as T;
        }
        if (
          error.direction === "back" &&
          !this.backNavigationDisabled &&
          index === 0 &&
          this.options.allowBackFromStart === true
        ) {
          this.boundaryBackRequested = true;
        }
        if (error.direction === "back" && !this.backNavigationDisabled && index > 0) {
          this.targetIndex = index - 1;
          this.restartRequested = true;
        }
      }
      throw error;
    }
  }
}

type WizardPromptNavigationScopeOutcome<T> = { status: "completed"; value: T } | { status: "back" };

export async function runWizardWithPromptNavigationScope<T>(
  basePrompter: WizardPrompter,
  runner: (prompter: WizardPrompter) => Promise<T>,
): Promise<WizardPromptNavigationScopeOutcome<T>> {
  const navigator = new WizardPromptNavigator(unwrapNavigationPrompter(basePrompter), {
    allowBackFromStart: true,
  });

  while (true) {
    navigator.beginPass();
    try {
      return { status: "completed", value: await runner(navigator.prompter) };
    } catch (error) {
      if (error instanceof WizardNavigationError && error.direction === "back") {
        if (navigator.hasRestartRequest()) {
          continue;
        }
        if (navigator.hasBoundaryBackRequest()) {
          return { status: "back" };
        }
      }
      throw error;
    }
  }
}

export async function runWizardWithPromptNavigation(
  basePrompter: WizardPrompter,
  runner: (prompter: WizardPrompter) => Promise<void>,
): Promise<void> {
  const navigator = new WizardPromptNavigator(basePrompter);

  while (true) {
    navigator.beginPass();
    try {
      await runner(navigator.prompter);
      return;
    } catch (error) {
      if (
        error instanceof WizardNavigationError &&
        error.direction === "back" &&
        navigator.hasRestartRequest()
      ) {
        continue;
      }
      throw error;
    }
  }
}
