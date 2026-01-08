import type { TypingMode } from "../../config/types.js";
import type { TypingController } from "./typing.js";

export type TypingModeContext = {
  configured?: TypingMode;
  isGroupChat: boolean;
  wasMentioned: boolean;
  isHeartbeat: boolean;
};

export const DEFAULT_GROUP_TYPING_MODE: TypingMode = "message";

export function resolveTypingMode({
  configured,
  isGroupChat,
  wasMentioned,
  isHeartbeat,
}: TypingModeContext): TypingMode {
  if (isHeartbeat) return "never";
  if (configured) return configured;
  if (!isGroupChat || wasMentioned) return "instant";
  return DEFAULT_GROUP_TYPING_MODE;
}

export type TypingSignaler = {
  mode: TypingMode;
  shouldStartImmediately: boolean;
  shouldStartOnText: boolean;
  shouldStartOnReasoning: boolean;
  signalRunStart: () => Promise<void>;
  signalTextDelta: (text?: string) => Promise<void>;
  signalReasoningDelta: () => Promise<void>;
  signalToolStart: () => Promise<void>;
};

export function createTypingSignaler(params: {
  typing: TypingController;
  mode: TypingMode;
  isHeartbeat: boolean;
}): TypingSignaler {
  const { typing, mode, isHeartbeat } = params;
  const shouldStartImmediately = mode === "instant";
  const shouldStartOnText = mode === "message" || mode === "instant";
  const shouldStartOnReasoning = mode === "thinking";
  const disabled = isHeartbeat || mode === "never";

  const signalRunStart = async () => {
    if (disabled || !shouldStartImmediately) return;
    await typing.startTypingLoop();
  };

  const signalTextDelta = async (text?: string) => {
    if (disabled) return;
    if (shouldStartOnText) {
      await typing.startTypingOnText(text);
      return;
    }
    if (shouldStartOnReasoning) {
      typing.refreshTypingTtl();
    }
  };

  const signalReasoningDelta = async () => {
    if (disabled || !shouldStartOnReasoning) return;
    await typing.startTypingLoop();
    typing.refreshTypingTtl();
  };

  const signalToolStart = async () => {
    if (disabled) return;
    if (!typing.isActive()) return;
    // Keep typing indicator alive during tool execution without changing mode semantics.
    typing.refreshTypingTtl();
  };

  return {
    mode,
    shouldStartImmediately,
    shouldStartOnText,
    shouldStartOnReasoning,
    signalRunStart,
    signalTextDelta,
    signalReasoningDelta,
    signalToolStart,
  };
}
