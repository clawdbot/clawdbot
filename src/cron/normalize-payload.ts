import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { isRecord } from "../utils.js";
import {
  TimeoutSecondsFieldSchema,
  TrimmedNonEmptyStringFieldSchema,
  parseOptionalField,
} from "./delivery-field-schemas.js";

type UnknownRecord = Record<string, unknown>;

function normalizeTrimmedStringArray(
  value: unknown,
  options?: { allowNull?: boolean },
): string[] | null | undefined {
  if (Array.isArray(value)) {
    const normalized = normalizeTrimmedStringList(value);
    if (normalized.length === 0 && value.length > 0) {
      return undefined;
    }
    return normalized;
  }
  if (options?.allowNull && value === null) {
    return null;
  }
  return undefined;
}

function normalizeCommandEnv(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    throw new Error("command env must be an object with non-blank keys and string values");
  }
  const entries: Array<[string, string]> = [];
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = normalizeOptionalString(rawKey);
    if (!key || typeof rawValue !== "string") {
      throw new Error("command env must be an object with non-blank keys and string values");
    }
    entries.push([key, rawValue]);
  }
  return Object.fromEntries(entries);
}

export function normalizeCronCommandArgv(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  if (value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    return undefined;
  }
  return [...value];
}

function hasAgentTurnOnlyPayloadHint(payload: UnknownRecord): boolean {
  return (
    "model" in payload ||
    "fallbacks" in payload ||
    "thinking" in payload ||
    "timeoutSeconds" in payload ||
    typeof payload.lightContext === "boolean" ||
    typeof payload.allowUnsafeExternalContent === "boolean"
  );
}

export function normalizeCronPayload(payload: UnknownRecord): UnknownRecord {
  const next: UnknownRecord = { ...payload };
  const kindRaw = normalizeLowercaseStringOrEmpty(next.kind);
  if (kindRaw === "agentturn") {
    next.kind = "agentTurn";
  } else if (kindRaw === "systemevent") {
    next.kind = "systemEvent";
  } else if (kindRaw === "command") {
    next.kind = "command";
  } else if (kindRaw === "script") {
    next.kind = "script";
  } else if (kindRaw) {
    next.kind = kindRaw;
  }
  if (typeof next.message === "string") {
    const trimmed = normalizeOptionalString(next.message) ?? "";
    if (trimmed) {
      next.message = trimmed;
    } else {
      next.message = "";
    }
  }
  if (typeof next.text === "string") {
    const trimmed = normalizeOptionalString(next.text) ?? "";
    if (trimmed) {
      next.text = trimmed;
    } else {
      next.text = "";
    }
  }
  if (typeof next.script === "string") {
    next.script = next.script.trim();
  }
  if ("model" in next) {
    if (next.model === null) {
      next.model = null;
    } else {
      const model = parseOptionalField(TrimmedNonEmptyStringFieldSchema, next.model);
      if (model !== undefined) {
        next.model = model;
      } else {
        delete next.model;
      }
    }
  }
  if ("thinking" in next) {
    // Preserve an explicit null so patches can clear a stored thinking override,
    // matching the model/fallbacks/toolsAllow clear paths.
    if (next.thinking === null) {
      next.thinking = null;
    } else {
      const thinking = parseOptionalField(TrimmedNonEmptyStringFieldSchema, next.thinking);
      if (thinking !== undefined) {
        next.thinking = thinking;
      } else {
        delete next.thinking;
      }
    }
  }
  if ("timeoutSeconds" in next) {
    const timeoutSeconds = parseOptionalField(TimeoutSecondsFieldSchema, next.timeoutSeconds);
    if (timeoutSeconds !== undefined) {
      next.timeoutSeconds = timeoutSeconds;
    } else {
      delete next.timeoutSeconds;
    }
  }
  if ("fallbacks" in next) {
    const fallbacks = normalizeTrimmedStringArray(next.fallbacks, { allowNull: true });
    if (fallbacks !== undefined) {
      next.fallbacks = fallbacks;
    } else {
      delete next.fallbacks;
    }
  }
  if ("toolsAllow" in next) {
    const toolsAllow = normalizeTrimmedStringArray(next.toolsAllow, { allowNull: true });
    if (toolsAllow !== undefined) {
      next.toolsAllow = toolsAllow;
    } else {
      delete next.toolsAllow;
    }
  }
  if ("argv" in next) {
    const argv = normalizeCronCommandArgv(next.argv);
    if (Array.isArray(argv) && argv.length > 0) {
      next.argv = argv;
    } else {
      delete next.argv;
    }
  }
  if ("cwd" in next) {
    const cwd = parseOptionalField(TrimmedNonEmptyStringFieldSchema, next.cwd);
    if (cwd !== undefined) {
      next.cwd = cwd;
    } else {
      delete next.cwd;
    }
  }
  if ("env" in next) {
    next.env = normalizeCommandEnv(next.env);
  }
  if ("input" in next && typeof next.input !== "string") {
    delete next.input;
  }
  if ("noOutputTimeoutSeconds" in next) {
    const noOutputTimeoutSeconds = parseOptionalField(
      TimeoutSecondsFieldSchema,
      next.noOutputTimeoutSeconds,
    );
    if (noOutputTimeoutSeconds !== undefined) {
      next.noOutputTimeoutSeconds = noOutputTimeoutSeconds;
    } else {
      delete next.noOutputTimeoutSeconds;
    }
  }
  if ("outputMaxBytes" in next) {
    const outputMaxBytes = parseOptionalField(TimeoutSecondsFieldSchema, next.outputMaxBytes);
    if (outputMaxBytes !== undefined && outputMaxBytes > 0) {
      next.outputMaxBytes = Math.floor(outputMaxBytes);
    } else {
      delete next.outputMaxBytes;
    }
  }
  if ("toolBudget" in next) {
    const toolBudget = parseOptionalField(TimeoutSecondsFieldSchema, next.toolBudget);
    if (toolBudget !== undefined && toolBudget > 0) {
      next.toolBudget = Math.floor(toolBudget);
    } else {
      delete next.toolBudget;
    }
  }
  if (
    "allowUnsafeExternalContent" in next &&
    typeof next.allowUnsafeExternalContent !== "boolean"
  ) {
    delete next.allowUnsafeExternalContent;
  }
  if (!("kind" in next) && typeof next.text === "string" && hasAgentTurnOnlyPayloadHint(next)) {
    next.kind = "agentTurn";
    next.message = next.text;
  }
  if (next.kind === "systemEvent") {
    delete next.message;
    delete next.model;
    delete next.fallbacks;
    delete next.thinking;
    delete next.timeoutSeconds;
    delete next.lightContext;
    delete next.allowUnsafeExternalContent;
    delete next.argv;
    delete next.cwd;
    delete next.env;
    delete next.input;
    delete next.noOutputTimeoutSeconds;
    delete next.outputMaxBytes;
    delete next.script;
    delete next.toolBudget;
  } else if (next.kind === "agentTurn") {
    delete next.text;
    delete next.argv;
    delete next.cwd;
    delete next.env;
    delete next.input;
    delete next.noOutputTimeoutSeconds;
    delete next.outputMaxBytes;
    delete next.script;
    delete next.toolBudget;
  } else if (next.kind === "command") {
    delete next.text;
    delete next.message;
    delete next.model;
    delete next.fallbacks;
    delete next.thinking;
    delete next.lightContext;
    delete next.allowUnsafeExternalContent;
    delete next.script;
    delete next.toolBudget;
  } else if (next.kind === "script") {
    delete next.text;
    delete next.message;
    delete next.model;
    delete next.fallbacks;
    delete next.thinking;
    delete next.lightContext;
    delete next.allowUnsafeExternalContent;
    delete next.argv;
    delete next.cwd;
    delete next.env;
    delete next.input;
    delete next.noOutputTimeoutSeconds;
    delete next.outputMaxBytes;
  }
  return next;
}
