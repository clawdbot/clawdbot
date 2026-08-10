/**
 * Attach-only Browser tool runtime for a caller-owned loopback Chrome process.
 *
 * The bridge owns only authenticated Browser HTTP ingress. Chrome remains owned
 * by the caller and survives bridge disposal.
 */
import { randomBytes } from "node:crypto";
import { createBrowserTool } from "./browser-tool.js";
import type { AnyAgentTool } from "./browser-tool.runtime.js";
import { startBrowserBridgeServer, stopBrowserBridgeServer } from "./browser/bridge-server.js";
import { resolveBrowserConfig } from "./browser/config.js";

const ATTACHED_PROFILE_NAME = "worker";

export type AttachedBrowserToolRuntime = {
  tool: AnyAgentTool;
  dispose: () => Promise<void>;
};

export type CreateAttachedBrowserToolRuntimeParams = {
  cdpUrl: string;
  ensureAttachTarget: () => Promise<void>;
  agentSessionKey?: string;
  agentDir?: string;
  workspaceDir?: string;
  activeModel?: {
    provider?: string;
    model?: string;
  };
};

function normalizeAttachedCdpUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Attached Browser CDP URL must be a loopback HTTP URL with an explicit port.");
  }
  const port = Number(parsed.port);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port === "" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("Attached Browser CDP URL must be a loopback HTTP URL with an explicit port.");
  }
  return parsed.toString().replace(/\/$/u, "");
}

/** Create a normal Browser agent tool pinned to one raw, attach-only CDP profile. */
export async function createAttachedBrowserToolRuntime(
  params: CreateAttachedBrowserToolRuntimeParams,
): Promise<AttachedBrowserToolRuntime> {
  const cdpUrl = normalizeAttachedCdpUrl(params.cdpUrl);
  const resolved = resolveBrowserConfig({
    enabled: true,
    attachOnly: true,
    cdpUrl,
    defaultProfile: ATTACHED_PROFILE_NAME,
    profiles: {
      [ATTACHED_PROFILE_NAME]: {
        driver: "openclaw",
        attachOnly: true,
        cdpUrl,
      },
    },
  });

  // Config resolution adds normal host profiles. This runtime is deliberately
  // closed: exposing any of them would reintroduce MCP, extension, or managed
  // browser fallback paths into an attach-only worker turn.
  resolved.profiles = {
    [ATTACHED_PROFILE_NAME]: {
      driver: "openclaw",
      attachOnly: true,
      cdpUrl,
    },
  };
  resolved.extensionRelayPorts = {};
  resolved.extensionRelayInternalTokens = {};
  delete resolved.extensionRelayToken;

  const bridge = await startBrowserBridgeServer({
    resolved,
    host: "127.0.0.1",
    port: 0,
    authToken: randomBytes(32).toString("base64url"),
    onEnsureAttachTarget: async () => await params.ensureAttachTarget(),
  });
  try {
    const tool = createBrowserTool({
      sandboxBridgeUrl: bridge.baseUrl,
      allowHostControl: false,
      ...(params.agentSessionKey !== undefined ? { agentSessionKey: params.agentSessionKey } : {}),
      ...(params.agentDir !== undefined ? { agentDir: params.agentDir } : {}),
      ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
      ...(params.activeModel !== undefined ? { activeModel: params.activeModel } : {}),
    });
    return {
      tool,
      dispose: async () => await stopBrowserBridgeServer(bridge.server),
    };
  } catch (error) {
    await stopBrowserBridgeServer(bridge.server);
    throw error;
  }
}
