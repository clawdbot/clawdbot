// Sessions ACP model display tests cover persisted control-plane metadata projection.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeAcpSessionMetaForMigration } from "../acp/runtime/session-meta.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  mockSessionsConfig,
  resetMockSessionsConfig,
  runSessionsJson,
  setMockSessionsConfig,
  writeStore,
} from "./sessions.test-helpers.js";

mockSessionsConfig();

const { sessionsCommand } = await import("./sessions.js");

const ACP_SESSION_KEY = "agent:copilot:acp:86b7b5af-3773-4a56-b244-069d6c5d3db9";
const AGENT_CONFIGURED_MODEL = "gpt-5.3-codex";
const AGENT_CONFIGURED_PROVIDER = "microsoft-foundry";

let originalStateDir: string | undefined;
let tempStateDirs: string[] = [];

function useTempStateDir(): void {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-acp-sessions-state-"));
  tempStateDirs.push(stateDir);
  process.env.OPENCLAW_STATE_DIR = stateDir;
}

function writeAcpRuntimeMeta(sessionKey: string): void {
  writeAcpSessionMetaForMigration({
    sessionKey,
    lifecycleRevision: undefined,
    meta: {
      backend: "copilot",
      agent: "copilot",
      runtimeSessionName: "acp-runtime-session-1",
      mode: "persistent",
      state: "idle",
      lastActivityAt: Date.now() - 2 * 60_000,
    },
  });
}

function mockAgentConfigWithCopilotModel(): void {
  setMockSessionsConfig(() => ({
    agents: {
      list: [
        {
          id: "copilot",
          model: { primary: `${AGENT_CONFIGURED_PROVIDER}/${AGENT_CONFIGURED_MODEL}` },
        },
      ],
      defaults: {},
    },
  }));
}

function buildAcpBridgeSessionEntry(): SessionEntry {
  return {
    sessionId: "acp-bridge-session-id",
    updatedAt: Date.now() - 4 * 60_000,
  };
}

async function readSessionRow(sessionKey: string, store: string) {
  const payload = await runSessionsJson<{
    sessions?: Array<{
      key: string;
      model?: string | null;
      modelProvider?: string | null;
    }>;
  }>(sessionsCommand, store);
  return payload.sessions?.find((entry) => entry.key === sessionKey);
}

describe("sessionsCommand ACP model display", () => {
  beforeEach(() => {
    originalStateDir = process.env.OPENCLAW_STATE_DIR;
    mockAgentConfigWithCopilotModel();
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    for (const stateDir of tempStateDirs) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
    tempStateDirs = [];
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    resetMockSessionsConfig();
  });

  it("reports the ACP runtime sentinel for control-plane sessions", async () => {
    useTempStateDir();
    writeAcpRuntimeMeta(ACP_SESSION_KEY);
    const store = await writeStore(
      { [ACP_SESSION_KEY]: buildAcpBridgeSessionEntry() },
      "sessions-acp-model-display",
      { agentId: "copilot" },
    );

    const row = await readSessionRow(ACP_SESSION_KEY, store);

    expect(row).toMatchObject({ model: "copilot-acp", modelProvider: "acpx" });
  });

  it("reads canonical ACP store keys before querying runtime metadata", async () => {
    useTempStateDir();
    const sessionKey = "agent:copilot:acp:binding:discord:default:feedface";
    const store = await writeStore(
      { [sessionKey]: buildAcpBridgeSessionEntry() },
      "sessions-acp-model-display-canonical",
      { agentId: "copilot" },
    );
    writeAcpRuntimeMeta(sessionKey);

    const row = await readSessionRow(sessionKey, store);

    expect(row).toMatchObject({ model: "copilot-acp", modelProvider: "acpx" });
  });

  it("keeps the configured model for ACP-shaped bridge sessions without runtime metadata", async () => {
    const sessionKey = "agent:copilot:acp:bridge-session-1";
    const store = await writeStore(
      { [sessionKey]: buildAcpBridgeSessionEntry() },
      "sessions-acp-model-display-bridge",
      { agentId: "copilot" },
    );

    const row = await readSessionRow(sessionKey, store);

    expect(row).toMatchObject({
      model: AGENT_CONFIGURED_MODEL,
      modelProvider: AGENT_CONFIGURED_PROVIDER,
    });
  });
});
