import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { CronJob } from "../../cron/types.js";
import { parseStrictPositiveInteger } from "../../infra/parse-finite-number.js";
import {
  parseCronCommandArgv,
  parseCronCommandEnv,
  parseCronFallbacks,
  parseCronToolsAllow,
} from "./shared.js";
import { parseCronThreadIdOption } from "./thread-id-shared.js";
import { readCronPayloadScript } from "./trigger-options.js";

const assignIf = (
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  shouldAssign: boolean,
) => {
  if (shouldAssign) {
    target[key] = value;
  }
};

export async function resolveCronEditPayloadDeliveryPatch(
  opts: Record<string, unknown>,
  loadExistingJob: () => Promise<CronJob>,
): Promise<Record<string, unknown>> {
  const patch: Record<string, unknown> = {};
  const hasSystemEventPatch = typeof opts.systemEvent === "string";
  const scriptPath = normalizeOptionalString(opts.script);
  const commandShell = normalizeOptionalString(opts.command);
  const commandArgv = parseCronCommandArgv(opts.commandArgv);
  if (commandShell && commandArgv) {
    throw new Error("Pass command payload either with --command or --command-argv, not both.");
  }
  const model = normalizeOptionalString(opts.model);
  if (model && opts.clearModel) {
    throw new Error("Use --model or --clear-model, not both");
  }
  const thinking = normalizeOptionalString(opts.thinking);
  if (thinking && opts.clearThinking) {
    throw new Error("Use --thinking or --clear-thinking, not both");
  }
  const fallbacks = parseCronFallbacks(opts.fallbacks);
  if (typeof opts.fallbacks === "string" && opts.clearFallbacks) {
    throw new Error("Use --fallbacks or --clear-fallbacks, not both");
  }
  const toolsAllow = parseCronToolsAllow(opts.tools);
  const timeoutSecondsValue = opts.timeoutSeconds;
  const rawTimeoutSeconds =
    timeoutSecondsValue === undefined
      ? undefined
      : typeof timeoutSecondsValue === "string" || typeof timeoutSecondsValue === "number"
        ? String(timeoutSecondsValue).trim()
        : "";
  if (rawTimeoutSeconds !== undefined && !/^\d+$/u.test(rawTimeoutSeconds)) {
    throw new Error("Invalid --timeout-seconds (must be a positive integer).");
  }
  const timeoutSeconds = rawTimeoutSeconds === undefined ? undefined : Number(rawTimeoutSeconds);
  const hasTimeoutSeconds =
    typeof timeoutSeconds === "number" &&
    Number.isSafeInteger(timeoutSeconds) &&
    timeoutSeconds > 0;
  if (rawTimeoutSeconds !== undefined && !hasTimeoutSeconds) {
    throw new Error("Invalid --timeout-seconds (must be a positive integer).");
  }
  const rawNoOutputTimeoutSeconds =
    opts.noOutputTimeoutSeconds ??
    (typeof opts.outputTimeoutSeconds === "string" || typeof opts.outputTimeoutSeconds === "number"
      ? opts.outputTimeoutSeconds
      : undefined);
  const noOutputTimeoutSeconds = parseStrictPositiveInteger(rawNoOutputTimeoutSeconds);
  if (rawNoOutputTimeoutSeconds !== undefined && noOutputTimeoutSeconds === undefined) {
    throw new Error("Invalid --no-output-timeout-seconds (must be a positive integer).");
  }
  const outputMaxBytes = parseStrictPositiveInteger(opts.outputMaxBytes);
  if (opts.outputMaxBytes !== undefined && outputMaxBytes === undefined) {
    throw new Error("Invalid --output-max-bytes (must be a positive integer).");
  }
  const scriptTimeoutSeconds = parseStrictPositiveInteger(opts.scriptTimeoutSeconds);
  if (opts.scriptTimeoutSeconds !== undefined && scriptTimeoutSeconds === undefined) {
    throw new Error("Invalid --script-timeout-seconds (must be a positive integer).");
  }
  const scriptToolBudget = parseStrictPositiveInteger(opts.scriptToolBudget);
  if (opts.scriptToolBudget !== undefined && scriptToolBudget === undefined) {
    throw new Error("Invalid --script-tool-budget (must be a positive integer).");
  }

  const hasWebhookDelivery = typeof opts.webhook === "string";
  const hasDeliveryModeFlag =
    opts.announce || typeof opts.deliver === "boolean" || hasWebhookDelivery;
  const threadId = parseCronThreadIdOption(opts.threadId);
  const hasDeliveryThreadId = typeof threadId === "number";
  const hasDeliveryTarget =
    typeof opts.channel === "string" ||
    typeof opts.to === "string" ||
    hasDeliveryThreadId ||
    Boolean(opts.clearChannel) ||
    Boolean(opts.clearTo) ||
    Boolean(opts.clearThreadId);
  const hasDeliveryAccount = typeof opts.account === "string" || Boolean(opts.clearAccount);
  const hasBestEffort = typeof opts.bestEffortDeliver === "boolean";
  if (hasWebhookDelivery && (hasDeliveryTarget || hasDeliveryAccount)) {
    throw new Error("--webhook cannot be combined with chat delivery options.");
  }
  if (typeof opts.channel === "string" && opts.clearChannel) {
    throw new Error("Use --channel or --clear-channel, not both");
  }
  if (typeof opts.to === "string" && opts.clearTo) {
    throw new Error("Use --to or --clear-to, not both");
  }
  if (hasDeliveryThreadId && opts.clearThreadId) {
    throw new Error("Use --thread-id or --clear-thread-id, not both");
  }
  if (typeof opts.account === "string" && opts.clearAccount) {
    throw new Error("Use --account or --clear-account, not both");
  }

  const hasCommandSpecificPayloadField =
    Boolean(commandShell) ||
    Boolean(commandArgv) ||
    typeof opts.commandCwd === "string" ||
    typeof opts.commandInput === "string" ||
    opts.commandEnv !== undefined ||
    noOutputTimeoutSeconds !== undefined ||
    outputMaxBytes !== undefined;
  let timeoutOnlyPayloadKind: "agentTurn" | "command" | undefined;
  if (
    hasTimeoutSeconds &&
    !hasCommandSpecificPayloadField &&
    typeof opts.message !== "string" &&
    !model &&
    typeof opts.fallbacks !== "string" &&
    !opts.clearFallbacks &&
    !thinking &&
    !opts.clearThinking &&
    typeof opts.lightContext !== "boolean" &&
    typeof opts.tools !== "string" &&
    !Array.isArray(opts.tools) &&
    !opts.clearTools
  ) {
    const existing = await loadExistingJob();
    timeoutOnlyPayloadKind = existing.payload.kind === "command" ? "command" : "agentTurn";
  }
  const hasAgentTurnPayloadField =
    typeof opts.message === "string" ||
    Boolean(model) ||
    Boolean(opts.clearModel) ||
    typeof opts.fallbacks === "string" ||
    Boolean(opts.clearFallbacks) ||
    Boolean(thinking) ||
    Boolean(opts.clearThinking) ||
    (hasTimeoutSeconds &&
      !hasCommandSpecificPayloadField &&
      timeoutOnlyPayloadKind !== "command") ||
    typeof opts.lightContext === "boolean" ||
    typeof opts.tools === "string" ||
    Array.isArray(opts.tools) ||
    opts.clearTools;
  const hasCommandPayloadField =
    hasCommandSpecificPayloadField ||
    (hasTimeoutSeconds && (hasCommandSpecificPayloadField || timeoutOnlyPayloadKind === "command"));
  const hasAgentTurnPatch = hasAgentTurnPayloadField;
  const hasCommandPatch = hasCommandPayloadField;
  const hasScriptPatch =
    Boolean(scriptPath) || scriptTimeoutSeconds !== undefined || scriptToolBudget !== undefined;
  if (
    [hasSystemEventPatch, hasAgentTurnPatch, hasCommandPatch, hasScriptPatch].filter(Boolean)
      .length > 1
  ) {
    throw new Error("Choose at most one payload change");
  }

  if (hasSystemEventPatch) {
    patch.payload = {
      kind: "systemEvent",
      text: String(opts.systemEvent),
    };
  } else if (hasAgentTurnPatch) {
    const payload: Record<string, unknown> = { kind: "agentTurn" };
    assignIf(payload, "message", String(opts.message), typeof opts.message === "string");
    if (opts.clearModel) {
      payload.model = null;
    } else {
      assignIf(payload, "model", model, Boolean(model));
    }
    assignIf(payload, "fallbacks", fallbacks, typeof opts.fallbacks === "string");
    assignIf(payload, "fallbacks", null, Boolean(opts.clearFallbacks));
    if (opts.clearThinking) {
      payload.thinking = null;
    } else {
      assignIf(payload, "thinking", thinking, Boolean(thinking));
    }
    assignIf(payload, "timeoutSeconds", timeoutSeconds, hasTimeoutSeconds);
    assignIf(payload, "lightContext", opts.lightContext, typeof opts.lightContext === "boolean");
    if (opts.clearTools) {
      payload.toolsAllow = null;
    } else if (toolsAllow) {
      payload.toolsAllow = toolsAllow;
    }
    patch.payload = payload;
  } else if (hasCommandPatch) {
    const payload: Record<string, unknown> = { kind: "command" };
    assignIf(payload, "argv", commandArgv, Boolean(commandArgv));
    assignIf(payload, "argv", ["sh", "-lc", commandShell], Boolean(commandShell));
    assignIf(
      payload,
      "cwd",
      normalizeOptionalString(opts.commandCwd),
      typeof opts.commandCwd === "string",
    );
    assignIf(payload, "env", parseCronCommandEnv(opts.commandEnv), opts.commandEnv !== undefined);
    assignIf(payload, "input", opts.commandInput, typeof opts.commandInput === "string");
    assignIf(payload, "timeoutSeconds", timeoutSeconds, hasTimeoutSeconds);
    assignIf(
      payload,
      "noOutputTimeoutSeconds",
      noOutputTimeoutSeconds,
      noOutputTimeoutSeconds !== undefined,
    );
    assignIf(payload, "outputMaxBytes", outputMaxBytes, outputMaxBytes !== undefined);
    patch.payload = payload;
  } else if (hasScriptPatch) {
    const payload: Record<string, unknown> = { kind: "script" };
    if (scriptPath) {
      payload.script = await readCronPayloadScript(scriptPath);
    }
    assignIf(payload, "timeoutSeconds", scriptTimeoutSeconds, scriptTimeoutSeconds !== undefined);
    assignIf(payload, "toolBudget", scriptToolBudget, scriptToolBudget !== undefined);
    patch.payload = payload;
  }

  if (hasDeliveryModeFlag || hasDeliveryTarget || hasDeliveryAccount || hasBestEffort) {
    const delivery: Record<string, unknown> = {};
    if (hasDeliveryModeFlag) {
      delivery.mode = hasWebhookDelivery
        ? "webhook"
        : opts.announce || opts.deliver === true
          ? "announce"
          : "none";
    } else if (opts.bestEffortDeliver === true) {
      // Back-compat: enabling best-effort historically implied announce mode.
      delivery.mode = "announce";
    }
    if (opts.clearChannel) {
      delivery.channel = null;
    } else if (typeof opts.channel === "string") {
      const channel = opts.channel.trim();
      delivery.channel = channel ? channel : undefined;
    }
    if (hasWebhookDelivery) {
      const webhook = normalizeOptionalString(opts.webhook) ?? "";
      delivery.to = webhook ? webhook : undefined;
    } else if (opts.clearTo) {
      delivery.to = null;
    } else if (typeof opts.to === "string") {
      const to = opts.to.trim();
      delivery.to = to ? to : undefined;
    }
    if (opts.clearThreadId) {
      delivery.threadId = null;
    } else if (hasDeliveryThreadId) {
      delivery.threadId = threadId;
    }
    if (opts.clearAccount) {
      delivery.accountId = null;
    } else if (typeof opts.account === "string") {
      const account = opts.account.trim();
      delivery.accountId = account ? account : undefined;
    }
    if (typeof opts.bestEffortDeliver === "boolean") {
      delivery.bestEffort = opts.bestEffortDeliver;
    }
    patch.delivery = delivery;
  }

  return patch;
}
