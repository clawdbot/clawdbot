// Handles TUI input submission and command dispatch.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type {
  TuiChatSubmitAdmission,
  TuiChatSubmitBlock,
  TuiChatSubmitSnapshot,
} from "./tui-submit-state.js";

export type TuiSubmitAction = "local shell" | "command" | "message";

function isExecutableBangLine(text: string): boolean {
  return !text.includes("\n") && text.startsWith("!") && text !== "!";
}

export function trimWouldCreateExecutableBangLine(text: string): boolean {
  return !isExecutableBangLine(text) && isExecutableBangLine(text.trim());
}

function runSubmitAction(
  action: TuiSubmitAction,
  run: () => Promise<void> | void,
  onError: (action: TuiSubmitAction, error: unknown) => void,
): void {
  try {
    void Promise.resolve(run()).catch((error: unknown) => {
      onError(action, error);
    });
  } catch (error) {
    onError(action, error);
  }
}

export function createEditorSubmitHandler(params: {
  editor: {
    getText?: () => string;
    setText: (value: string) => void;
    addToHistory: (value: string) => void;
  };
  handleCommand: (value: string) => Promise<void> | void;
  sendMessage: (value: string) => Promise<void> | void;
  handleBangLine: (value: string) => Promise<void> | void;
  onSubmitError: (action: TuiSubmitAction, error: unknown) => void;
  admitMessage?: (value: string, snapshot?: TuiChatSubmitSnapshot) => TuiChatSubmitAdmission;
  onBlockedMessageSubmit?: (value: string, admission: TuiChatSubmitBlock) => void;
}) {
  const clearSubmittedEditor = () => {
    // pi-tui clears before onSubmit; a delayed paste flush must not erase a newer draft.
    if (!params.editor.getText?.()) {
      params.editor.setText("");
    }
  };

  const restoreBlockedEditor = (value: string) => {
    // pi-tui clears before onSubmit. Preserve text typed while a buffered submit
    // waited by replaying the blocked value before the newer editor-owned draft.
    const newerDraft = params.editor.getText?.() ?? "";
    params.editor.setText(newerDraft ? `${value}\n${newerDraft}` : value);
  };

  return (text: string, snapshot?: TuiChatSubmitSnapshot) => {
    const raw = text;
    const value = raw.trim();
    const multiline = raw.includes("\n");
    const trimCreatesExecutableBangLine = trimWouldCreateExecutableBangLine(raw);

    // Keep previous behavior: ignore empty/whitespace-only submissions.
    if (!value) {
      clearSubmittedEditor();
      return;
    }

    // Bash mode: only if the very first character is '!' and it's not just '!'.
    // IMPORTANT: use the raw (untrimmed) text so leading spaces do NOT trigger.
    // Per requirement: a lone '!' should be treated as a normal message.
    if (isExecutableBangLine(raw)) {
      clearSubmittedEditor();
      params.editor.addToHistory(raw);
      runSubmitAction("local shell", () => params.handleBangLine(raw), params.onSubmitError);
      return;
    }

    if (!multiline && value.startsWith("/")) {
      clearSubmittedEditor();
      // Enable built-in editor prompt history navigation (up/down).
      params.editor.addToHistory(value);
      runSubmitAction("command", () => params.handleCommand(value), params.onSubmitError);
      return;
    }

    const admission: TuiChatSubmitAdmission = (snapshot
      ? params.admitMessage?.(value, snapshot)
      : params.admitMessage?.(value)) ?? { status: "allowed" };
    if (admission.status === "blocked") {
      restoreBlockedEditor(trimCreatesExecutableBangLine ? raw : value);
      params.onBlockedMessageSubmit?.(value, admission);
      return;
    }

    clearSubmittedEditor();
    // Omit chat text whose trimmed history recall would become executable shell input.
    if (!trimCreatesExecutableBangLine) {
      params.editor.addToHistory(value);
    }
    runSubmitAction("message", () => params.sendMessage(value), params.onSubmitError);
  };
}

export function shouldEnableWindowsGitBashPasteFallback(params?: {
  platform?: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const platform = params?.platform ?? process.platform;
  const env = params?.env ?? process.env;
  const termProgram = normalizeLowercaseStringOrEmpty(env.TERM_PROGRAM);

  // Some macOS terminals emit multiline paste as rapid single-line submits.
  // Enable burst coalescing so pasted blocks stay as one user message.
  if (platform === "darwin") {
    if (termProgram.includes("iterm") || termProgram.includes("apple_terminal")) {
      return true;
    }
    return false;
  }

  if (platform !== "win32") {
    return false;
  }

  const msystem = (env.MSYSTEM ?? "").toUpperCase();
  const shell = env.SHELL ?? "";
  if (msystem.startsWith("MINGW") || msystem.startsWith("MSYS")) {
    return true;
  }
  if (normalizeLowercaseStringOrEmpty(shell).includes("bash")) {
    return true;
  }
  return termProgram.includes("mintty");
}

export function createSubmitBurstCoalescer(params: {
  submit: (value: string, snapshot?: TuiChatSubmitSnapshot) => void;
  captureSnapshot?: () => TuiChatSubmitSnapshot;
  enabled: boolean;
  burstWindowMs?: number;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  onCapture?: (value: string, snapshot?: TuiChatSubmitSnapshot) => void;
}) {
  const windowMs = Math.max(1, params.burstWindowMs ?? 50);
  const now = params.now ?? (() => Date.now());
  const setTimer = params.setTimer ?? setTimeout;
  const clearTimer = params.clearTimer ?? clearTimeout;
  let pending: { value: string; snapshot?: TuiChatSubmitSnapshot } | null = null;
  let pendingAt = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearFlushTimer = () => {
    if (!flushTimer) {
      return;
    }
    clearTimer(flushTimer);
    flushTimer = null;
  };

  const submit = (value: string, snapshot?: TuiChatSubmitSnapshot) => {
    if (snapshot) {
      params.submit(value, snapshot);
    } else {
      params.submit(value);
    }
  };

  const flushPending = () => {
    if (disposed || !pending) {
      return;
    }
    const { value, snapshot } = pending;
    pending = null;
    pendingAt = 0;
    clearFlushTimer();
    submit(value, snapshot);
  };

  const scheduleFlush = () => {
    clearFlushTimer();
    flushTimer = setTimer(() => {
      flushPending();
    }, windowMs);
  };

  const submitBurst = (value: string) => {
    if (disposed) {
      return;
    }
    if (!params.enabled) {
      submit(value, params.captureSnapshot?.());
      return;
    }
    if (value.includes("\n")) {
      flushPending();
      submit(value, params.captureSnapshot?.());
      return;
    }
    const ts = now();
    const snapshot = params.captureSnapshot?.();
    params.onCapture?.(value, snapshot);
    if (!pending) {
      pending = { value, ...(snapshot ? { snapshot } : {}) };
      pendingAt = ts;
      scheduleFlush();
      return;
    }
    if (ts - pendingAt <= windowMs) {
      pending = {
        value: `${pending.value}\n${value}`,
        ...(pending.snapshot || snapshot ? { snapshot: pending.snapshot ?? snapshot } : {}),
      };
      pendingAt = ts;
      scheduleFlush();
      return;
    }
    flushPending();
    pending = { value, ...(snapshot ? { snapshot } : {}) };
    pendingAt = ts;
    scheduleFlush();
  };

  const dispose = () => {
    disposed = true;
    pending = null;
    clearFlushTimer();
  };

  return Object.assign(submitBurst, { dispose });
}
