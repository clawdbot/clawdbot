import type { AttemptFailureSource } from "./attempt-terminal.js";
import { readCodexProviderRefusal, type CodexProviderRefusal } from "./event-projector-values.js";
import type { JsonValue } from "./protocol.js";
import { resolveCodexPromptError } from "./usage-limit-error.js";

export class CodexTerminalFailureProjection {
  promptError: unknown;
  promptErrorSource: AttemptFailureSource | null = null;
  providerRefusal: CodexProviderRefusal | undefined;

  record(params: {
    message: string | undefined;
    codexErrorInfo: JsonValue | null | undefined;
    rateLimits: JsonValue | undefined;
    fallbackMessage: string;
    promptErrorSource: AttemptFailureSource;
  }): void {
    this.providerRefusal ??= readCodexProviderRefusal(params.message, params.codexErrorInfo);
    if (this.providerRefusal) {
      return;
    }
    this.promptError =
      resolveCodexPromptError({
        message: params.message,
        codexErrorInfo: params.codexErrorInfo,
        rateLimits: params.rateLimits,
      }) ?? params.fallbackMessage;
    this.promptErrorSource = params.promptErrorSource;
  }
}
