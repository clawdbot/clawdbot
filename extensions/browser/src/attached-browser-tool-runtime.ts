/**
 * Attach-only Browser tool runtime for a caller-owned loopback Chrome process.
 *
 * The bridge owns only authenticated Browser HTTP ingress. Chrome remains owned
 * by the caller and survives bridge disposal.
 */
import { randomBytes } from "node:crypto";
import { chmod, copyFile } from "node:fs/promises";
import path from "node:path";
import { createBrowserTool } from "./browser-tool.js";
import type { AnyAgentTool } from "./browser-tool.runtime.js";
import { startBrowserBridgeServer, stopBrowserBridgeServer } from "./browser/bridge-server.js";
import { resolveBrowserConfig } from "./browser/config.js";
import { closePlaywrightBrowserConnection } from "./browser/pw-session.js";
import { writeExternalFileWithinRoot } from "./sdk-security-runtime.js";

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
  workspaceDir: string;
};

async function persistAttachedScreenshot(params: {
  sourcePath: string;
  workspaceDir: string;
  type: "png" | "jpeg";
}): Promise<string> {
  const extension = params.type === "jpeg" ? "jpg" : "png";
  const fileName = `screenshot-${randomBytes(8).toString("hex")}.${extension}`;
  const result = await writeExternalFileWithinRoot({
    rootDir: params.workspaceDir,
    path: path.join(".artifacts", "cloud-worker-browser", fileName),
    fallbackFileName: fileName,
    write: async (stagedPath) => {
      await copyFile(params.sourcePath, stagedPath);
      await chmod(stagedPath, 0o600);
    },
  });
  return result.path;
}

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
  const dispose = async () => {
    try {
      await stopBrowserBridgeServer(bridge.server);
    } finally {
      await closePlaywrightBrowserConnection({ cdpUrl });
    }
  };
  try {
    const tool = createBrowserTool({
      sandboxBridgeUrl: bridge.baseUrl,
      allowHostControl: false,
      ...(params.agentSessionKey !== undefined ? { agentSessionKey: params.agentSessionKey } : {}),
      ...(params.agentDir !== undefined ? { agentDir: params.agentDir } : {}),
      ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
      // Worker transcript frames are bounded and inference is Gateway-proxied.
      // Persist proof in the managed workspace, then return only a bounded receipt.
      screenshotResultMode: "path",
      persistScreenshot: async ({ sourcePath, type }) =>
        await persistAttachedScreenshot({
          sourcePath,
          workspaceDir: params.workspaceDir,
          type,
        }),
    });
    return {
      tool,
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
