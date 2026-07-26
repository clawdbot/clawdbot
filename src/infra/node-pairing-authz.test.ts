// Covers scope requirements for node pairing approvals.
import { describe, expect, it } from "vitest";
import {
  NODE_BROWSER_PROXY_COMMAND,
  NODE_EXEC_APPROVALS_COMMANDS,
  NODE_FS_LIST_DIR_COMMAND,
  NODE_SYSTEM_RUN_COMMANDS,
  NODE_TERMINAL_UPLOAD_COMMAND,
  isAdminOnlyNodeInvokeCommand,
} from "./node-commands.js";
import { resolveNodePairApprovalScopes } from "./node-pairing-authz.js";

const ADMIN_ONLY_INVOKE_COMMANDS = [
  NODE_BROWSER_PROXY_COMMAND,
  NODE_FS_LIST_DIR_COMMAND,
  NODE_TERMINAL_UPLOAD_COMMAND,
] as const;

describe("resolveNodePairApprovalScopes", () => {
  it("requires operator.admin for system.run commands", () => {
    expect(resolveNodePairApprovalScopes(["system.run"])).toEqual([
      "operator.pairing",
      "operator.admin",
    ]);
  });

  it.each([...NODE_SYSTEM_RUN_COMMANDS, ...ADMIN_ONLY_INVOKE_COMMANDS])(
    "requires operator.admin for %s commands",
    (command) => {
      expect(resolveNodePairApprovalScopes([command])).toEqual([
        "operator.pairing",
        "operator.admin",
      ]);
    },
  );

  it.each(ADMIN_ONLY_INVOKE_COMMANDS)("classifies %s as admin-only at invocation", (command) => {
    expect(isAdminOnlyNodeInvokeCommand(command)).toBe(true);
  });

  it("keeps dedicated exec-approval commands admin-gated at pairing", () => {
    for (const command of NODE_EXEC_APPROVALS_COMMANDS) {
      expect(resolveNodePairApprovalScopes([command])).toEqual([
        "operator.pairing",
        "operator.admin",
      ]);
    }
  });

  it("requires operator.admin when any command is admin-gated", () => {
    expect(resolveNodePairApprovalScopes(["canvas.present", "fs.listDir"])).toEqual([
      "operator.pairing",
      "operator.admin",
    ]);
  });

  it("requires operator.write for non-exec commands", () => {
    expect(resolveNodePairApprovalScopes(["canvas.present"])).toEqual([
      "operator.pairing",
      "operator.write",
    ]);
  });

  it("treats computer.act pairing approval as non-exec surface approval", () => {
    expect(resolveNodePairApprovalScopes(["computer.act"])).toEqual([
      "operator.pairing",
      "operator.write",
    ]);
  });

  it("requires only operator.pairing without commands", () => {
    expect(resolveNodePairApprovalScopes(undefined)).toEqual(["operator.pairing"]);
    expect(resolveNodePairApprovalScopes([])).toEqual(["operator.pairing"]);
  });
});
