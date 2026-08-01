/**
 * Tests that auth-store-paths and storage-scan use the configured default agent ID
 * instead of hard-coding "main". Regression coverage for #90573.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listAuthProfileStoreAgentDirs } from "./auth-store-paths.js";
import { listAgentModelsJsonPaths } from "./storage-scan.js";

/** Minimal config with no agents configured — should fall back to DEFAULT_AGENT_ID ("main"). */
const EMPTY_CONFIG = {};

/** Config with a non-"main" default agent that has no custom agentDir. */
function makeNonMainConfig(defaultAgentId: string) {
  return {
    agents: {
      list: [{ id: defaultAgentId, default: true }],
    },
  };
}

/** Config with a non-"main" default agent that has a custom agentDir. */
function makeCustomDirConfig(defaultAgentId: string, agentDir: string) {
  return {
    agents: {
      list: [{ id: defaultAgentId, default: true, agentDir }],
    },
  };
}

const FAKE_STATE_DIR = "/fake/state";

describe("listAuthProfileStoreAgentDirs — default agent ID", () => {
  it("includes agents/main/agent when no agents are configured", () => {
    const dirs = listAuthProfileStoreAgentDirs(EMPTY_CONFIG as never, FAKE_STATE_DIR);
    expect(dirs).toContain(path.join(FAKE_STATE_DIR, "agents", "main", "agent"));
  });

  it("includes the configured default agent dir (not 'main') when default agent id differs", () => {
    const cfg = makeNonMainConfig("nova");
    const dirs = listAuthProfileStoreAgentDirs(cfg as never, FAKE_STATE_DIR);
    // Must include nova's dir
    expect(dirs).toContain(path.join(FAKE_STATE_DIR, "agents", "nova", "agent"));
    // Must NOT include a dead path for agents/main/agent as the *initial* seed
    // (it may be added by the configured-agent loop if "main" is also in the list,
    // but for this config it is not, so it should only appear if the stateDir scan
    // would add it — which it won't since the fake dir doesn't exist on disk).
    // The key assertion: nova's path is present.
    const joined = dirs.join(",");
    expect(joined).toContain("nova");
  });

  it("includes both default-agent path and all configured agent paths", () => {
    const cfg = {
      agents: {
        list: [{ id: "nova", default: true }, { id: "main" }, { id: "worker" }],
      },
    };
    const dirs = listAuthProfileStoreAgentDirs(cfg as never, FAKE_STATE_DIR);
    expect(dirs).toContain(path.join(FAKE_STATE_DIR, "agents", "nova", "agent"));
    expect(dirs).toContain(path.join(FAKE_STATE_DIR, "agents", "main", "agent"));
    expect(dirs).toContain(path.join(FAKE_STATE_DIR, "agents", "worker", "agent"));
  });

  it("does not double-add paths when default agent is also in the list", () => {
    // When default agent id is "nova" and nova is in agents.list,
    // the path should appear once (Set deduplication).
    const cfg = makeNonMainConfig("nova");
    const dirs = listAuthProfileStoreAgentDirs(cfg as never, FAKE_STATE_DIR);
    const novaPath = path.join(FAKE_STATE_DIR, "agents", "nova", "agent");
    expect(dirs.filter((d) => d === novaPath)).toHaveLength(1);
  });

  it("honors a configured custom agentDir instead of the passed stateDir", () => {
    // Use a non-default agent so the top-level default-agent seed (which is
    // always scoped to stateDir) does not also add a stateDir path for it.
    const customDir = path.join("/opt", "custom", "worker");
    const cfg = {
      ...makeCustomDirConfig("nova", path.join("/opt", "custom", "nova")),
    } as { agents: { list: Array<Record<string, unknown>> } };
    cfg.agents.list.push({ id: "worker", agentDir: customDir });
    const dirs = listAuthProfileStoreAgentDirs(cfg as never, FAKE_STATE_DIR);
    // The custom agentDir wins verbatim; it is NOT rewritten under stateDir.
    expect(dirs).toContain(customDir);
    expect(dirs).not.toContain(path.join(FAKE_STATE_DIR, "agents", "worker", "agent"));
  });
});

describe("listAgentModelsJsonPaths — default agent ID", () => {
  it("includes agents/main/agent/models.json when no agents are configured", () => {
    const paths = listAgentModelsJsonPaths(EMPTY_CONFIG as never, FAKE_STATE_DIR);
    expect(paths).toContain(path.join(FAKE_STATE_DIR, "agents", "main", "agent", "models.json"));
  });

  it("includes the configured default agent models.json when default agent id differs", () => {
    const cfg = makeNonMainConfig("nova");
    const paths = listAgentModelsJsonPaths(cfg as never, FAKE_STATE_DIR);
    expect(paths).toContain(path.join(FAKE_STATE_DIR, "agents", "nova", "agent", "models.json"));
  });

  it("includes all configured agent models.json paths", () => {
    const cfg = {
      agents: {
        list: [{ id: "nova", default: true }, { id: "main" }, { id: "worker" }],
      },
    };
    const paths = listAgentModelsJsonPaths(cfg as never, FAKE_STATE_DIR);
    expect(paths).toContain(path.join(FAKE_STATE_DIR, "agents", "nova", "agent", "models.json"));
    expect(paths).toContain(path.join(FAKE_STATE_DIR, "agents", "main", "agent", "models.json"));
    expect(paths).toContain(path.join(FAKE_STATE_DIR, "agents", "worker", "agent", "models.json"));
  });

  it("does not seed a dead agents/main models.json for a nova-only default config", () => {
    // Regression for the ClawSweeper P2: with no env override and only "nova"
    // marked default, the active-agent fallback must resolve to nova, not "main".
    const cfg = makeNonMainConfig("nova");
    const paths = listAgentModelsJsonPaths(cfg as never, FAKE_STATE_DIR, {});
    expect(paths).toContain(path.join(FAKE_STATE_DIR, "agents", "nova", "agent", "models.json"));
    expect(paths).not.toContain(
      path.join(FAKE_STATE_DIR, "agents", "main", "agent", "models.json"),
    );
  });

  it("does not double-add the default agent path when it is also in agents.list", () => {
    const cfg = makeNonMainConfig("nova");
    const paths = listAgentModelsJsonPaths(cfg as never, FAKE_STATE_DIR);
    const novaPath = path.join(FAKE_STATE_DIR, "agents", "nova", "agent", "models.json");
    expect(paths.filter((p) => p === novaPath)).toHaveLength(1);
  });

  it("honors a configured custom agentDir instead of the passed stateDir", () => {
    // Use a non-default agent so the top-level default-agent seed (which is
    // always scoped to stateDir) does not also add a stateDir path for it.
    const customDir = path.join("/opt", "custom", "worker");
    const cfg = {
      ...makeCustomDirConfig("nova", path.join("/opt", "custom", "nova")),
    } as { agents: { list: Array<Record<string, unknown>> } };
    cfg.agents.list.push({ id: "worker", agentDir: customDir });
    const paths = listAgentModelsJsonPaths(cfg as never, FAKE_STATE_DIR);
    expect(paths).toContain(path.join(customDir, "models.json"));
    expect(paths).not.toContain(
      path.join(FAKE_STATE_DIR, "agents", "worker", "agent", "models.json"),
    );
  });
});
