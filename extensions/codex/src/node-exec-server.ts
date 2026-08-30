/** Declares the explicitly approved, lazily loaded node-backed Codex exec-server. */
import type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
} from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const CODEX_NODE_EXEC_SERVER_COMMAND = "codex.exec-server.stdio.v1";

const CODEX_NODE_EXEC_SERVER_CAPABILITY = "codex.exec-server";

function parseCodexNodePlacementWorkspace(value: unknown) {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 5 ||
    typeof value.cwd !== "string" ||
    !value.cwd.trim() ||
    value.cwd.includes("\0") ||
    typeof value.environmentId !== "string" ||
    typeof value.sessionId !== "string" ||
    ![value.environmentId, value.sessionId].every(
      (identifier) =>
        identifier.length > 0 &&
        identifier.length <= 256 &&
        identifier.trim() === identifier &&
        !identifier.includes("\0"),
    ) ||
    typeof value.sessionKey !== "string" ||
    !value.sessionKey ||
    value.sessionKey.trim() !== value.sessionKey ||
    value.sessionKey.includes("\0") ||
    typeof value.ownerEpoch !== "number" ||
    !Number.isSafeInteger(value.ownerEpoch) ||
    value.ownerEpoch < 1
  ) {
    throw new Error("Codex node exec-server requires an exact managed placement workspace.");
  }
  return {
    cwd: value.cwd,
    environmentId: value.environmentId,
    sessionId: value.sessionId,
    ownerEpoch: value.ownerEpoch,
    sessionKey: value.sessionKey,
  };
}

/** Registers the exact pinned exec-server as an explicitly approved duplex node command. */
export function createCodexNodeExecServerCommand(): OpenClawPluginNodeHostCommand {
  const activeProcesses = new Set<() => Promise<void>>();
  return {
    command: CODEX_NODE_EXEC_SERVER_COMMAND,
    cap: CODEX_NODE_EXEC_SERVER_CAPABILITY,
    dangerous: true,
    duplex: true,
    onDisconnect: async () => {
      await Promise.all([...activeProcesses].map(async (terminate) => await terminate()));
    },
    handle: async (paramsJSON, io, context) => {
      if (!io?.frames) {
        throw new Error("Codex node exec-server requires duplex frames.");
      }
      let request: unknown;
      try {
        request = JSON.parse(paramsJSON ?? "null") as unknown;
      } catch {
        throw new Error("Codex node exec-server requires a valid workspace request.");
      }
      if (
        !isRecord(request) ||
        Object.keys(request).length !== 2 ||
        (request.authorization !== "human-approved" && request.authorization !== "session-full")
      ) {
        throw new Error(
          "Codex node exec-server requires an authorized managed placement workspace launch.",
        );
      }
      const placement = parseCodexNodePlacementWorkspace(request.placement);
      if (
        !context?.acquireManagedWorkspace ||
        context.sessionKey !== placement.sessionKey ||
        io.signal.aborted
      ) {
        throw new Error("Codex node exec-server requires active managed placement authority.");
      }
      const workspace = context.acquireManagedWorkspace({
        workspaceDir: placement.cwd,
        environmentId: placement.environmentId,
        sessionId: placement.sessionId,
        ownerEpoch: placement.ownerEpoch,
        sessionKey: placement.sessionKey,
      });
      const frames = io.frames;
      let unsubscribe: (() => void) | undefined;
      try {
        if (!context.prepareExecAuthorization) {
          throw new Error(
            "Codex node execution requires node-local exec policy support; update the node.",
          );
        }
        const assertExecAuthorized = context.prepareExecAuthorization(request.authorization);
        const { runCodexNodeExecServer } = await import("./node-exec-server.runtime.js");
        return await runCodexNodeExecServer({
          workspaceDir: workspace.workspaceDir,
          io,
          activeProcesses,
          assertExecAuthorized,
          // Listener registration announces readiness, so the child must own it first.
          onFrameReceiver: (receiver) => {
            unsubscribe = frames.onMessage(receiver);
          },
        });
      } finally {
        try {
          unsubscribe?.();
        } finally {
          workspace.release();
        }
      }
    },
  };
}

/** Keeps node launch behind command opt-in and a live Full owner or human decision. */
export function createCodexNodeExecServerInvokePolicy(): OpenClawPluginNodeInvokePolicy {
  return {
    commands: [CODEX_NODE_EXEC_SERVER_COMMAND],
    dangerous: true,
    classifyRisk: () => ({ level: "high", family: CODEX_NODE_EXEC_SERVER_CAPABILITY }),
    handle: async (context) => {
      if (context.risk?.level !== "high") {
        return {
          ok: false,
          code: "CODEX_NODE_EXEC_APPROVAL_REQUIRED",
          message: "Codex node execution requires an available approval reviewer.",
        };
      }
      let placement: ReturnType<typeof parseCodexNodePlacementWorkspace>;
      try {
        placement = parseCodexNodePlacementWorkspace(context.params);
      } catch {
        return {
          ok: false,
          code: "CODEX_NODE_EXEC_WORKSPACE_INVALID",
          message: "Codex node execution requires an exact managed placement workspace.",
        };
      }
      const workspace = {
        workspaceDir: placement.cwd,
        environmentId: placement.environmentId,
        sessionId: placement.sessionId,
        ownerEpoch: placement.ownerEpoch,
        sessionKey: placement.sessionKey,
      };
      const fullLaunch = await context.invokeNodeWithSessionFull?.({
        workspace,
        createParams: () => ({ placement, authorization: "session-full" }),
      });
      if (fullLaunch) {
        return fullLaunch;
      }
      if (!context.approvals) {
        return {
          ok: false,
          code: "CODEX_NODE_EXEC_APPROVAL_REQUIRED",
          message: "Codex node execution requires an available approval reviewer.",
        };
      }
      const nodeName = context.node?.displayName ?? context.nodeId;
      const approval = await context.approvals.request({
        title: "Run Codex execution on node",
        // Keep the risk visible when the Gateway bounds a long workspace description.
        description: `Allows arbitrary processes and filesystem access across the node account, not only this workspace. ${nodeName}: ${placement.cwd}`,
        severity: "critical",
        allowedDecisions: ["allow-once"],
      });
      if (approval.decision !== "allow-once") {
        return {
          ok: false,
          code: "CODEX_NODE_EXEC_APPROVAL_DENIED",
          message: "Codex node execution requires one-time approval.",
        };
      }
      return await context.invokeNode({
        workspace,
        params: { placement, authorization: "human-approved" },
      });
    },
  };
}
