import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  loadExactSqliteSessionEntry,
  replaceSqliteSessionEntrySync,
} from "../config/sessions/session-accessor.sqlite.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createAgent } from "./agent-create.js";
import {
  DEFAULT_IDENTITY_FILENAME,
  ensureAgentWorkspace,
  isWorkspaceBootstrapPending,
} from "./workspace.js";

it("keeps a fresh named workspace pending through the first run setup", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    scenario: "minimal",
    label: "named-agent-hatch",
  });
  const workspace = state.path("named-workspace");

  try {
    const created = await createAgent({ name: "Researcher", workspace });

    expect(created).toMatchObject({ status: "created", bootstrapPending: true });
    expect(await isWorkspaceBootstrapPending(workspace)).toBe(true);

    const firstRunWorkspace = await ensureAgentWorkspace({
      dir: workspace,
      ensureBootstrapFiles: true,
    });
    expect(firstRunWorkspace.bootstrapPending).toBe(true);
    expect(await isWorkspaceBootstrapPending(workspace)).toBe(true);
    expect(
      await fs.readFile(path.join(workspace, DEFAULT_IDENTITY_FILENAME), "utf8"),
    ).not.toContain("Researcher");
  } finally {
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  }
});

it("repairs legacy main state before creating a differently named first agent", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    scenario: "minimal",
    label: "legacy-main-before-agent-create",
  });
  const customStore = state.path("legacy-sessions", "sessions.json");
  const legacySqlite = state.path("legacy-sessions", "openclaw-agent.sqlite");
  const workspace = state.path("ops-workspace");

  try {
    await state.writeConfig({
      agents: { list: [] },
      session: { store: customStore },
    });
    replaceSqliteSessionEntrySync(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: legacySqlite,
      },
      { sessionId: "legacy-main-session", updatedAt: 1 },
    );

    const created = await createAgent({ name: "ops", workspace });

    expect(created).toMatchObject({ status: "created", agentId: "ops" });
    const config = JSON.parse(await fs.readFile(state.configPath, "utf8")) as {
      agents?: { list?: Array<{ id: string; default?: boolean }> };
    };
    expect(config.agents?.list).toEqual([
      { id: "main" },
      expect.objectContaining({ id: "ops", default: true }),
    ]);
    expect(
      loadExactSqliteSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: customStore,
      }),
    ).toMatchObject({ entry: { sessionId: "legacy-main-session" } });
  } finally {
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  }
});
