import { randomUUID } from "node:crypto";
import { toAcpRuntimeErrorText } from "../../../acp/runtime/error-text.js";
import type { AcpRuntimeError } from "../../../acp/runtime/errors.js";
import type { AcpRuntimeSessionMode } from "../../../acp/runtime/types.js";
import { supportsAutomaticThreadBindingSpawn } from "../../../channels/thread-bindings-policy.js";
import type { AcpSessionRuntimeOptions } from "../../../config/sessions/types.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../../shared/string-coerce.js";
import type { CommandHandlerResult, HandleCommandsParams } from "../commands-types.js";
import { resolveAcpCommandChannel, resolveAcpCommandThreadId } from "./context.js";

export const COMMAND = "/acp";
const ACP_SPAWN_USAGE =
  "Usage: /acp spawn [harness-id] [--mode persistent|oneshot] [--thread auto|here|off] [--bind here|off] [--cwd <path>] [--label <label>].";
const ACP_STEER_USAGE =
  "Usage: /acp steer [--session <session-key|session-id|session-label>] <instruction>";
export const ACP_SET_MODE_USAGE =
  "Usage: /acp set-mode <mode> [session-key|session-id|session-label]";
const ACP_SET_USAGE = "Usage: /acp set <key> <value> [session-key|session-id|session-label]";
export const ACP_CWD_USAGE = "Usage: /acp cwd <path> [session-key|session-id|session-label]";
export const ACP_PERMISSIONS_USAGE =
  "Usage: /acp permissions <profile> [session-key|session-id|session-label]";
export const ACP_TIMEOUT_USAGE =
  "Usage: /acp timeout <seconds> [session-key|session-id|session-label]";
export const ACP_MODEL_USAGE =
  "Usage: /acp model <model-id> [session-key|session-id|session-label]";
export const ACP_RESET_OPTIONS_USAGE =
  "Usage: /acp reset-options [session-key|session-id|session-label]";
export const ACP_STATUS_USAGE = "Usage: /acp status [session-key|session-id|session-label]";
export const ACP_INSTALL_USAGE = "Usage: /acp install";
export const ACP_DOCTOR_USAGE = "Usage: /acp doctor";
export const ACP_SESSIONS_USAGE = "Usage: /acp sessions";
export const ACP_STEER_OUTPUT_LIMIT = 800;
export { SESSION_ID_RE } from "../../../sessions/session-id.js";

export type AcpAction =
  | "spawn"
  | "cancel"
  | "steer"
  | "close"
  | "sessions"
  | "status"
  | "set-mode"
  | "set"
  | "cwd"
  | "permissions"
  | "timeout"
  | "model"
  | "reset-options"
  | "doctor"
  | "install"
  | "help";

export type AcpSpawnThreadMode = "auto" | "here" | "off";
export type AcpSpawnBindMode = "here" | "off";

export type ParsedSpawnInput = {
  agentId: string;
  mode: AcpRuntimeSessionMode;
  thread: AcpSpawnThreadMode;
  bind: AcpSpawnBindMode;
  cwd?: string;
  label?: string;
};

export type ParsedSteerInput = {
  sessionToken?: string;
  instruction: string;
};

export type ParsedSingleValueCommandInput = {
  value: string;
  sessionToken?: string;
};

export type ParsedSetCommandInput = {
  key: string;
  value: string;
  sessionToken?: string;
};

const ACP_UNICODE_DASH_PREFIX_RE =
  /^[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D]+/;

export function stopWithText(text: string): CommandHandlerResult {
  return {
    shouldContinue: false,
    reply: { text },
  };
}

export function resolveAcpAction(tokens: string[]): AcpAction {
  const action = normalizeOptionalLowercaseString(tokens[0]);
  if (
    action === "spawn" ||
    action === "cancel" ||
    action === "steer" ||
    action === "close" ||
    action === "sessions" ||
    action === "status" ||
    action === "set-mode" ||
    action === "set" ||
    action === "cwd" ||
    action === "permissions" ||
    action === "timeout" ||
    action === "model" ||
    action === "reset-options" ||
    action === "doctor" ||
    action === "install" ||
    action === "help"
  ) {
    tokens.shift();
    return action;
  }
  return "help";
}

function readOptionValue(params: { tokens: string[]; index: number; flag: string }):
  | {
      matched: true;
      value?: string;
      nextIndex: number;
      error?: string;
    }
  | { matched: false } {
  const token = normalizeAcpOptionToken(params.tokens[params.index] ?? "");
  if (token === params.flag) {
    const nextValue = normalizeAcpOptionToken(params.tokens[params.index + 1] ?? "");
    if (!nextValue || nextValue.startsWith("--")) {
      return {
        matched: true,
        nextIndex: params.index + 1,
        error: `${params.flag} requires a value`,
      };
    }
    return {
      matched: true,
      value: nextValue,
      nextIndex: params.index + 2,
    };
  }
  if (token.startsWith(`${params.flag}=`)) {
    const value = token.slice(`${params.flag}=`.length).trim();
    if (!value) {
      return {
        matched: true,
        nextIndex: params.index + 1,
        error: `${params.flag} requires a value`,
      };
    }
    return {
      matched: true,
      value,
      nextIndex: params.index + 1,
    };
  }
  return { matched: false };
}

function normalizeAcpOptionToken(raw: string): string {
  const token = raw.trim();
  if (!token || token.startsWith("--")) {
    return token;
  }
  const dashPrefix = token.match(ACP_UNICODE_DASH_PREFIX_RE)?.[0];
  if (!dashPrefix) {
    return token;
  }
  return `--${token.slice(dashPrefix.length)}`;
}

function resolveDefaultSpawnThreadMode(params: HandleCommandsParams): AcpSpawnThreadMode {
  const channel = resolveAcpCommandChannel(params);
  if (!supportsAutomaticThreadBindingSpawn(channel)) {
    return "off";
  }
  const currentThreadId = resolveAcpCommandThreadId(params);
  return currentThreadId ? "here" : "auto";
}

export function parseSpawnInput(
  params: HandleCommandsParams,
  tokens: string[],
): { ok: true; value: ParsedSpawnInput } | { ok: false; error: string } {
  const normalizedTokens = tokens.map((token) => normalizeAcpOptionToken(token));
  let mode: AcpRuntimeSessionMode = "persistent";
  let thread = resolveDefaultSpawnThreadMode(params);
  let sawThreadOption = false;
  let bind: AcpSpawnBindMode = "off";
  let cwd: string | undefined;
  let label: string | undefined;
  let rawAgentId: string | undefined;

  for (let i = 0; i < normalizedTokens.length; ) {
    const token = normalizedTokens[i] ?? "";

    const modeOption = readOptionValue({ tokens: normalizedTokens, index: i, flag: "--mode" });
    if (modeOption.matched) {
      if (modeOption.error) {
        return { ok: false, error: `${modeOption.error}. ${ACP_SPAWN_USAGE}` };
      }
      const raw = normalizeOptionalLowercaseString(modeOption.value);
      if (raw !== "persistent" && raw !== "oneshot") {
        return {
          ok: false,
          error: `Invalid --mode value "${modeOption.value}". Use persistent or oneshot.`,
        };
      }
      mode = raw;
      i = modeOption.nextIndex;
      continue;
    }

    const bindOption = readOptionValue({ tokens: normalizedTokens, index: i, flag: "--bind" });
    if (bindOption.matched) {
      if (bindOption.error) {
        return { ok: false, error: `${bindOption.error}. ${ACP_SPAWN_USAGE}` };
      }
      const raw = normalizeOptionalLowercaseString(bindOption.value);
      if (raw !== "here" && raw !== "off") {
        return {
          ok: false,
          error: `Invalid --bind value "${bindOption.value}". Use here or off.`,
        };
      }
      bind = raw;
      i = bindOption.nextIndex;
      continue;
    }

    const threadOption = readOptionValue({
      tokens: normalizedTokens,
      index: i,
      flag: "--thread",
    });
    if (threadOption.matched) {
      if (threadOption.error) {
        return { ok: false, error: `${threadOption.error}. ${ACP_SPAWN_USAGE}` };
      }
      const raw = normalizeOptionalLowercaseString(threadOption.value);
      if (raw !== "auto" && raw !== "here" && raw !== "off") {
        return {
          ok: false,
          error: `Invalid --thread value "${threadOption.value}". Use auto, here, or off.`,
        };
      }
      thread = raw;
      sawThreadOption = true;
      i = threadOption.nextIndex;
      continue;
    }

    const cwdOption = readOptionValue({ tokens: normalizedTokens, index: i, flag: "--cwd" });
    if (cwdOption.matched) {
      if (cwdOption.error) {
        return { ok: false, error: `${cwdOption.error}. ${ACP_SPAWN_USAGE}` };
      }
      cwd = normalizeOptionalString(cwdOption.value);
      i = cwdOption.nextIndex;
      continue;
    }

    const labelOption = readOptionValue({ tokens: normalizedTokens, index: i, flag: "--label" });
    if (labelOption.matched) {
      if (labelOption.error) {
        return { ok: false, error: `${labelOption.error}. ${ACP_SPAWN_USAGE}` };
      }
      label = normalizeOptionalString(labelOption.value);
      i = labelOption.nextIndex;
      continue;
    }

    if (token.startsWith("--")) {
      return {
        ok: false,
        error: `Unknown option: ${token}. ${ACP_SPAWN_USAGE}`,
      };
    }

    if (!rawAgentId) {
      rawAgentId = normalizeOptionalString(token);
      i += 1;
      continue;
    }

    return {
      ok: false,
      error: `Unexpected argument: ${token}. ${ACP_SPAWN_USAGE}`,
    };
  }

  const fallbackAgent = normalizeOptionalString(params.cfg.acp?.defaultAgent) ?? "";
  const selectedAgent = normalizeOptionalString(rawAgentId) ?? fallbackAgent;
  if (!selectedAgent) {
    return {
      ok: false,
      error: `ACP target harness id is required. Pass an ACP harness id (for example codex) or configure acp.defaultAgent. ${ACP_SPAWN_USAGE}`,
    };
  }
  const normalizedAgentId = normalizeAgentId(selectedAgent);
  if (bind !== "off" && !sawThreadOption) {
    thread = "off";
  }
  if (thread !== "off" && bind !== "off") {
    return {
      ok: false,
      error: `Use either --thread or --bind for /acp spawn, not both. ${ACP_SPAWN_USAGE}`,
    };
  }

  return {
    ok: true,
    value: {
      agentId: normalizedAgentId,
      mode,
      thread,
      bind,
      cwd,
      label,
    },
  };
}

export function parseSteerInput(
  tokens: string[],
): { ok: true; value: ParsedSteerInput } | { ok: false; error: string } {
  const normalizedTokens = tokens.map((token) => normalizeAcpOptionToken(token));
  let sessionToken: string | undefined;
  const instructionTokens: string[] = [];

  for (let i = 0; i < normalizedTokens.length; ) {
    const sessionOption = readOptionValue({
      tokens: normalizedTokens,
      index: i,
      flag: "--session",
    });
    if (sessionOption.matched) {
      if (sessionOption.error) {
        return {
          ok: false,
          error: `${sessionOption.error}. ${ACP_STEER_USAGE}`,
        };
      }
      sessionToken = normalizeOptionalString(sessionOption.value);
      i = sessionOption.nextIndex;
      continue;
    }

    instructionTokens.push(tokens[i] ?? "");
    i += 1;
  }

  const instruction = instructionTokens.join(" ").trim();
  if (!instruction) {
    return {
      ok: false,
      error: ACP_STEER_USAGE,
    };
  }

  return {
    ok: true,
    value: {
      sessionToken,
      instruction,
    },
  };
}

export function parseSingleValueCommandInput(
  tokens: string[],
  usage: string,
): { ok: true; value: ParsedSingleValueCommandInput } | { ok: false; error: string } {
  const value = normalizeOptionalString(tokens[0]) ?? "";
  if (!value) {
    return { ok: false, error: usage };
  }
  if (tokens.length > 2) {
    return { ok: false, error: usage };
  }
  const sessionToken = normalizeOptionalString(tokens[1]);
  return {
    ok: true,
    value: {
      value,
      sessionToken,
    },
  };
}

export function parseSetCommandInput(
  tokens: string[],
): { ok: true; value: ParsedSetCommandInput } | { ok: false; error: string } {
  const key = normalizeOptionalString(tokens[0]) ?? "";
  const value = normalizeOptionalString(tokens[1]) ?? "";
  if (!key || !value) {
    return {
      ok: false,
      error: ACP_SET_USAGE,
    };
  }
  if (tokens.length > 3) {
    return {
      ok: false,
      error: ACP_SET_USAGE,
    };
  }
  const sessionToken = normalizeOptionalString(tokens[2]);
  return {
    ok: true,
    value: {
      key,
      value,
      sessionToken,
    },
  };
}

export function parseOptionalSingleTarget(
  tokens: string[],
  usage: string,
): { ok: true; sessionToken?: string } | { ok: false; error: string } {
  if (tokens.length > 1) {
    return { ok: false, error: usage };
  }
  const token = normalizeOptionalString(tokens[0]) ?? "";
  return {
    ok: true,
    ...(token ? { sessionToken: token } : {}),
  };
}

export function resolveAcpHelpText(): string {
  return [
    "ACP commands:",
    "-----",
    "/acp spawn [harness-id] [--mode persistent|oneshot] [--thread auto|here|off] [--bind here|off] [--cwd <path>] [--label <label>]",
    "/acp cancel [session-key|session-id|session-label]",
    "/acp steer [--session <session-key|session-id|session-label>] <instruction>",
    "/acp close [session-key|session-id|session-label]",
    "/acp status [session-key|session-id|session-label]",
    "/acp set-mode <mode> [session-key|session-id|session-label]",
    "/acp set <key> <value> [session-key|session-id|session-label]",
    "/acp cwd <path> [session-key|session-id|session-label]",
    "/acp permissions <profile> [session-key|session-id|session-label]",
    "/acp timeout <seconds> [session-key|session-id|session-label]",
    "/acp model <model-id> [session-key|session-id|session-label]",
    "/acp reset-options [session-key|session-id|session-label]",
    "/acp doctor",
    "/acp install",
    "/acp sessions",
    "",
    "Notes:",
    "- /acp spawn harness-id is an ACP runtime harness alias (for example codex), not an OpenClaw agents.list id.",
    "- Use --bind here to pin the current conversation to the ACP session without creating a child thread.",
    "- /focus and /unfocus also work with ACP session keys.",
    "- ACP dispatch of normal thread messages is controlled by acp.dispatch.enabled.",
  ].join("\n");
}

export function formatRuntimeOptionsText(options: AcpSessionRuntimeOptions): string {
  const extras = options.backendExtras
    ? Object.entries(options.backendExtras)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join(", ")
    : "";
  const parts = [
    options.runtimeMode ? `runtimeMode=${options.runtimeMode}` : null,
    options.model ? `model=${options.model}` : null,
    options.cwd ? `cwd=${options.cwd}` : null,
    options.permissionProfile ? `permissionProfile=${options.permissionProfile}` : null,
    typeof options.timeoutSeconds === "number" ? `timeoutSeconds=${options.timeoutSeconds}` : null,
    extras ? `extras={${extras}}` : null,
  ].filter(Boolean) as string[];
  if (parts.length === 0) {
    return "(none)";
  }
  return parts.join(", ");
}

export function formatAcpCapabilitiesText(controls: string[]): string {
  if (controls.length === 0) {
    return "(none)";
  }
  return controls.toSorted().join(", ");
}

export function resolveCommandRequestId(params: HandleCommandsParams): string {
  const value =
    params.ctx.MessageSidFull ??
    params.ctx.MessageSid ??
    params.ctx.MessageSidFirst ??
    params.ctx.MessageSidLast;
  if (typeof value === "string") {
    const normalizedValue = normalizeOptionalString(value);
    if (normalizedValue) {
      return normalizedValue;
    }
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return randomUUID();
}

export function collectAcpErrorText(params: {
  error: unknown;
  fallbackCode: AcpRuntimeError["code"];
  fallbackMessage: string;
}): string {
  return toAcpRuntimeErrorText({
    error: params.error,
    fallbackCode: params.fallbackCode,
    fallbackMessage: params.fallbackMessage,
  });
}

export async function withAcpCommandErrorBoundary<T>(params: {
  run: () => Promise<T>;
  fallbackCode: AcpRuntimeError["code"];
  fallbackMessage: string;
  onSuccess: (value: T) => CommandHandlerResult;
}): Promise<CommandHandlerResult> {
  try {
    const result = await params.run();
    return params.onSuccess(result);
  } catch (error) {
    return stopWithText(
      collectAcpErrorText({
        error,
        fallbackCode: params.fallbackCode,
        fallbackMessage: params.fallbackMessage,
      }),
    );
  }
}
