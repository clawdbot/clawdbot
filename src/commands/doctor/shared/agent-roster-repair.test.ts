import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { maybeRepairAgentRoster } from "./agent-roster-repair.js";

const roots: string[] = [];

function fixtureEnv(): NodeJS.ProcessEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-roster-"));
  roots.push(root);
  return { HOME: root, OPENCLAW_STATE_DIR: path.join(root, "state") };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("legacy implicit agent doctor repair", () => {
  it("writes an explicit main roster for legacy session state and is idempotent", () => {
    const env = fixtureEnv();
    const sessionsDir = path.join(env.OPENCLAW_STATE_DIR!, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "sessions.json"), "{}\n");

    const repaired = maybeRepairAgentRoster({}, env);
    expect(repaired.config.agents?.list).toEqual([{ id: "main", default: true }]);
    expect(repaired.changes).toHaveLength(1);
    expect(maybeRepairAgentRoster(repaired.config, env)).toEqual({
      config: repaired.config,
      changes: [],
    });
  });

  it("does not treat inference-created agent directories as legacy setup state", () => {
    const env = fixtureEnv();
    fs.mkdirSync(path.join(env.OPENCLAW_STATE_DIR!, "agents", "main", "agent"), {
      recursive: true,
    });
    const config = { agents: { defaults: { model: "openai/gpt" } } };

    expect(maybeRepairAgentRoster(config, env)).toEqual({ config, changes: [] });
  });

  it("writes an explicit main roster for non-empty legacy agent state", () => {
    const env = fixtureEnv();
    const agentDir = path.join(env.OPENCLAW_STATE_DIR!, "agents", "main", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "auth-profiles.json"), "{}\n");

    expect(maybeRepairAgentRoster({}, env).config.agents?.list).toEqual([
      { id: "main", default: true },
    ]);
  });

  it("expands a configured home-relative legacy workspace", () => {
    const env = fixtureEnv();
    const workspace = path.join(env.HOME!, "legacy-workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "AGENTS.md"), "legacy\n");

    expect(
      maybeRepairAgentRoster({ agents: { defaults: { workspace: "~/legacy-workspace" } } }, env)
        .config.agents?.list,
    ).toEqual([{ id: "main", default: true }]);
  });

  it("materializes main for a configured custom session store before its first write", () => {
    const env = fixtureEnv();
    const config = { session: { store: "~/custom/sessions.json" } };

    expect(maybeRepairAgentRoster(config, env).config.agents?.list).toEqual([
      { id: "main", default: true },
    ]);
  });

  it("detects a derived SQLite custom session store without legacy JSON", () => {
    const env = fixtureEnv();
    const sqlitePath = path.join(env.HOME!, "custom", "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    fs.writeFileSync(sqlitePath, "sqlite");

    expect(
      maybeRepairAgentRoster({ session: { store: "~/custom/sessions.json" } }, env).config.agents
        ?.list,
    ).toEqual([{ id: "main", default: true }]);
  });

  it("does not infer main from an unused per-agent store template", () => {
    const env = fixtureEnv();
    const config = { session: { store: "~/custom/{agentId}/sessions.json" } };

    expect(maybeRepairAgentRoster(config, env)).toEqual({ config, changes: [] });
  });

  it("detects an existing main store behind a per-agent template", () => {
    const env = fixtureEnv();
    const storePath = path.join(env.HOME!, "custom", "main", "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, "{}\n");

    expect(
      maybeRepairAgentRoster({ session: { store: "~/custom/{agentId}/sessions.json" } }, env).config
        .agents?.list,
    ).toEqual([{ id: "main", default: true }]);
  });
});
