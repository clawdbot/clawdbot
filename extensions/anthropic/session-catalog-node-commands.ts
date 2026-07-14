import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  CLAUDE_SESSION_READ_COMMAND,
  CLAUDE_SESSIONS_LIST_COMMAND,
  listLocalClaudeSessionPage,
  readLocalClaudeTranscriptPage,
} from "./session-catalog.js";

const CLAUDE_SESSIONS_CAPABILITY = "claude-sessions";

// Nodes advertise the catalog commands only when this machine has a Claude
// Code session store; without it the gateway skips the node entirely.
function claudeProjectsAvailable(env: NodeJS.ProcessEnv): boolean {
  const homeDir = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  try {
    return statSync(path.join(homeDir, ".claude", "projects")).isDirectory();
  } catch {
    return false;
  }
}

function parseNodeParams(paramsJSON?: string | null): unknown {
  if (!paramsJSON) {
    return undefined;
  }
  try {
    return JSON.parse(paramsJSON) as unknown;
  } catch (error) {
    throw new Error("Claude session parameters must be valid JSON", { cause: error });
  }
}

export function createClaudeSessionNodeHostCommands(): OpenClawPluginNodeHostCommand[] {
  return [
    {
      command: CLAUDE_SESSIONS_LIST_COMMAND,
      cap: CLAUDE_SESSIONS_CAPABILITY,
      dangerous: false,
      isAvailable: ({ env }) => claudeProjectsAvailable(env),
      handle: async (paramsJSON) =>
        JSON.stringify(await listLocalClaudeSessionPage(parseNodeParams(paramsJSON))),
    },
    {
      command: CLAUDE_SESSION_READ_COMMAND,
      cap: CLAUDE_SESSIONS_CAPABILITY,
      dangerous: false,
      isAvailable: ({ env }) => claudeProjectsAvailable(env),
      handle: async (paramsJSON) =>
        JSON.stringify(await readLocalClaudeTranscriptPage(parseNodeParams(paramsJSON))),
    },
  ];
}

export function createClaudeSessionNodeInvokePolicies(): OpenClawPluginNodeInvokePolicy[] {
  return [
    {
      commands: [CLAUDE_SESSIONS_LIST_COMMAND, CLAUDE_SESSION_READ_COMMAND],
      defaultPlatforms: ["macos", "linux", "windows"],
      handle: (context) => context.invokeNode(),
    },
  ];
}
