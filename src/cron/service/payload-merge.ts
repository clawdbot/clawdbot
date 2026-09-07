// Cron payload merge rules applied when cron.update patches an existing job.
import type { CronPayload, CronPayloadPatch } from "../types.js";

type CronAgentTurnPayload = Extract<CronPayload, { kind: "agentTurn" }>;
type CronPayloadToolAllow = Pick<CronPayload, "toolsAllow" | "toolsAllowIsDefault">;
type CronPayloadToolAllowPatch = Pick<CronPayloadPatch, "toolsAllow" | "toolsAllowIsDefault">;

function applyToolsAllowPatch(
  payload: CronPayloadToolAllow,
  patch: CronPayloadToolAllowPatch,
  existing?: CronPayloadToolAllow,
): void {
  if (Array.isArray(patch.toolsAllow)) {
    payload.toolsAllow = patch.toolsAllow;
    // Same-kind edits keep the marker whenever the default-stamped list is
    // unchanged — even when the patch omits toolsAllowIsDefault, because the
    // cron tool's model-facing schema never sends it. Dropping the marker on an
    // echoed list silently reclassifies "default" as an explicit restriction,
    // which fail-closes the next run on CLI backends that cannot enforce
    // runtime toolsAllow. Kind replacements (no existing payload) still require
    // the cron-tool-stamped marker on the patch itself.
    const existingDefaultUnchanged =
      existing?.toolsAllowIsDefault === true && toolsAllowEqual(existing, patch);
    const installsDefault =
      patch.toolsAllowIsDefault === true && existing?.toolsAllowIsDefault !== true;
    const keepDefaultMarker = existingDefaultUnchanged || installsDefault;
    if (keepDefaultMarker) {
      payload.toolsAllowIsDefault = true;
    } else {
      delete payload.toolsAllowIsDefault;
    }
  } else if (patch.toolsAllow === null) {
    delete payload.toolsAllow;
    delete payload.toolsAllowIsDefault;
  }
}

function toolsAllowEqual(
  left: Pick<CronPayloadToolAllow, "toolsAllow">,
  right: Pick<CronPayloadToolAllowPatch, "toolsAllow">,
): boolean {
  const rightToolsAllow = right.toolsAllow;
  return (
    Array.isArray(left.toolsAllow) &&
    Array.isArray(rightToolsAllow) &&
    left.toolsAllow.length === rightToolsAllow.length &&
    left.toolsAllow.every((toolName, index) => toolName === rightToolsAllow[index])
  );
}

export function mergeCronPayload(existing: CronPayload, patch: CronPayloadPatch): CronPayload {
  if (patch.kind !== existing.kind) {
    const next = buildPayloadFromPatch(patch);
    // toolsAllow is shared security state. Kind changes must not silently
    // reopen a restricted trigger runtime; null remains the explicit clear.
    if (patch.toolsAllow === undefined && Array.isArray(existing.toolsAllow)) {
      next.toolsAllow = [...existing.toolsAllow];
      if (existing.toolsAllowIsDefault === true) {
        next.toolsAllowIsDefault = true;
      }
    }
    return next;
  }

  if (patch.kind === "systemEvent" && existing.kind === "systemEvent") {
    const text = typeof patch.text === "string" ? patch.text : existing.text;
    const next: Extract<CronPayload, { kind: "systemEvent" }> = { ...existing, text };
    applyToolsAllowPatch(next, patch, existing);
    return next;
  }

  if (patch.kind === "command" && existing.kind === "command") {
    const next: Extract<CronPayload, { kind: "command" }> = { ...existing };
    if (Array.isArray(patch.argv)) {
      next.argv = patch.argv;
    }
    if (typeof patch.cwd === "string") {
      next.cwd = patch.cwd;
    }
    if (patch.env && typeof patch.env === "object" && !Array.isArray(patch.env)) {
      next.env = patch.env;
    }
    if (typeof patch.input === "string") {
      next.input = patch.input;
    }
    if (typeof patch.timeoutSeconds === "number") {
      next.timeoutSeconds = patch.timeoutSeconds;
    }
    if (typeof patch.noOutputTimeoutSeconds === "number") {
      next.noOutputTimeoutSeconds = patch.noOutputTimeoutSeconds;
    }
    if (typeof patch.outputMaxBytes === "number") {
      next.outputMaxBytes = patch.outputMaxBytes;
    }
    applyToolsAllowPatch(next, patch, existing);
    return next;
  }
  if (patch.kind === "script" && existing.kind === "script") {
    const next: Extract<CronPayload, { kind: "script" }> = { ...existing };
    if (typeof patch.script === "string") {
      next.script = patch.script;
    }
    if (typeof patch.timeoutSeconds === "number") {
      next.timeoutSeconds = patch.timeoutSeconds;
    }
    if (typeof patch.toolBudget === "number") {
      next.toolBudget = patch.toolBudget;
    }
    applyToolsAllowPatch(next, patch, existing);
    return next;
  }

  if (patch.kind !== "agentTurn" || existing.kind !== "agentTurn") {
    // System-owned payloads carry no fields; the service boundary already
    // rejects client patches for them.
    return buildPayloadFromPatch(patch);
  }

  const next: CronAgentTurnPayload = { ...existing };
  if (typeof patch.message === "string") {
    next.message = patch.message;
  }
  if (typeof patch.model === "string") {
    next.model = patch.model;
  } else if (patch.model === null) {
    delete next.model;
  }
  if (Array.isArray(patch.fallbacks)) {
    next.fallbacks = patch.fallbacks;
  } else if (patch.fallbacks === null) {
    delete next.fallbacks;
  }
  applyToolsAllowPatch(next, patch, existing);
  if (typeof patch.thinking === "string") {
    next.thinking = patch.thinking;
  } else if (patch.thinking === null) {
    delete next.thinking;
  }
  if (typeof patch.timeoutSeconds === "number") {
    next.timeoutSeconds = patch.timeoutSeconds;
  }
  if (typeof patch.lightContext === "boolean") {
    next.lightContext = patch.lightContext;
  }
  if (typeof patch.allowUnsafeExternalContent === "boolean") {
    next.allowUnsafeExternalContent = patch.allowUnsafeExternalContent;
  }
  return next;
}

function buildPayloadFromPatch(patch: CronPayloadPatch): CronPayload {
  if (patch.kind === "systemEvent") {
    if (typeof patch.text !== "string" || patch.text.length === 0) {
      throw new Error('cron.update payload.kind="systemEvent" requires text');
    }
    const next: Extract<CronPayload, { kind: "systemEvent" }> = {
      kind: "systemEvent",
      text: patch.text,
    };
    applyToolsAllowPatch(next, patch);
    return next;
  }

  if (patch.kind === "command") {
    if (!Array.isArray(patch.argv) || patch.argv.length === 0) {
      throw new Error('cron.update payload.kind="command" requires argv');
    }
    const next: Extract<CronPayload, { kind: "command" }> = {
      kind: "command",
      argv: patch.argv,
      ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
      ...(patch.env !== undefined ? { env: patch.env } : {}),
      ...(patch.input !== undefined ? { input: patch.input } : {}),
      ...(patch.timeoutSeconds !== undefined ? { timeoutSeconds: patch.timeoutSeconds } : {}),
      ...(patch.noOutputTimeoutSeconds !== undefined
        ? { noOutputTimeoutSeconds: patch.noOutputTimeoutSeconds }
        : {}),
      ...(patch.outputMaxBytes !== undefined ? { outputMaxBytes: patch.outputMaxBytes } : {}),
    };
    applyToolsAllowPatch(next, patch);
    return next;
  }

  if (patch.kind === "script") {
    if (typeof patch.script !== "string" || patch.script.trim().length === 0) {
      throw new Error('cron.update payload.kind="script" requires script');
    }
    const next: Extract<CronPayload, { kind: "script" }> = {
      kind: "script",
      script: patch.script,
      ...(patch.timeoutSeconds !== undefined ? { timeoutSeconds: patch.timeoutSeconds } : {}),
      ...(patch.toolBudget !== undefined ? { toolBudget: patch.toolBudget } : {}),
    };
    applyToolsAllowPatch(next, patch);
    return next;
  }

  if (patch.kind !== "agentTurn") {
    return { kind: patch.kind };
  }

  if (typeof patch.message !== "string" || patch.message.length === 0) {
    throw new Error('cron.update payload.kind="agentTurn" requires message');
  }

  const next: CronAgentTurnPayload = {
    kind: "agentTurn",
    message: patch.message,
    ...(typeof patch.model === "string" ? { model: patch.model } : {}),
    ...(Array.isArray(patch.fallbacks) ? { fallbacks: patch.fallbacks } : {}),
    ...(typeof patch.thinking === "string" ? { thinking: patch.thinking } : {}),
    ...(patch.timeoutSeconds !== undefined ? { timeoutSeconds: patch.timeoutSeconds } : {}),
    ...(patch.lightContext !== undefined ? { lightContext: patch.lightContext } : {}),
    ...(patch.allowUnsafeExternalContent !== undefined
      ? { allowUnsafeExternalContent: patch.allowUnsafeExternalContent }
      : {}),
  };
  applyToolsAllowPatch(next, patch);
  return next;
}
