import { randomUUID } from "node:crypto";
import { selectDefaultNodeFromList } from "openclaw/plugin-sdk/agent-harness-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";

const REQUIRED_WIDGET_COMMANDS = ["canvas.present", "canvas.navigate"] as const;
const DEFAULT_CANVAS_NODE_INVOKE_TIMEOUT_MS = 30_000;

type CanvasRuntimeNode = Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>["nodes"][number];
type WidgetPresenter = Parameters<OpenClawPluginApi["registerWidgetPresenter"]>[0];

function isEligibleCanvasNode(node: CanvasRuntimeNode): boolean {
  const commands = node.invocableCommands ?? node.commands ?? [];
  const hasCanvasCapability =
    node.caps?.includes("canvas") === true ||
    commands.some((command) => command.startsWith("canvas."));
  return (
    // macOS is the only panel whose resolver handles hosted document paths;
    // other platforms' Canvas surfaces are being retired.
    node.platform === "macos" &&
    node.connected === true &&
    hasCanvasCapability &&
    REQUIRED_WIDGET_COMMANDS.every((command) => commands.includes(command))
  );
}

async function selectCanvasNode(
  nodesRuntime: PluginRuntime["nodes"],
): Promise<CanvasRuntimeNode | null> {
  const { nodes } = await nodesRuntime.list({ connected: true });
  return selectDefaultNodeFromList(nodes.filter(isEligibleCanvasNode), {
    capability: "canvas",
    fallback: "first",
    preferLocalMac: true,
  });
}

/** Creates the Canvas-owned presenter for hosted widget documents. */
export function createCanvasWidgetPresenter(nodesRuntime: PluginRuntime["nodes"]): WidgetPresenter {
  return {
    target: "node_panel",
    description: "Show on a connected device panel",
    async availability() {
      try {
        const node = await selectCanvasNode(nodesRuntime);
        return node
          ? { ok: true, value: { available: true } }
          : {
              ok: false,
              error: {
                code: "no_eligible_node",
                message: "No connected canvas-capable device is available.",
              },
            };
      } catch (error) {
        return {
          ok: false,
          error: { code: "node_error", message: formatErrorMessage(error) },
        };
      }
    },
    async present({ documentUrlPath, sessionContext }) {
      let node: CanvasRuntimeNode | null;
      try {
        node = await selectCanvasNode(nodesRuntime);
      } catch (error) {
        return {
          ok: false,
          error: { code: "node_error", message: formatErrorMessage(error) },
        };
      }
      if (!node) {
        return {
          ok: false,
          error: {
            code: "no_eligible_node",
            message: "No connected canvas-capable device is available.",
          },
        };
      }
      try {
        const invoke = (command: string, params?: Record<string, unknown>) =>
          nodesRuntime.invoke({
            nodeId: node.nodeId,
            command,
            params,
            timeoutMs: DEFAULT_CANVAS_NODE_INVOKE_TIMEOUT_MS,
            idempotencyKey: randomUUID(),
            ...(sessionContext.sessionKey ? { sessionKey: sessionContext.sessionKey } : {}),
          });
        await invoke("canvas.present", {});
        await invoke("canvas.navigate", { url: documentUrlPath });
        return {
          ok: true,
          value: {
            nodeId: node.nodeId,
            ...(node.displayName ? { nodeName: node.displayName } : {}),
          },
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "node_error",
            message: formatErrorMessage(error),
            nodeId: node.nodeId,
          },
        };
      }
    },
  };
}
