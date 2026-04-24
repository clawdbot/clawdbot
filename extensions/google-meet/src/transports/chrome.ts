import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import type { GoogleMeetConfig } from "../config.js";
import {
  startNodeRealtimeAudioBridge,
  type ChromeNodeRealtimeAudioBridgeHandle,
} from "../realtime-node.js";
import {
  startCommandRealtimeAudioBridge,
  type ChromeRealtimeAudioBridgeHandle,
} from "../realtime.js";

export const GOOGLE_MEET_SYSTEM_PROFILER_COMMAND = "/usr/sbin/system_profiler";

export function outputMentionsBlackHole2ch(output: string): boolean {
  return /\bBlackHole\s+2ch\b/i.test(output);
}

export async function assertBlackHole2chAvailable(params: {
  runtime: PluginRuntime;
  timeoutMs: number;
}): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Chrome Meet transport with blackhole-2ch audio is currently macOS-only");
  }

  const result = await params.runtime.system.runCommandWithTimeout(
    [GOOGLE_MEET_SYSTEM_PROFILER_COMMAND, "SPAudioDataType"],
    { timeoutMs: params.timeoutMs },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.code !== 0 || !outputMentionsBlackHole2ch(output)) {
    const hint =
      params.runtime.system.formatNativeDependencyHint?.({
        packageName: "BlackHole 2ch",
        downloadCommand: "brew install blackhole-2ch",
      }) ?? "";
    throw new Error(
      [
        "BlackHole 2ch audio device not found.",
        "Install BlackHole 2ch and route Chrome input/output through the OpenClaw audio bridge.",
        hint,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
}

export async function launchChromeMeet(params: {
  runtime: PluginRuntime;
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  meetingSessionId: string;
  mode: "realtime" | "transcribe";
  url: string;
  logger: RuntimeLogger;
}): Promise<{
  launched: boolean;
  audioBridge?:
    | { type: "external-command" }
    | ({ type: "command-pair" } & ChromeRealtimeAudioBridgeHandle);
}> {
  await assertBlackHole2chAvailable({
    runtime: params.runtime,
    timeoutMs: Math.min(params.config.chrome.joinTimeoutMs, 10_000),
  });

  if (params.config.chrome.audioBridgeHealthCommand) {
    const health = await params.runtime.system.runCommandWithTimeout(
      params.config.chrome.audioBridgeHealthCommand,
      { timeoutMs: params.config.chrome.joinTimeoutMs },
    );
    if (health.code !== 0) {
      throw new Error(
        `Chrome audio bridge health check failed: ${health.stderr || health.stdout || health.code}`,
      );
    }
  }

  let audioBridge:
    | { type: "external-command" }
    | ({ type: "command-pair" } & ChromeRealtimeAudioBridgeHandle)
    | undefined;

  if (params.config.chrome.audioBridgeCommand) {
    const bridge = await params.runtime.system.runCommandWithTimeout(
      params.config.chrome.audioBridgeCommand,
      { timeoutMs: params.config.chrome.joinTimeoutMs },
    );
    if (bridge.code !== 0) {
      throw new Error(
        `failed to start Chrome audio bridge: ${bridge.stderr || bridge.stdout || bridge.code}`,
      );
    }
    audioBridge = { type: "external-command" };
  } else if (params.mode === "realtime") {
    if (!params.config.chrome.audioInputCommand || !params.config.chrome.audioOutputCommand) {
      throw new Error(
        "Chrome realtime mode requires chrome.audioInputCommand and chrome.audioOutputCommand, or chrome.audioBridgeCommand for an external bridge.",
      );
    }
    audioBridge = {
      type: "command-pair",
      ...(await startCommandRealtimeAudioBridge({
        config: params.config,
        fullConfig: params.fullConfig,
        runtime: params.runtime,
        meetingSessionId: params.meetingSessionId,
        inputCommand: params.config.chrome.audioInputCommand,
        outputCommand: params.config.chrome.audioOutputCommand,
        logger: params.logger,
      })),
    };
  }

  if (!params.config.chrome.launch) {
    return { launched: false, audioBridge };
  }

  const argv = ["open", "-a", "Google Chrome"];
  if (params.config.chrome.browserProfile) {
    argv.push("--args", `--profile-directory=${params.config.chrome.browserProfile}`);
  }
  argv.push(params.url);

  let commandPairBridgeStopped = false;
  const stopCommandPairBridge = async () => {
    if (commandPairBridgeStopped) {
      return;
    }
    commandPairBridgeStopped = true;
    if (audioBridge?.type === "command-pair") {
      await audioBridge.stop();
    }
  };

  try {
    const result = await params.runtime.system.runCommandWithTimeout(argv, {
      timeoutMs: params.config.chrome.joinTimeoutMs,
    });
    if (result.code === 0) {
      return { launched: true, audioBridge };
    }
    await stopCommandPairBridge();
    throw new Error(
      `failed to launch Chrome for Meet: ${result.stderr || result.stdout || result.code}`,
    );
  } catch (error) {
    await stopCommandPairBridge();
    throw error;
  }
}

function isGoogleMeetNode(node: {
  commands?: string[];
  connected?: boolean;
  nodeId?: string;
  displayName?: string;
  remoteIp?: string;
}) {
  return (
    node.connected === true &&
    Array.isArray(node.commands) &&
    node.commands.includes("googlemeet.chrome")
  );
}

async function resolveChromeNode(params: {
  runtime: PluginRuntime;
  requestedNode?: string;
}): Promise<string> {
  const list = await params.runtime.nodes.list({ connected: true });
  const nodes = list.nodes.filter(isGoogleMeetNode);
  if (nodes.length === 0) {
    throw new Error(
      "No connected Google Meet-capable node. Run `openclaw node run` on the Chrome host and approve pairing.",
    );
  }
  const requested = params.requestedNode?.trim();
  if (requested) {
    const matches = nodes.filter((node) =>
      [node.nodeId, node.displayName, node.remoteIp].some((value) => value === requested),
    );
    if (matches.length === 1) {
      return matches[0].nodeId;
    }
    throw new Error(`Google Meet node not found or ambiguous: ${requested}`);
  }
  if (nodes.length === 1) {
    return nodes[0].nodeId;
  }
  throw new Error(
    "Multiple Google Meet-capable nodes connected. Set plugins.entries.google-meet.config.chromeNode.node.",
  );
}

function parseNodeStartResult(raw: unknown): {
  launched?: boolean;
  bridgeId?: string;
  audioBridge?: { type?: string };
} {
  const value =
    raw && typeof raw === "object" && "payload" in raw
      ? (raw as { payload?: unknown }).payload
      : raw;
  if (!value || typeof value !== "object") {
    throw new Error("Google Meet node returned an invalid start result.");
  }
  return value as {
    launched?: boolean;
    bridgeId?: string;
    audioBridge?: { type?: string };
  };
}

export async function launchChromeMeetOnNode(params: {
  runtime: PluginRuntime;
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  meetingSessionId: string;
  mode: "realtime" | "transcribe";
  url: string;
  logger: RuntimeLogger;
}): Promise<{
  nodeId: string;
  launched: boolean;
  audioBridge?:
    | { type: "external-command" }
    | ({ type: "node-command-pair" } & ChromeNodeRealtimeAudioBridgeHandle);
}> {
  const nodeId = await resolveChromeNode({
    runtime: params.runtime,
    requestedNode: params.config.chromeNode.node,
  });
  const raw = await params.runtime.nodes.invoke({
    nodeId,
    command: "googlemeet.chrome",
    params: {
      action: "start",
      url: params.url,
      mode: params.mode,
      launch: params.config.chrome.launch,
      browserProfile: params.config.chrome.browserProfile,
      joinTimeoutMs: params.config.chrome.joinTimeoutMs,
      audioInputCommand: params.config.chrome.audioInputCommand,
      audioOutputCommand: params.config.chrome.audioOutputCommand,
      audioBridgeCommand: params.config.chrome.audioBridgeCommand,
      audioBridgeHealthCommand: params.config.chrome.audioBridgeHealthCommand,
    },
    timeoutMs: params.config.chrome.joinTimeoutMs + 5_000,
  });
  const result = parseNodeStartResult(raw);
  if (result.audioBridge?.type === "node-command-pair") {
    if (!result.bridgeId) {
      throw new Error("Google Meet node did not return an audio bridge id.");
    }
    const bridge = await startNodeRealtimeAudioBridge({
      config: params.config,
      fullConfig: params.fullConfig,
      runtime: params.runtime,
      meetingSessionId: params.meetingSessionId,
      nodeId,
      bridgeId: result.bridgeId,
      logger: params.logger,
    });
    return {
      nodeId,
      launched: result.launched === true,
      audioBridge: bridge,
    };
  }
  if (result.audioBridge?.type === "external-command") {
    return {
      nodeId,
      launched: result.launched === true,
      audioBridge: { type: "external-command" },
    };
  }
  return { nodeId, launched: result.launched === true };
}
