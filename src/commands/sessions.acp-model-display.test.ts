// Sessions ACP model display tests cover persisted control-plane metadata projection.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertAcpSessionMeta } from "../acp/runtime/session-meta.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { enforceSqliteSessionHistoryDiskBudget } from "../config/sessions/session-history-eviction.js";
import { resolveMaintenanceConfig } from "../config/sessions/store-maintenance-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabases } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { sessionsCommand } from "./sessions.js";

const ACP_SESSION_KEY = "agent:copilot:acp:86b7b5af-3773-4a56-b244-069d6c5d3db9";
const AGENT_CONFIGURED_MODEL = "gpt-5.3-codex";
const AGENT_CONFIGURED_PROVIDER = "microsoft-foundry";

type SessionRow = {
  key: string;
  agentId: string;
  model: string;
  modelProvider: string;
  acpRuntime: boolean;
  agentRuntime: { id: string; source: string };
};

let stateDir: string;
let cfg: OpenClawConfig;
const stores = new Map<string, string>();

function configureAgents(agentIds: string[]): void {
  cfg = {
    agents: {
      ownership: "explicit",
      entries: Object.fromEntries(agentIds.map((id) => [id, {}])),
      defaults: {
        model: { primary: `${AGENT_CONFIGURED_PROVIDER}/${AGENT_CONFIGURED_MODEL}` },
        models: {
          [`${AGENT_CONFIGURED_PROVIDER}/${AGENT_CONFIGURED_MODEL}`]: {
            agentRuntime: { id: "openclaw" },
          },
        },
      },
    },
  };
  setRuntimeConfigSnapshot(cfg);
}

function writeSession(agentId: string, sessionKey: string, sessionId = `${agentId}-session`): void {
  const storePath = path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
  stores.set(agentId, storePath);
  replaceSessionEntrySync(
    { agentId, sessionKey, storePath },
    {
      sessionId,
      lifecycleRevision: `${sessionId}-revision`,
      updatedAt: Date.now() - 4 * 60_000,
    },
  );
}

async function writeAcpRuntimeMeta(agentId: string, sessionKey: string): Promise<void> {
  await upsertAcpSessionMeta({
    cfg,
    agentId,
    sessionKey,
    mutate: () => ({
      backend: agentId,
      agent: agentId,
      runtimeSessionName: `${agentId}-runtime-session`,
      mode: "persistent",
      state: "idle",
      lastActivityAt: Date.now(),
    }),
  });
}

async function readSessions(): Promise<SessionRow[]> {
  const logs: string[] = [];
  await sessionsCommand(
    { json: true, allAgents: true },
    {
      log: (message: unknown) => logs.push(String(message)),
      error: (message: unknown) => {
        throw new Error(String(message));
      },
      exit: (code) => {
        throw new Error(`Unexpected exit ${code}`);
      },
    },
  );
  return (JSON.parse(logs.join("\n")) as { sessions: SessionRow[] }).sessions;
}

describe("sessionsCommand ACP model display", () => {
  beforeEach(() => {
    stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-acp-sessions-")));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    configureAgents(["copilot"]);
  });

  afterEach(async () => {
    try {
      // The native ACP writer schedules maintenance; settle its FIFO before closing the fixture.
      const maintenance = resolveMaintenanceConfig();
      await Promise.all(
        [...stores].map(([agentId, storePath]) =>
          enforceSqliteSessionHistoryDiskBudget({
            agentId,
            storePath,
            mode: maintenance.mode,
            maintenance,
          }),
        ),
      );
    } finally {
      closeOpenClawAgentDatabases(stateDir);
      closeOpenClawStateDatabase();
      clearRuntimeConfigSnapshot();
      stores.clear();
      fs.rmSync(stateDir, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });

  it.each([ACP_SESSION_KEY, "agent:copilot:acp:binding:discord:default:feedface"])(
    "reports native ACP metadata for %s",
    async (sessionKey) => {
      writeSession("copilot", sessionKey);
      await writeAcpRuntimeMeta("copilot", sessionKey);

      expect(await readSessions()).toMatchObject([
        {
          key: sessionKey,
          model: "copilot-acp",
          modelProvider: "acpx",
          acpRuntime: true,
          agentRuntime: { id: "copilot", source: "session-key" },
        },
      ]);
    },
  );

  it("keeps the configured model for ACP-shaped bridge sessions without runtime metadata", async () => {
    const sessionKey = "agent:copilot:acp:bridge-session-1";
    writeSession("copilot", sessionKey);

    expect(await readSessions()).toMatchObject([
      {
        key: sessionKey,
        model: AGENT_CONFIGURED_MODEL,
        modelProvider: AGENT_CONFIGURED_PROVIDER,
        acpRuntime: false,
        agentRuntime: { id: "openclaw", source: "model" },
      },
    ]);
  });

  it("keeps each selected owner's metadata and rejects a replaced lifecycle", async () => {
    configureAgents(["copilot", "reviewer"]);
    const reviewerSessionKey = "agent:reviewer:acp:current-session";
    for (const [agentId, sessionKey] of [
      ["copilot", ACP_SESSION_KEY],
      ["reviewer", reviewerSessionKey],
    ] as const) {
      writeSession(agentId, sessionKey);
      await writeAcpRuntimeMeta(agentId, sessionKey);
    }
    const before = await readSessions();
    for (const agentId of ["copilot", "reviewer"]) {
      expect(before.find((row) => row.agentId === agentId)).toMatchObject({
        model: `${agentId}-acp`,
        modelProvider: "acpx",
        acpRuntime: true,
        agentRuntime: { id: agentId, source: "session-key" },
      });
    }

    writeSession("reviewer", reviewerSessionKey, "reviewer-replacement");
    const after = await readSessions();
    expect(after.find((row) => row.agentId === "copilot")).toMatchObject({
      acpRuntime: true,
      agentRuntime: { id: "copilot", source: "session-key" },
    });
    expect(after.find((row) => row.agentId === "reviewer")).toMatchObject({
      model: AGENT_CONFIGURED_MODEL,
      modelProvider: AGENT_CONFIGURED_PROVIDER,
      acpRuntime: false,
      agentRuntime: { id: "openclaw", source: "model" },
    });
  });
});
