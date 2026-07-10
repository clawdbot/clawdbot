/**
 * crestodian built-in tool: ring-zero setup/repair actions for the Crestodian
 * agent. Never exposed to normal agents — construction is gated on an explicit
 * runner option, and every action funnels through Crestodian's typed operation
 * union with approval assertions and the audit log.
 */
import { createHash } from "node:crypto";
import { Type } from "typebox";
import {
  CRESTODIAN_SETUP_INFERENCE_KINDS,
  executeCrestodianOperation,
  isPersistentCrestodianOperation,
  validateCrestodianSetupInferenceSelection,
  type CrestodianOperation,
  type CrestodianSetupInferenceRoute,
} from "../../crestodian/operations.js";
import type { RuntimeEnv } from "../../runtime.js";
import { stringEnum } from "../schema/typebox.js";
import { stableStringify } from "../stable-stringify.js";
import { textResult, ToolInputError, readStringParam, type AnyAgentTool } from "./common.js";

export type CrestodianToolOptions = {
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
  proposalRef?: { current?: string };
  /**
   * Host handoff channel for actions the tool cannot perform itself
   * (interactive channel-setup wizard, opening the agent TUI). The engine
   * reads it after the turn; CLI MCP hosts mirror it from tool events.
   */
  directiveRef?: { current?: CrestodianToolDirective };
};

/** Interactive handoffs the hosting chat engine executes after the turn. */
export type CrestodianToolDirective =
  | { kind: "channel-setup"; channel: string }
  | { kind: "model-setup"; workspace?: string }
  | { kind: "open-tui"; agentId?: string; workspace?: string }
  | Extract<CrestodianOperation, { kind: "open-setup" }>;

/** Canonical operation fingerprint used to bind "yes" to one exact mutation. */
export function hashCrestodianOperation(operation: CrestodianOperation): string {
  return createHash("sha256").update(stableStringify(operation)).digest("hex");
}

/** Result markers shared with out-of-process hosts (CLI MCP runs). */
const CRESTODIAN_NEEDS_APPROVAL_PREFIX = "needs-approval:";
const CRESTODIAN_APPROVAL_MISMATCH_PREFIX = "approval-mismatch:";
const CRESTODIAN_DIRECTIVE_PREFIX = "directive:";

/**
 * Reconstruct a host directive from an out-of-process tool result. Directive
 * actions run inside the MCP subprocess on CLI-harness runs, so the host
 * replays them from harness tool events the same way proposals are mirrored.
 */
export function resolveCrestodianDirectiveTransition(params: {
  args: Record<string, unknown>;
  resultText: string;
}): CrestodianToolDirective | null {
  if (!params.resultText.startsWith(CRESTODIAN_DIRECTIVE_PREFIX)) {
    return null;
  }
  try {
    return directiveForOperation(operationForAction(params.args));
  } catch {
    return null;
  }
}

function directiveForOperation(operation: CrestodianOperation): CrestodianToolDirective | null {
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
export function resolveCrestodianProposalTransition(params: {
  args: Record<string, unknown>;
  resultText: string;
}): { proposal: string | undefined } | null {
  let operation: CrestodianOperation;
  try {
    operation = operationForAction(params.args);
  } catch {
    return null;
  }
  if (!isPersistentCrestodianOperation(operation)) {
    return null;
  }
  if (params.resultText.startsWith(CRESTODIAN_APPROVAL_MISMATCH_PREFIX)) {
    return { proposal: undefined };
  }
  if (params.resultText.startsWith(CRESTODIAN_NEEDS_APPROVAL_PREFIX)) {
    const markerLine = params.resultText.split("\n", 1)[0] ?? "";
    const carriedHash = markerLine.slice(CRESTODIAN_NEEDS_APPROVAL_PREFIX.length).trim();
    return {
      proposal: /^[a-f0-9]{64}$/.test(carriedHash)
        ? carriedHash
        : hashCrestodianOperation(operation),
    };
  }
  // Executed or errored mutation: an armed approval is single-use either way.
  return { proposal: undefined };
}

const CRESTODIAN_TOOL_ACTIONS = [
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
  // Interactive handoffs executed by the hosting chat after this turn.
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
  "doctor_fix",
] as const;

const CrestodianToolSchema = Type.Object({
  action: stringEnum([...CRESTODIAN_TOOL_ACTIONS]),
  path: Type.Optional(Type.String({ description: "Config path for config_* actions" })),
  value: Type.Optional(Type.String({ description: "Value for config_set (JSON5 or string)" })),
  envVar: Type.Optional(Type.String({ description: "Env var name for config_set_ref" })),
  model: Type.Optional(Type.String({ description: "provider/model ref" })),
  inferenceRoutes: Type.Optional(
    Type.Array(
      Type.Object({
        kind: stringEnum([...CRESTODIAN_SETUP_INFERENCE_KINDS]),
        model: Type.String({ description: "Exact provider/model ref for this route" }),
      }),
      {
        description:
          "Ordered detected inference routes from a host-seeded setup proposal; copy them exactly when reshaping that proposal.",
      },
    ),
  ),
  workspace: Type.Optional(Type.String({ description: "Workspace directory" })),
  agentId: Type.Optional(Type.String({ description: "Agent id for create_agent/open_agent" })),
  channel: Type.Optional(
    Type.String({
      description: "Channel id for connect_channel, channel_info, or open_setup channels",
    }),
  ),
  target: Type.Optional(
    stringEnum(["guided", "classic", "channels"], {
      description: "Setup wizard target for open_setup (defaults to guided)",
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
      throw new Error(`crestodian operation exited with code ${String(code)}`);
    },
    read: () => lines.join("\n").trim(),
  };
}

function requireParam(params: Record<string, unknown>, name: string): string {
  const value = readStringParam(params, name);
  if (!value?.trim()) {
    throw new ToolInputError(`crestodian: "${name}" is required for this action`);
  }
  return value.trim();
}

function readSetupTarget(params: Record<string, unknown>): "guided" | "classic" | "channels" {
  const target = readStringParam(params, "target")?.trim() ?? "guided";
  if (target === "guided" || target === "classic" || target === "channels") {
    return target;
  }
  throw new ToolInputError(`crestodian: unknown setup target "${target}"`);
}

function readSetupInferenceRoutes(
  params: Record<string, unknown>,
): CrestodianSetupInferenceRoute[] | undefined {
  const value = params.inferenceRoutes;
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new ToolInputError('crestodian: "inferenceRoutes" must be an array');
  }
  const allowed = new Set<string>(CRESTODIAN_SETUP_INFERENCE_KINDS);
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new ToolInputError("crestodian: every inference route needs kind and model fields");
    }
    const kind = (entry as { kind?: unknown }).kind;
    const model = (entry as { model?: unknown }).model;
    if (typeof kind !== "string" || !allowed.has(kind)) {
      throw new ToolInputError(`crestodian: unknown inference route "${String(kind)}"`);
    }
    if (typeof model !== "string" || !model.trim()) {
      throw new ToolInputError("crestodian: every inference route needs a model");
    }
    return { kind, model: model.trim() } as CrestodianSetupInferenceRoute;
  });
}

function operationForAction(params: Record<string, unknown>): CrestodianOperation {
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
    case "doctor_fix":
      return { kind: "doctor-fix" };
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
    case "plugin_install":
      return { kind: "plugin-install", spec: requireParam(params, "spec") };
    case "plugin_uninstall":
      return { kind: "plugin-uninstall", pluginId: requireParam(params, "pluginId") };
    case "setup": {
      const workspace = readStringParam(params, "workspace")?.trim();
      const model = readStringParam(params, "model")?.trim();
      const inferenceRoutes = readSetupInferenceRoutes(params);
      try {
        validateCrestodianSetupInferenceSelection({
          ...(model ? { model } : {}),
          ...(inferenceRoutes ? { inferenceRoutes } : {}),
        });
      } catch (error) {
        throw new ToolInputError(error instanceof Error ? error.message : String(error));
      }
      return {
        kind: "setup",
        ...(workspace ? { workspace } : {}),
        ...(model ? { model } : {}),
        ...(inferenceRoutes ? { inferenceRoutes } : {}),
      };
    }
    case "set_default_model":
      return { kind: "set-default-model", model: requireParam(params, "model") };
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
      throw new ToolInputError(`crestodian: unknown action "${action}"`);
  }
}

/** Validate openclaw.json after a write so the agent can fix mistakes in-loop. */
async function verifyConfigAfterToolWrite(): Promise<string | null> {
  try {
    const { readConfigFileSnapshot } = await import("../../config/config.js");
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.exists || snapshot.valid) {
      return null;
    }
    const issues = (snapshot.issues ?? []).map(
      (issue: { path?: string; message: string }) =>
        `${issue.path ? `${issue.path}: ` : ""}${issue.message}`,
    );
    return [
      "CONFIG INVALID after this write — fix it before doing anything else:",
      ...(issues.length > 0 ? issues : ["unknown validation failure"]),
    ].join("\n");
  } catch {
    return null;
  }
}

export function createCrestodianTool(options: CrestodianToolOptions): AnyAgentTool {
  return {
    name: "crestodian",
    label: "Crestodian",
    description: [
      "Ring-zero OpenClaw setup and repair. Read actions (status/models/agents/channels/channel_info/config_get/config_schema/gateway_status/plugin_search/validate_config/doctor/audit) run immediately.",
      "connect_channel(channel) starts guided channel setup in this chat; configure_model_provider starts masked provider/default-model setup; open_agent hands off to the normal agent; open_setup hands off to a menu wizard. All run immediately.",
      "Mutating actions (setup/set_default_model/config_set/config_set_ref/create_agent/gateway_*/plugin_install/plugin_uninstall/doctor_fix) REQUIRE approved=true, which you may only set after the user clearly agreed to that exact change in this conversation.",
      "For a host-seeded setup proposal, copy its inferenceRoutes array exactly into the setup call unless the user explicitly chooses a different model.",
      "Before writing an unfamiliar config path, call config_schema for it — the schema is the source of truth. Secrets go through config_set_ref (env var), never plaintext echoes.",
      "Every applied write is validated; if the result reports CONFIG INVALID, fix it immediately. All writes are audited.",
    ].join(" "),
    parameters: CrestodianToolSchema,
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const operation = operationForAction(params);
      const directive = directiveForOperation(operation);
      if (directive) {
        // Not a write: the host chat performs the interactive handoff after
        // this turn (the wizard itself collects explicit user answers).
        if (options.directiveRef) {
          options.directiveRef.current = directive;
        }
        return textResult(
          directive.kind === "channel-setup"
            ? `${CRESTODIAN_DIRECTIVE_PREFIX} the host chat now starts the guided ${directive.channel} setup with the user. Tell the user the setup questions come next; do not describe steps yourself.`
            : directive.kind === "model-setup"
              ? `${CRESTODIAN_DIRECTIVE_PREFIX} the host now starts masked model-provider setup. Tell the user the provider questions come next; do not ask for credentials yourself.`
              : directive.kind === "open-tui"
                ? `${CRESTODIAN_DIRECTIVE_PREFIX} the host now hands the user over to their normal agent. Say goodbye briefly.`
                : `${CRESTODIAN_DIRECTIVE_PREFIX} the host now opens the ${directive.target} setup wizard. Tell the user the menu wizard comes next.`,
          {},
        );
      }
      const persistent = isPersistentCrestodianOperation(operation);
      if (persistent) {
        let setupProposalDetail = "";
        if (
          operation.kind === "setup" &&
          operation.inferenceRoutes === undefined &&
          options.approvalArmed !== true
        ) {
          // Setup detection is part of the proposal, not the later approval.
          // Preview mutates this operation with the exact randomized routes so
          // the hash and the model's retry both bind to the same transaction.
          const preview = createCaptureRuntime();
          await executeCrestodianOperation(operation, preview, {
            approved: false,
            deps: { setupSurface: options.surface },
          });
          const retryArgs = {
            action: "setup",
            ...(operation.workspace ? { workspace: operation.workspace } : {}),
            ...(operation.model ? { model: operation.model } : {}),
            ...(operation.inferenceRoutes !== undefined
              ? { inferenceRoutes: operation.inferenceRoutes }
              : {}),
            approved: true,
          };
          setupProposalDetail = `${preview.read()}\nAfter the user approves, retry with these exact tool arguments: ${JSON.stringify(retryArgs)}\n`;
        }
        const operationHash = hashCrestodianOperation(operation);
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
            }
            return textResult(
              `${CRESTODIAN_APPROVAL_MISMATCH_PREFIX} this call is not the operation the user approved. The approval is void; describe the new change and get a fresh yes before retrying.`,
              { needsApproval: true },
            );
          }
          if (options.proposalRef) {
            options.proposalRef.current = operationHash;
          }
          return textResult(
            `${CRESTODIAN_NEEDS_APPROVAL_PREFIX}${operationHash}\n${setupProposalDetail}This action changes state. The proposal is registered; describe this exact change and ask the user to reply yes (their approval unlocks THIS action only — then retry the exact registered operation with approved=true).`,
            { needsApproval: true },
          );
        }
        if (options.proposalRef) {
          // One approval, one mutation: re-proposals need a fresh yes.
          options.proposalRef.current = undefined;
        }
      }
      const capture = createCaptureRuntime();
      let applied: boolean;
      try {
        const result = await executeCrestodianOperation(operation, capture, {
          approved: persistent,
          deps: { setupSurface: options.surface },
          auditDetails: { via: "crestodian-agent-tool" },
        });
        applied = result.applied;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResult([capture.read(), `error: ${message}`].filter(Boolean).join("\n"), {
          error: true,
        });
      }
      const verify = applied ? await verifyConfigAfterToolWrite() : null;
      return textResult(
        [capture.read() || "done", verify].filter(Boolean).join("\n\n"),
        verify ? { configInvalid: true } : {},
      );
    },
  };
}
