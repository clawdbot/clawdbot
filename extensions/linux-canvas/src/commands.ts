import type { OpenClawPluginNodeHostCommand } from "openclaw/plugin-sdk/plugin-entry";
import { LinuxCanvasIpcClient, type LinuxCanvasIpcTransport } from "./ipc-client.js";
import {
  linuxCanvasSocketExists,
  resolveLinuxCanvasSocketPath,
  watchLinuxCanvasSocket,
} from "./socket-path.js";

const AVAILABILITY_CACHE_MS = 250;
const AVAILABILITY_POLL_MS = 1_000;
const AGENT_REQUEST_MESSAGE_MAX_CHARS = 20_000;
const OWNERSHIP_COMMANDS = new Set<string>([
  "canvas.present",
  "canvas.navigate",
  "canvas.eval",
  "canvas.a2ui.push",
  "canvas.a2ui.pushJSONL",
  "canvas.a2ui.reset",
]);
const SESSIONLESS_OWNER_CLEAR_COMMANDS = new Set<string>([
  "canvas.navigate",
  "canvas.a2ui.push",
  "canvas.a2ui.pushJSONL",
  "canvas.a2ui.reset",
]);

const LINUX_CANVAS_COMMANDS = [
  "canvas.present",
  "canvas.hide",
  "canvas.navigate",
  "canvas.eval",
  "canvas.snapshot",
  "canvas.a2ui.push",
  "canvas.a2ui.pushJSONL",
  "canvas.a2ui.reset",
] as const;

export type LinuxCanvasCommandsOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  socketExists?: (socketPath: string) => boolean;
  watchSocket?: (socketPath: string, onChange: () => void) => () => void;
  transport?: LinuxCanvasIpcTransport;
};

type NodeHostEventContext = {
  sendNodeEvent(event: string, payload: unknown): Promise<unknown>;
  sessionKey?: string;
};

function cleanToken(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const cleaned = value.replaceAll(/[^a-zA-Z0-9._:-]/g, "").slice(0, 120);
  return cleaned || fallback;
}

function buildActionMessage(action: unknown, sessionKey?: string): string {
  const value =
    action && typeof action === "object" && !Array.isArray(action)
      ? (action as Record<string, unknown>)
      : {};
  const actionName = cleanToken(value.name, "unknown");
  const surface = cleanToken(value.surfaceId, "main");
  const component = cleanToken(value.sourceComponentId, "unknown");
  const context = value.context === undefined ? "" : ` ctx=${JSON.stringify(value.context)}`;
  const message = `CANVAS_A2UI action=${actionName} session=${cleanToken(sessionKey, "node")} surface=${surface} component=${component}${context} default=update_canvas`;
  if (message.length > AGENT_REQUEST_MESSAGE_MAX_CHARS) {
    throw new Error("Canvas action exceeds the Gateway agent message limit");
  }
  return message;
}

function bindActionRelay(
  transport: LinuxCanvasIpcTransport,
  getContext: () => NodeHostEventContext | undefined,
): void {
  transport.setActionHandler(async (event) => {
    try {
      const context = getContext();
      if (!context) {
        throw new Error("node host event relay unavailable");
      }
      await context.sendNodeEvent("agent.request", {
        message: buildActionMessage(event.action, context.sessionKey),
        ...(context.sessionKey ? { sessionKey: context.sessionKey } : {}),
        thinking: "low",
        deliver: false,
        key: event.id,
      });
      transport.sendActionResult(event.id, { ok: true });
    } catch (error) {
      transport.sendActionResult(event.id, { ok: false, error: String(error) });
    }
  });
}

export function createLinuxCanvasCommands(
  options: LinuxCanvasCommandsOptions = {},
): OpenClawPluginNodeHostCommand[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const socketPath = resolveLinuxCanvasSocketPath(env);
  const socketExists = options.socketExists ?? linuxCanvasSocketExists;
  const watchSocket = options.watchSocket ?? watchLinuxCanvasSocket;
  // One transport belongs to this process-wide plugin registration. Keeping it
  // open after an invoke lets later WebView actions use the same node connection.
  const transport = options.transport ?? new LinuxCanvasIpcClient(socketPath);
  let ownerContext: NodeHostEventContext | undefined;
  bindActionRelay(transport, () => ownerContext);
  let lastAvailabilityCheck = 0;
  let lastAvailable = false;
  const isAvailable = () => {
    if (platform !== "linux") {
      return false;
    }
    const now = Date.now();
    if (now - lastAvailabilityCheck >= AVAILABILITY_CACHE_MS) {
      lastAvailable = socketExists(socketPath);
      lastAvailabilityCheck = now;
    }
    return lastAvailable;
  };

  return LINUX_CANVAS_COMMANDS.map((command, index) => {
    const registration: OpenClawPluginNodeHostCommand = {
      command,
      cap: "canvas",
      dangerous: false,
      isAvailable,
      handle: async (paramsJSON, _io, context) => {
        if (platform !== "linux") {
          throw new Error("CANVAS_DISABLED: Linux canvas is only available on Linux");
        }
        if (!context) {
          throw new Error("CANVAS_UNAVAILABLE: node host event relay unavailable");
        }
        return await transport.request(command, paramsJSON ?? "{}", {
          onDispatch: () => {
            if (!OWNERSHIP_COMMANDS.has(command)) {
              return;
            }
            let clearSessionlessOwner = SESSIONLESS_OWNER_CLEAR_COMMANDS.has(command);
            if (command === "canvas.present" && !context.sessionKey) {
              try {
                const params = JSON.parse(paramsJSON ?? "{}") as { url?: unknown };
                clearSessionlessOwner = typeof params.url === "string";
              } catch {
                clearSessionlessOwner = false;
              }
            }
            if (!context.sessionKey && !clearSessionlessOwner) {
              return;
            }
            // Dispatch can mutate the WebView before returning an error. Commit
            // ownership now; rolling back would route visible controls elsewhere.
            ownerContext = context.sessionKey ? context : undefined;
          },
        });
      },
    };
    if (index === 0 && platform === "linux") {
      registration.watchAvailability = (_context, onChange) => {
        lastAvailabilityCheck = 0;
        let knownAvailable = isAvailable();
        const reconcile = () => {
          lastAvailabilityCheck = 0;
          const available = isAvailable();
          if (available === knownAvailable) {
            return;
          }
          knownAvailable = available;
          onChange();
        };
        const stopSocketWatch = watchSocket(socketPath, reconcile);
        // `/proc/net/unix` is the liveness source. Polling closes the crash
        // case where a listener disappears but leaves its pathname behind.
        const timer = setInterval(reconcile, AVAILABILITY_POLL_MS);
        timer.unref?.();
        return () => {
          clearInterval(timer);
          stopSocketWatch();
          transport.close();
        };
      };
    }
    return registration;
  });
}
