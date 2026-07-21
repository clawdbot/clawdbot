/**
 * openclaw built-in tool: ring-zero setup/repair actions for the OpenClaw
 * agent. Never exposed to normal agents — construction is bound to a host-owned
 * per-run scope, and every action funnels through OpenClaw's typed operation
 * union with approval assertions and the audit log.
 */
import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { RuntimeEnv } from "../../runtime.js";
import {
  executeSystemAgentOperation,
  isPersistentSystemAgentOperation,
  type SystemAgentOperation,
} from "../../system-agent/operations.js";
import { validateSystemAgentPluginInstallSpec } from "../../system-agent/plugin-install.js";
import { stringEnum } from "../schema/typebox.js";
import { stableStringify } from "../stable-stringify.js";
import { textResult, ToolInputError, readStringParam, type AnyAgentTool } from "./common.js";

export type SystemAgentToolOptions = {
  /** Where setup side effects run; the gateway surface never manages its own daemon. */
  surface: "cli" | "gateway";
  /**
   * Host-verified consent for THIS turn: true only when the host judged the
   * user's actual message to be an explicit approval. The model-supplied
   * `approved` argument alone must never authorize a mutation (prompt
   * injection, model error).
   */
  approvalArmed?: boolean;
  /**
   * Approval is scoped to one exact operation: a denied mutating call records
   * its canonical hash here (host-owned, survives turns), and an armed turn
   * may execute only a call matching that hash. Cleared after use.
   */
  proposalRef?: { current?: string; operation?: SystemAgentOperation };
  /**
   * Host handoff channel for actions the tool cannot perform itself
   * (interactive channel setup, external onboarding guidance, opening the
   * agent TUI). The engine reads it after the turn; CLI MCP hosts mirror it
   * from tool events.
   */
  directiveRef?: { current?: SystemAgentToolDirective };
};

/** Host directives the hosting chat engine handles after the turn. */
export type SystemAgentToolDirective =
  | { kind: "channel-setup"; channel: string }
  | { kind: "model-setup"; workspace?: string }
  | { kind: "open-tui"; agentId?: string; workspace?: string }
  | Extract<SystemAgentOperation, { kind: "open-setup" }>
  | { kind: "approved-operation"; operation: SystemAgentOperation };

type SystemAgentHostNavigationDirective = Exclude<
  SystemAgentToolDirective,
  { kind: "approved-operation" }
>;

/** Canonical operation fingerprint used to bind "yes" to one exact mutation. */
export function hashSystemAgentOperation(operation: SystemAgentOperation): string {
  return createHash("sha256").update(stableStringify(operation)).digest("hex");
}

/** Result markers shared with out-of-process hosts (CLI MCP runs). */
const SYSTEM_AGENT_NEEDS_APPROVAL_PREFIX = "needs-approval:";
const SYSTEM_AGENT_APPROVAL_MISMATCH_PREFIX = "approval-mismatch:";
const SYSTEM_AGENT_DIRECTIVE_PREFIX = "directive:";
const SYSTEM_AGENT_APPROVED_OPERATION_PREFIX = `${SYSTEM_AGENT_DIRECTIVE_PREFIX}approved-operation:`;

/**
 * Reconstruct a host directive from an out-of-process tool result. Directive
 * actions run inside the MCP subprocess on CLI-harness runs, so the host
 * replays them from harness tool events the same way proposals are mirrored.
 */
export function resolveSystemAgentDirectiveTransition(params: {
  args: Record<string, unknown>;
  resultText: string;
}): SystemAgentToolDirective | null {
  if (!params.resultText.startsWith(SYSTEM_AGENT_DIRECTIVE_PREFIX)) {
    return null;
  }
  try {
    const operation = operationForAction(params.args);
    if (
      params.resultText.startsWith(SYSTEM_AGENT_APPROVED_OPERATION_PREFIX) &&
      isPersistentSystemAgentOperation(operation)
    ) {
      return { kind: "approved-operation", operation };
    }
    return directiveForOperation(operation);
  } catch {
    return null;
  }
}

function directiveForOperation(
  operation: SystemAgentOperation,
): SystemAgentHostNavigationDirective | null {
  if (operation.kind === "channel-setup") {
    return { kind: "channel-setup", channel: operation.channel };
  }
  if (operation.kind === "model-setup") {
    return {
      kind: "model-setup",
      ...(operation.workspace ? { workspace: operation.workspace } : {}),
    };
  }
  if (operation.kind === "open-tui") {
    return {
      kind: "open-tui",
      ...(operation.agentId ? { agentId: operation.agentId } : {}),
      ...(operation.workspace ? { workspace: operation.workspace } : {}),
    };
  }
  if (operation.kind === "open-setup") {
    return operation;
  }
  return null;
}

/**
 * Mirror a proposalRef transition from an out-of-process tool result. CLI MCP
 * runs execute this tool in a stdio subprocess whose proposalRef dies with the
 * run; the host replays the same lifecycle from harness tool events: denial
 * registers the exact-operation hash, mismatch voids it, execution consumes it.
 */
export function resolveSystemAgentProposalTransition(params: {
  args: Record<string, unknown>;
  resultText: string;
}): { proposal: string | undefined; operation?: SystemAgentOperation } | null {
  let operation: SystemAgentOperation;
  try {
    operation = operationForAction(params.args);
  } catch {
    return null;
  }
  if (!isPersistentSystemAgentOperation(operation)) {
    return null;
  }
  if (params.resultText.startsWith(SYSTEM_AGENT_APPROVAL_MISMATCH_PREFIX)) {
    return { proposal: undefined };
  }
  if (params.resultText.startsWith(SYSTEM_AGENT_NEEDS_APPROVAL_PREFIX)) {
    const markerLine = params.resultText.split("\n", 1)[0] ?? "";
    const carriedHash = markerLine.slice(SYSTEM_AGENT_NEEDS_APPROVAL_PREFIX.length).trim();
    return {
      proposal: /^[a-f0-9]{64}$/.test(carriedHash)
        ? carriedHash
        : hashSystemAgentOperation(operation),
      operation,
    };
  }
  // Executed or errored mutation: an armed approval is single-use either way.
  return { proposal: undefined };
}

const SYSTEM_AGENT_TOOL_ACTIONS = [
  "status",
  "models",
  "agents",
  "channels",
  "channel_info",
  "audit",
  "validate_config",
  "doctor",
  "config_get",
  "config_schema",
  "gateway_status",
  "plugin_search",
  // Host directives handled by the hosting chat after this turn.
  "connect_channel",
  "configure_model_provider",
  "open_agent",
  "open_setup",
  // Mutating actions below require approved=true.
  "setup",
  "set_default_model",
  "config_set",
  "config_set_ref",
  "create_agent",
  "gateway_start",
  "gateway_stop",
  "gateway_restart",
  "plugin_install",
  "plugin_uninstall",
] as const;

const SystemAgentToolSchema = Type.Object({
  action: stringEnum([...SYSTEM_AGENT_TOOL_ACTIONS]),
  path: Type.Optional(Type.String({ description: "Config path for config_* actions" })),
  value: Type.Optional(Type.String({ description: "Value for config_set (JSON5 or string)" })),
  envVar: Type.Optional(Type.String({ description: "Env var name for config_set_ref" })),
  model: Type.Optional(Type.String({ description: "provider/model ref" })),
  workspace: Type.Optional(Type.String({ description: "Workspace directory" })),
  agentId: Type.Optional(
    Type.String({ description: "Agent id for setup/create_agent/open_agent/set_default_model" }),
  ),
  channel: Type.Optional(
    Type.String({
      description: "Channel id for connect_channel, channel_info, or open_setup channels",
    }),
  ),
  target: Type.Optional(
    stringEnum(["guided", "classic", "channels"], {
      description:
        "Setup target for open_setup. channels runs in this chat; guided/classic require exiting OpenClaw and running openclaw onboard.",
    }),
  ),
  query: Type.Optional(Type.String({ description: "Search query for plugin_search" })),
  spec: Type.Optional(Type.String({ description: "npm/clawhub spec for plugin_install" })),
  pluginId: Type.Optional(Type.String({ description: "Plugin id for plugin_uninstall" })),
  approved: Type.Optional(
    Type.Boolean({
      description:
        "Set true ONLY after the user explicitly approved this exact change in the conversation.",
    }),
  ),
});

function createCaptureRuntime(): RuntimeEnv & { read: () => string } {
  const lines: string[] = [];
  return {
    log: (...args) => lines.push(args.join(" ")),
    error: (...args) => lines.push(args.join(" ")),
    exit: (code) => {
      throw new Error(`openclaw operation exited with code ${String(code)}`);
    },
    read: () => lines.join("\n").trim(),
  };
}

function requireParam(params: Record<string, unknown>, name: string): string {
  const value = readStringParam(params, name);
  if (!value?.trim()) {
    throw new ToolInputError(`openclaw: "${name}" is required for this action`);
  }
  return value.trim();
}

function readSetupTarget(params: Record<string, unknown>): "guided" | "classic" | "channels" {
  const target = readStringParam(params, "target")?.trim() ?? "guided";
  if (target === "guided" || target === "classic" || target === "channels") {
    return target;
  }
  throw new ToolInputError(`openclaw: unknown setup target "${target}"`);
}

function operationForAction(params: Record<string, unknown>): SystemAgentOperation {
  const action = readStringParam(params, "action", { required: true });
  switch (action) {
    case "status":
      return { kind: "status" };
    case "models":
      return { kind: "models" };
    case "agents":
      return { kind: "agents" };
    case "channels":
      return { kind: "channel-list" };
    case "channel_info":
      return { kind: "channel-info", channel: requireParam(params, "channel").toLowerCase() };
    case "audit":
      return { kind: "audit" };
    case "validate_config":
      return { kind: "config-validate" };
    case "doctor":
      return { kind: "doctor" };
    case "config_get":
      return { kind: "config-get", path: requireParam(params, "path") };
    case "config_schema": {
      const path = readStringParam(params, "path")?.trim();
      return { kind: "config-schema", ...(path ? { path } : {}) };
    }
    case "gateway_status":
      return { kind: "gateway-status" };
    case "connect_channel":
      return { kind: "channel-setup", channel: requireParam(params, "channel").toLowerCase() };
    case "configure_model_provider": {
      const workspace = readStringParam(params, "workspace")?.trim();
      return { kind: "model-setup", ...(workspace ? { workspace } : {}) };
    }
    case "open_agent": {
      const agentId = readStringParam(params, "agentId")?.trim();
      const workspace = readStringParam(params, "workspace")?.trim();
      return {
        kind: "open-tui",
        ...(agentId ? { agentId } : {}),
        ...(workspace ? { workspace } : {}),
      };
    }
    case "open_setup": {
      const target = readSetupTarget(params);
      const channel = readStringParam(params, "channel")?.trim().toLowerCase();
      return {
        kind: "open-setup",
        target,
        ...(channel ? { channel } : {}),
      };
    }
    case "gateway_start":
      return { kind: "gateway-start" };
    case "gateway_stop":
      return { kind: "gateway-stop" };
    case "gateway_restart":
      return { kind: "gateway-restart" };
    case "plugin_search":
      return { kind: "plugin-search", query: requireParam(params, "query") };
    case "plugin_install": {
      const spec = requireParam(params, "spec");
      const validationError = validateSystemAgentPluginInstallSpec(spec);
      if (validationError) {
        throw new ToolInputError(`openclaw: ${validationError}`);
      }
      return { kind: "plugin-install", spec };
    }
    case "plugin_uninstall":
      return { kind: "plugin-uninstall", pluginId: requireParam(params, "pluginId") };
    case "setup": {
      const agentId = readStringParam(params, "agentId")?.trim();
      const workspace = readStringParam(params, "workspace")?.trim();
      const model = readStringParam(params, "model")?.trim();
      return {
        kind: "setup",
        ...(agentId ? { agentId } : {}),
        ...(workspace ? { workspace } : {}),
        ...(model ? { model } : {}),
      };
    }
    case "set_default_model": {
      const agentId = readStringParam(params, "agentId")?.trim();
      return {
        kind: "set-default-model",
        model: requireParam(params, "model"),
        ...(agentId ? { agentId } : {}),
      };
    }
    case "create_agent": {
      const workspace = readStringParam(params, "workspace")?.trim();
      const model = readStringParam(params, "model")?.trim();
      return {
        kind: "create-agent",
        agentId: requireParam(params, "agentId"),
        ...(workspace ? { workspace } : {}),
        ...(model ? { model } : {}),
      };
    }
    case "config_set":
      return {
        kind: "config-set",
        path: requireParam(params, "path"),
        value: requireParam(params, "value"),
      };
    case "config_set_ref":
      return {
        kind: "config-set-ref",
        path: requireParam(params, "path"),
        source: "env",
        id: requireParam(params, "envVar"),
      };
    default:
      throw new ToolInputError(`openclaw: unknown action "${action}"`);
  }
}

export function createSystemAgentTool(options: SystemAgentToolOptions): AnyAgentTool {
  return {
    name: "openclaw",
    label: "OpenClaw",
    // Setup authority is never discoverable through tool catalogs: the host
    // scopes it to this run and the model must receive it directly.
    catalogMode: "direct-only",
    description: [
      "System agent. Setup, config, channels, plugins, agents, repair.",
      "Read now: status, models, agents, channels, channel_info, config_get, config_schema, gateway_status, plugin_search, validate_config, doctor, audit.",
      "Handoff: connect_channel; open_setup target=channels; open_agent.",
      "Provider/auth/credentials: exit; run `openclaw onboard`. Never request credentials.",
      "Write: setup, set_default_model (agentId optional; live-tested), config_set, config_set_ref, create_agent, gateway_*, plugin_install, plugin_uninstall. Exact user approval required; then approved=true. Host applies after turn; rechecks inference owner.",
      "plugin_install: ClawHub/bundled/official only. Arbitrary source: exit, trusted shell.",
      "Unknown config: config_schema first. Secrets: config_set_ref env. No plaintext. No raw auth/models/env/secrets/$include or default-route agent fields; use set_default_model / onboard.",
      "No doctor repair. Writes validated, audited. Invalid config: fix now.",
    ].join(" "),
    parameters: SystemAgentToolSchema,
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const operation = operationForAction(params);
      const directive = directiveForOperation(operation);
      if (directive) {
        // Not a write: the host chat performs the interactive handoff after
        // this turn (the wizard itself collects explicit user answers).
        if (options.directiveRef && options.directiveRef.current?.kind !== "approved-operation") {
          options.directiveRef.current = directive;
        }
        return textResult(
          directive.kind === "channel-setup"
            ? `${SYSTEM_AGENT_DIRECTIVE_PREFIX} the host chat now starts the guided ${directive.channel} setup with the user. Tell the user the setup questions come next; do not describe steps yourself.`
            : directive.kind === "model-setup"
              ? `${SYSTEM_AGENT_DIRECTIVE_PREFIX} the active inference route cannot be changed inside OpenClaw. Tell the user to exit OpenClaw and run \`openclaw onboard\`; do not ask for provider credentials here.`
              : directive.kind === "open-tui"
                ? `${SYSTEM_AGENT_DIRECTIVE_PREFIX} the host now hands the user over to their normal agent. Say goodbye briefly.`
                : directive.target === "channels"
                  ? `${SYSTEM_AGENT_DIRECTIVE_PREFIX} the host now opens channel setup${directive.channel ? ` for ${directive.channel}` : ""}. Tell the user the channel setup questions come next.`
                  : `${SYSTEM_AGENT_DIRECTIVE_PREFIX} ${directive.target} setup cannot run inside OpenClaw because it may change the active inference route. Tell the user to exit OpenClaw and run \`openclaw onboard\`.`,
          {},
        );
      }
      const persistent = isPersistentSystemAgentOperation(operation);
      if (persistent) {
        const operationHash = hashSystemAgentOperation(operation);
        const armedForThisOperation =
          params.approved === true &&
          options.approvalArmed === true &&
          options.proposalRef?.current === operationHash;
        if (!armedForThisOperation) {
          // Three gates must hold: the model asserts consent, the host saw an
          // explicit user approval in the current turn, and the approved call
          // matches the operation registered BEFORE that approval. A generic
          // "yes" must never authorize a different mutation, and an armed turn
          // must never mint a new executable proposal for itself — otherwise
          // the model could swap the approved action for another one.
          if (options.approvalArmed === true) {
            if (options.proposalRef) {
              options.proposalRef.current = undefined;
              options.proposalRef.operation = undefined;
            }
            return textResult(
              `${SYSTEM_AGENT_APPROVAL_MISMATCH_PREFIX} this call is not the operation the user approved. The approval is void; describe the new change and get a fresh yes before retrying.`,
              { needsApproval: true },
            );
          }
          if (options.proposalRef) {
            options.proposalRef.current = operationHash;
            options.proposalRef.operation = operation;
          }
          return textResult(
            `${SYSTEM_AGENT_NEEDS_APPROVAL_PREFIX}${operationHash}\nThis action changes state. The proposal is registered; describe this exact change and ask the user to reply yes (their approval unlocks THIS action only — then retry the exact registered operation with approved=true).`,
            { needsApproval: true },
          );
        }
        if (options.proposalRef) {
          // One approval, one mutation: re-proposals need a fresh yes.
          options.proposalRef.current = undefined;
          options.proposalRef.operation = undefined;
        }
        const approvedDirective: SystemAgentToolDirective = {
          kind: "approved-operation",
          operation,
        };
        if (options.directiveRef) {
          options.directiveRef.current = approvedDirective;
        }
        // Ring-zero writes belong to the host process, not the model loop or
        // its out-of-process MCP server. The host rechecks the verified
        // inference binding immediately before applying this exact operation.
        return textResult(
          `${SYSTEM_AGENT_APPROVED_OPERATION_PREFIX} the host accepted this exact approved action and will apply it after this turn. Do not call it again.`,
          {},
        );
      }
      const capture = createCaptureRuntime();
      try {
        await executeSystemAgentOperation(operation, capture, {
          approved: false,
          deps: { setupSurface: options.surface },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResult([capture.read(), `error: ${message}`].filter(Boolean).join("\n"), {
          error: true,
        });
      }
      return textResult(capture.read() || "done", {});
    },
  };
}
