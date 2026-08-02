// Installs OpenClaw-owned policy ports before package providers or shared
// transport helpers run. Direct transport imports need the same wiring as the
// process-default stream facade.
import { configureAiTransportHost } from "@openclaw/ai";
import { resolveOpenAIStrictToolSetting } from "../agents/openai-strict-tool-setting.js";
import {
  buildGuardedModelFetch,
  resolveModelRequestTimeoutMs,
} from "../agents/provider-transport-fetch.js";
import { redactSecrets, redactToolPayloadText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAnthropicInlineContentBlocks } from "../media/anthropic-inline-images.js";
import { swapSecretSentinelsInText } from "../secrets/sentinel.js";

const transportLogBySubsystem = new Map<string, ReturnType<typeof createSubsystemLogger>>();

function transportLog(subsystem: string): ReturnType<typeof createSubsystemLogger> {
  let log = transportLogBySubsystem.get(subsystem);
  if (!log) {
    log = createSubsystemLogger(subsystem);
    transportLogBySubsystem.set(subsystem, log);
  }
  return log;
}

configureAiTransportHost({
  buildModelFetch: buildGuardedModelFetch,
  resolveSecretSentinel: (value) => {
    const swapped = swapSecretSentinelsInText(value);
    const unknown = swapped.unknown[0];
    if (unknown) {
      throw new Error(
        `Secret sentinel ${unknown} is not registered in this process; refusing to construct provider client`,
      );
    }
    return swapped.text;
  },
  redactSecrets,
  redactToolPayloadText,
  normalizeAnthropicInlineContentBlocks,
  resolveOpenAIStrictToolSetting,
  resolveModelRequestTimeoutMs: (model) => resolveModelRequestTimeoutMs(model, undefined),
  logDebug: (subsystem, build) => {
    const log = transportLog(subsystem);
    if (!log.isEnabled("debug", "any")) {
      return;
    }
    const entry = build();
    if (entry) {
      log.debug(entry.message, entry.data);
    }
  },
  logInfo: (subsystem, message, data) => transportLog(subsystem).info(message, data),
  logWarn: (subsystem, message, data) => transportLog(subsystem).warn(message, data),
});
