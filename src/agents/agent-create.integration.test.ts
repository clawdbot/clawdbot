import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mutateConfigFileWithRetry } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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

describe("agent roster persistence", () => {
  async function addWorkerToConfig(config: unknown): Promise<OpenClawConfig> {
    const state = await createOpenClawTestState({
      layout: "state-only",
      scenario: "empty",
      label: "agent-roster-write",
    });
    try {
      await state.writeConfig(config);
      const result = await createAgent({ name: "Worker", workspace: state.path("worker") });
      expect(result).toMatchObject({ status: "created", agentId: "worker" });
      return JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
    } finally {
      closeOpenClawStateDatabaseForTest();
      await state.cleanup();
    }
  }

  it("writes injected main and a new worker as one complete keyed roster", async () => {
    const persisted = await addWorkerToConfig({ gateway: { mode: "local" } });

    expect(persisted.agents?.entries).toMatchObject({
      main: { default: true },
      worker: { workspace: expect.any(String) },
    });
    expect(
      Object.values(persisted.agents?.entries ?? {}).filter((entry) => entry.default === true),
    ).toHaveLength(1);
  });

  it("replaces a legacy list with the complete keyed roster", async () => {
    const persisted = await addWorkerToConfig({
      agents: {
        list: [
          { id: "main", default: true },
          { id: "ops", workspace: "/srv/ops" },
        ],
      },
    });

    expect(persisted.agents).not.toHaveProperty("list");
    expect(persisted.agents?.entries).toMatchObject({
      main: { default: true },
      ops: { workspace: "/srv/ops" },
      worker: { workspace: expect.any(String) },
    });
  });

  it("preserves a legacy list byte-for-byte during a non-roster mutation", async () => {
    const state = await createOpenClawTestState({
      layout: "state-only",
      scenario: "empty",
      label: "legacy-roster-non-roster-write",
    });
    const list = [
      { id: "main", default: true },
      { id: "ops", workspace: "/srv/ops" },
    ];
    try {
      await state.writeConfig({ agents: { list }, gateway: { port: 18789 } });
      await mutateConfigFileWithRetry({
        mutate: (config) => {
          config.gateway = { ...config.gateway, port: 19001 };
        },
      });

      const persisted = JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
      expect(JSON.stringify(persisted.agents?.list)).toBe(JSON.stringify(list));
      expect(persisted.agents).not.toHaveProperty("entries");
      expect(persisted.gateway?.port).toBe(19001);
    } finally {
      closeOpenClawStateDatabaseForTest();
      await state.cleanup();
    }
  });
});
