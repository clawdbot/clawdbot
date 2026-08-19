import {
  parseComputerActParamsJSON,
  type ComputerActParams,
} from "openclaw/plugin-sdk/computer-use";
import type {
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginNodeInvokePolicyContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const COMPUTER_ACT_COMMAND = "computer.act";

const HIGH_RISK_FAMILIES = new Map<
  ComputerActParams["action"],
  NonNullable<OpenClawPluginNodeInvokePolicyContext["risk"]>["family"]
>([
  ["kill_app", "process_termination"],
  ["browser_navigate", "browser_navigation"],
  ["browser_download", "browser_download"],
  ["browser_set_input_files", "browser_file_input"],
  ["start_recording", "recording_start"],
  ["replay_trajectory", "recording_replay"],
  ["escalate_scope", "desktop_scope_escalation"],
]);

const OBSERVATION_ACTIONS = new Set<ComputerActParams["action"]>([
  "list_apps",
  "list_windows",
  "get_accessibility_tree",
  "get_cursor_position",
  "get_window_state",
  "get_browser_state",
  "get_recording_state",
]);

function classifyCuaComputerActRisk(
  params: unknown,
): NonNullable<OpenClawPluginNodeInvokePolicyContext["risk"]> {
  // Node-host owns the exact close envelope. This internal action never enters
  // the model schema, but it still traverses the same classified policy seam.
  if (isRecord(params) && params.action === "__close_execution") {
    return { level: "ordinary", family: "execution_lifecycle" };
  }
  const serialized = JSON.stringify(params);
  if (serialized === undefined) {
    throw new Error("computer action arguments are not serializable");
  }
  const parsed = parseComputerActParamsJSON(serialized);
  const highRiskFamily = HIGH_RISK_FAMILIES.get(parsed.action);
  if (highRiskFamily) {
    return { level: "high", family: highRiskFamily };
  }
  if (
    parsed.action === "browser_dialog" &&
    "dialogAction" in parsed &&
    parsed.dialogAction === "inspect"
  ) {
    return { level: "ordinary", family: "observation" };
  }
  return {
    level: "ordinary",
    family: OBSERVATION_ACTIONS.has(parsed.action) ? "observation" : "input",
  };
}

export function createCuaComputerNodeInvokePolicy(): OpenClawPluginNodeInvokePolicy {
  return {
    commands: [COMPUTER_ACT_COMMAND],
    dangerous: true,
    classifyRisk: ({ command, params }) => {
      if (command !== COMPUTER_ACT_COMMAND) {
        throw new Error("unsupported CUA Computer node command");
      }
      return classifyCuaComputerActRisk(params);
    },
    handle: async (context) => {
      if (!context.risk) {
        return {
          ok: false,
          code: "COMPUTER_RISK_UNCLASSIFIED",
          message: "computer.act arguments were not classified before dispatch",
        };
      }
      return await context.invokeNode();
    },
  };
}
