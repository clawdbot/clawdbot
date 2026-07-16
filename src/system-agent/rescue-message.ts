// OpenClaw rescue messages expose approved setup-helper commands over message channels.
import { createHash } from "node:crypto";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import type { CommandContext } from "../auto-reply/reply/commands-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createCorePluginStateSyncKeyedStore } from "../plugin-state/plugin-state-store.js";
import type { RuntimeEnv } from "../runtime.js";
import { classifySystemAgentApprovalText } from "./approval-intent.js";
import {
  executeSystemAgentOperation,
  formatSystemAgentPersistentPlan,
  isPersistentSystemAgentOperation,
  parseSystemAgentOperation,
  type SystemAgentCommandDeps,
  type SystemAgentOperation,
} from "./operations.js";
import { resolveSystemAgentRescuePolicy } from "./rescue-policy.js";

/**
 * Message-channel rescue command handling for OpenClaw.
 *
 * Rescue mode accepts `/openclaw` commands from approved message contexts,
 * stores pending persistent operations for explicit confirmation, and captures
 * command output without exposing local TUI or plugin-install flows remotely.
 */
type RescuePendingOperation = {
  version: 1;
  operation: SystemAgentOperation;
};

/** Input required to process one possible `/openclaw` rescue message. */
type SystemAgentRescueMessageInput = {
  cfg: OpenClawConfig;
  command: CommandContext;
  commandBody: string;
  agentId?: string;
  isGroup: boolean;
  env?: NodeJS.ProcessEnv;
  deps?: SystemAgentCommandDeps;
};

const SYSTEM_AGENT_COMMAND = "/openclaw";
const RESCUE_PENDING_NAMESPACE = "rescue-pending";
const RESCUE_PENDING_MAX_ENTRIES = 1_024;

function createCaptureRuntime(): { runtime: RuntimeEnv; read: () => string } {
  const lines: string[] = [];
  const push = (...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  };
  return {
    runtime: {
      log: push,
      error: push,
      exit: (code) => {
        throw new Error(`OpenClaw operation exited with code ${code}`);
      },
    },
    read: () => lines.join("\n").trim(),
  };
}

/** Extract the command body after `/openclaw`, or null when the message is not for rescue. */
export function extractSystemAgentRescueMessage(commandBody: string): string | null {
  const normalized = commandBody.trim();
  const lower = normalized.toLowerCase();
  if (lower !== SYSTEM_AGENT_COMMAND && !lower.startsWith(`${SYSTEM_AGENT_COMMAND} `)) {
    return null;
  }
  return normalized.slice(SYSTEM_AGENT_COMMAND.length).trim();
}

function resolvePendingKey(input: SystemAgentRescueMessageInput): string {
  // Pending approval is scoped by account, channel, and sender identity so one
  // owner route cannot approve a capability proposed through another route.
  const key = JSON.stringify({
    accountId: resolveAccountDiscriminator(input.command),
    channel: input.command.channelId ?? input.command.channel,
    from: input.command.from,
    senderId: input.command.senderId,
  });
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

function resolveAccountDiscriminator(command: CommandContext): string {
  return command.accountId?.trim() || command.to?.trim() || "default";
}

function openPendingStore(env?: NodeJS.ProcessEnv) {
  return createCorePluginStateSyncKeyedStore<unknown>({
    ownerId: "core:system-agent",
    namespace: RESCUE_PENDING_NAMESPACE,
    maxEntries: RESCUE_PENDING_MAX_ENTRIES,
    overflowPolicy: "reject-new",
    ...(env ? { env } : {}),
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function hasOptionalString(value: Record<string, unknown>, key: string): boolean {
  return !Object.hasOwn(value, key) || isNonEmptyString(value[key]);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parsePendingOperation(value: unknown): SystemAgentOperation | null {
  if (!isPlainRecord(value) || value.version !== 1 || !isPlainRecord(value.operation)) {
    return null;
  }
  const operation = value.operation;
  if (typeof operation.kind !== "string") {
    return null;
  }
  switch (operation.kind) {
    case "set-default-model":
      if (!hasExactKeys(operation, ["kind", "model"]) || !isNonEmptyString(operation.model)) {
        return null;
      }
      break;
    case "config-set":
      if (
        !hasExactKeys(operation, ["kind", "path", "value"]) ||
        !isNonEmptyString(operation.path) ||
        !isNonEmptyString(operation.value)
      ) {
        return null;
      }
      break;
    case "config-set-ref":
      if (
        !hasExactKeys(operation, ["kind", "path", "source", "id"], ["provider"]) ||
        !isNonEmptyString(operation.path) ||
        (operation.source !== "env" &&
          operation.source !== "file" &&
          operation.source !== "exec") ||
        !isNonEmptyString(operation.id) ||
        !hasOptionalString(operation, "provider")
      ) {
        return null;
      }
      break;
    case "setup":
      if (
        !hasExactKeys(operation, ["kind"], ["workspace", "model"]) ||
        !hasOptionalString(operation, "workspace") ||
        !hasOptionalString(operation, "model")
      ) {
        return null;
      }
      break;
    case "plugin-install":
      if (!hasExactKeys(operation, ["kind", "spec"]) || !isNonEmptyString(operation.spec)) {
        return null;
      }
      break;
    case "create-agent":
      if (
        !hasExactKeys(operation, ["kind", "agentId"], ["workspace", "model"]) ||
        !isNonEmptyString(operation.agentId) ||
        !hasOptionalString(operation, "workspace") ||
        !hasOptionalString(operation, "model")
      ) {
        return null;
      }
      break;
    case "gateway-start":
    case "gateway-stop":
    case "gateway-restart":
      if (!hasExactKeys(operation, ["kind"])) {
        return null;
      }
      break;
    default:
      return null;
  }
  return isPersistentSystemAgentOperation(operation as SystemAgentOperation)
    ? (operation as SystemAgentOperation)
    : null;
}

function buildAuditDetails(input: SystemAgentRescueMessageInput): Record<string, unknown> {
  return {
    rescue: true,
    channel: input.command.channelId ?? input.command.channel,
    accountId: resolveAccountDiscriminator(input.command),
    senderId: input.command.senderId,
    from: input.command.from,
  };
}

function formatPersistentPlan(operation: SystemAgentOperation): string {
  return formatSystemAgentPersistentPlan(operation).replace(
    "Say yes to apply.",
    "Reply /openclaw yes to apply.",
  );
}

function formatUnsupportedRemoteOperation(operation: SystemAgentOperation): string | null {
  if (operation.kind === "open-tui") {
    return [
      "OpenClaw rescue cannot open the local TUI from a message channel.",
      "Use local `openclaw` for agent handoff, or ask for status, doctor, config, gateway, agents, or models.",
    ].join(" ");
  }
  if (operation.kind === "channel-setup") {
    return [
      "OpenClaw rescue cannot host the interactive channel setup from a message channel.",
      "Run `openclaw setup` locally and say `connect " + operation.channel + "` instead.",
    ].join(" ");
  }
  if (operation.kind === "model-setup") {
    return [
      "OpenClaw rescue cannot host model-provider credential setup from a message channel.",
      "Run `openclaw onboard` locally; it live-tests the candidate route before saving it.",
    ].join(" ");
  }
  if (operation.kind === "doctor-fix") {
    return [
      "OpenClaw rescue cannot run doctor repairs from a message channel because they can change the inference route powering this session.",
      "Exit OpenClaw and run `openclaw doctor --fix` in a terminal.",
    ].join(" ");
  }
  if (operation.kind === "plugin-install") {
    return [
      "OpenClaw rescue cannot install plugins from a message channel by default because plugin install downloads executable code.",
      "Use local `openclaw setup` or `openclaw plugins install` instead.",
    ].join(" ");
  }
  return null;
}

/** Process one rescue message and return a reply, or null when not a rescue command. */
export async function runSystemAgentRescueMessage(
  input: SystemAgentRescueMessageInput,
): Promise<string | null> {
  const rescueMessage = extractSystemAgentRescueMessage(input.commandBody);
  if (rescueMessage === null) {
    return null;
  }
  const policy = resolveSystemAgentRescuePolicy({
    cfg: input.cfg,
    agentId: input.agentId,
    senderIsOwner: input.command.senderIsOwner,
    isDirectMessage: !input.isGroup,
  });
  if (!policy.allowed) {
    return policy.message;
  }

  const pendingStore = openPendingStore(input.env);
  const pendingKey = resolvePendingKey(input);
  const approvalIntent = classifySystemAgentApprovalText(rescueMessage);
  // Remote rescue never consults a model (a broken/compromised agent path must
  // not become a config editor); approval stays on the closed deterministic list.
  if (approvalIntent === "approve") {
    // Consume before any async execution. Concurrent approvals get at most one
    // capability, and a failed execution cannot leave a replayable write.
    const operation = parsePendingOperation(pendingStore.consume(pendingKey));
    if (!operation) {
      return "No pending OpenClaw rescue change is waiting for approval.";
    }
    const unsupported = formatUnsupportedRemoteOperation(operation);
    if (unsupported) {
      return unsupported;
    }
    const capture = createCaptureRuntime();
    await executeSystemAgentOperation(operation, capture.runtime, {
      approved: true,
      auditDetails: buildAuditDetails(input),
      deps: input.deps,
    });
    return capture.read() || "OpenClaw rescue change applied.";
  }

  if (approvalIntent === "decline") {
    const pending = parsePendingOperation(pendingStore.consume(pendingKey));
    return pending
      ? "Dropped the pending OpenClaw rescue change."
      : "No pending OpenClaw rescue change is waiting for approval.";
  }

  // Any fresh command revokes the previous capability for this exact route.
  // Persistent commands below replace it with their newly rendered plan.
  // Keep parse and registration below synchronous: invocation order must stay
  // publication order. Async validation begins only after approval consumes the row.
  pendingStore.delete(pendingKey);
  const operation = parseSystemAgentOperation(rescueMessage);
  const unsupported = formatUnsupportedRemoteOperation(operation);
  if (unsupported) {
    return unsupported;
  }
  if (isPersistentSystemAgentOperation(operation)) {
    // Persistent remote operations are two-step: store the parsed operation, then require approval.
    const now = new Date();
    const nowMs = asDateTimestampMs(now.getTime());
    const expiresAtMs =
      nowMs === undefined
        ? undefined
        : resolveExpiresAtMsFromDurationMs(policy.pendingTtlMinutes * 60_000, { nowMs });
    if (nowMs === undefined || expiresAtMs === undefined) {
      return "OpenClaw rescue could not create a pending approval because the expiry clock is invalid.";
    }
    const ttlMs = expiresAtMs - nowMs;
    pendingStore.register(
      pendingKey,
      {
        version: 1,
        operation,
      } satisfies RescuePendingOperation,
      { ttlMs },
    );
    return formatPersistentPlan(operation);
  }

  const capture = createCaptureRuntime();
  await executeSystemAgentOperation(operation, capture.runtime, {
    approved: true,
    auditDetails: buildAuditDetails(input),
    deps: input.deps,
  });
  return capture.read() || "OpenClaw listened, clicked a claw, and found nothing to change.";
}
