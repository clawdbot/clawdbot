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

  if (patch.kind === "systemEvent") {
    if (existing.kind !== "systemEvent") {
      return buildPayloadFromPatch(patch);
    }
    const text = typeof patch.text === "string" ? patch.text : existing.text;
    const next: Extract<CronPayload, { kind: "systemEvent" }> = { ...existing, text };
    applyToolsAllowPatch(next, patch, existing);
    return next;
  }

  if (patch.kind === "command") {
    if (existing.kind !== "command") {
      return buildPayloadFromPatch(patch);
    }
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
  if (patch.kind === "script") {
    if (existing.kind !== "script") {
      return buildPayloadFromPatch(patch);
    }
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

  if (existing.kind !== "agentTurn") {
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
      cwd: patch.cwd,
      env: patch.env,
      input: patch.input,
      timeoutSeconds: patch.timeoutSeconds,
      noOutputTimeoutSeconds: patch.noOutputTimeoutSeconds,
      outputMaxBytes: patch.outputMaxBytes,
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
      timeoutSeconds: patch.timeoutSeconds,
      toolBudget: patch.toolBudget,
    };
    applyToolsAllowPatch(next, patch);
    return next;
  }

  if (typeof patch.message !== "string" || patch.message.length === 0) {
    throw new Error('cron.update payload.kind="agentTurn" requires message');
  }

  const next: CronAgentTurnPayload = {
    kind: "agentTurn",
    message: patch.message,
    model: typeof patch.model === "string" ? patch.model : undefined,
    fallbacks: Array.isArray(patch.fallbacks) ? patch.fallbacks : undefined,
    thinking: typeof patch.thinking === "string" ? patch.thinking : undefined,
    timeoutSeconds: patch.timeoutSeconds,
    lightContext: patch.lightContext,
    allowUnsafeExternalContent: patch.allowUnsafeExternalContent,
  };
  applyToolsAllowPatch(next, patch);
  return next;
}
