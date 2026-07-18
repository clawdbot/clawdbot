import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  addMeetingSetupCheck,
  createMeetingSetupStatus,
  resolveMeetingBrowserNodeInfo,
  type MeetingSetupStatus,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { TeamsMeetingsConfig, TeamsMeetingsMode, TeamsMeetingsTransport } from "./config.js";
import { assertBlackHole2chAvailable } from "./transports/chrome.js";
import { TEAMS_MEETINGS_BROWSER_NODE_ADAPTER } from "./transports/teams-meetings-platform-constants.js";

function audioCommands(config: TeamsMeetingsConfig): string[] {
  return uniqueStrings(
    [
      config.chrome.audioInputCommand[0],
      config.chrome.audioOutputCommand[0],
      config.chrome.bargeInInputCommand?.[0],
    ].filter((value): value is string => Boolean(value?.trim())),
  );
}

async function commandExists(runtime: PluginRuntime, command: string): Promise<boolean> {
  const result = await runtime.system.runCommandWithTimeout(
    ["/bin/sh", "-lc", 'command -v "$1" >/dev/null 2>&1', "sh", command],
    { timeoutMs: 5_000 },
  );
  return result.code === 0;
}

export async function getTeamsMeetingsSetupStatus(params: {
  config: TeamsMeetingsConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  options?: { mode?: TeamsMeetingsMode; transport?: TeamsMeetingsTransport };
}): Promise<MeetingSetupStatus> {
  const mode = params.options?.mode ?? params.config.defaultMode;
  const transport =
    params.options?.transport ?? (params.config.chromeNode.node ? "chrome-node" : "chrome");
  const talkBack = mode === "agent" || mode === "bidi";
  let status = createMeetingSetupStatus([
    {
      id: "chrome-profile",
      ok: true,
      message: params.config.chrome.browserProfile
        ? `Chrome node profile configured: ${params.config.chrome.browserProfile}`
        : "Local Chrome uses the configured OpenClaw browser profile",
    },
    {
      id: "guest-join",
      ok: Boolean(
        params.config.chrome.guestName &&
        params.config.chrome.autoJoin &&
        params.config.chrome.reuseExistingTab,
      ),
      message:
        params.config.chrome.guestName &&
        params.config.chrome.autoJoin &&
        params.config.chrome.reuseExistingTab
          ? "Guest name, auto-join, and tab reuse are configured"
          : "Set chrome.guestName, chrome.autoJoin, and chrome.reuseExistingTab for unattended guest joins",
    },
    {
      id: "captions",
      ok: true,
      message:
        mode === "transcribe"
          ? "Teams caption scraping is disabled pending live selector validation; transcript snapshots are empty"
          : "Caption scraping is not used by talk-back modes",
    },
  ]);

  if (transport === "chrome-node") {
    try {
      const node = await resolveMeetingBrowserNodeInfo({
        runtime: params.runtime,
        requestedNode: params.config.chromeNode.node,
        adapter: TEAMS_MEETINGS_BROWSER_NODE_ADAPTER,
      });
      status = addMeetingSetupCheck(status, {
        id: "chrome-node-connected",
        ok: true,
        message: `Connected Teams meeting node ready: ${node.displayName ?? node.remoteIp ?? node.nodeId}`,
      });
      if (talkBack) {
        if (!node.nodeId) {
          throw new Error("Connected Microsoft Teams meetings node did not include a node id.");
        }
        await params.runtime.nodes.invoke({
          nodeId: node.nodeId,
          command: TEAMS_MEETINGS_BROWSER_NODE_ADAPTER.nodeCommandName,
          params: {
            action: "setup",
            audioInputCommand: params.config.chrome.audioInputCommand,
            audioOutputCommand: params.config.chrome.audioOutputCommand,
            ...(params.config.chrome.bargeInInputCommand
              ? { bargeInInputCommand: params.config.chrome.bargeInInputCommand }
              : {}),
          },
          timeoutMs: 12_000,
        });
        status = addMeetingSetupCheck(status, {
          id: "chrome-node-audio-prerequisites",
          ok: true,
          message: "Remote macOS, BlackHole 2ch, and SoX prerequisites are ready",
        });
      }
    } catch (error) {
      const connected = status.checks.some(
        (check) => check.id === "chrome-node-connected" && check.ok,
      );
      status = addMeetingSetupCheck(status, {
        id: connected ? "chrome-node-audio-prerequisites" : "chrome-node-connected",
        ok: false,
        message: formatErrorMessage(error),
      });
    }
  }

  if (!talkBack) {
    return status;
  }
  status = addMeetingSetupCheck(status, {
    id: "audio-bridge",
    ok:
      params.config.chrome.audioInputCommand.length > 0 &&
      params.config.chrome.audioOutputCommand.length > 0,
    message: `SoX command-pair audio bridge configured (${params.config.chrome.audioFormat})`,
  });
  if (transport === "chrome-node") {
    return status;
  }
  try {
    await assertBlackHole2chAvailable({
      runtime: params.runtime,
      timeoutMs: Math.min(params.config.chrome.joinTimeoutMs, 10_000),
    });
    status = addMeetingSetupCheck(status, {
      id: "chrome-local-audio-device",
      ok: true,
      message: "BlackHole 2ch audio device found",
    });
  } catch (error) {
    status = addMeetingSetupCheck(status, {
      id: "chrome-local-audio-device",
      ok: false,
      message: formatErrorMessage(error),
    });
  }
  const missing: string[] = [];
  for (const command of audioCommands(params.config)) {
    if (!(await commandExists(params.runtime, command).catch(() => false))) {
      missing.push(command);
    }
  }
  return addMeetingSetupCheck(status, {
    id: "chrome-local-audio-commands",
    ok: missing.length === 0,
    message:
      missing.length === 0
        ? "Configured Chrome audio commands are available"
        : `Chrome audio commands missing: ${missing.join(", ")}`,
  });
}
