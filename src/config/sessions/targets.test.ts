// Session target tests cover persisted channel targets for sessions.
import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config.js";
import { resolveStorePath } from "./paths.js";
import { replaceSessionEntry } from "./session-accessor.js";
import {
  resolveAgentSessionStoreTargetsSync,
  resolveAllAgentSessionStoreCandidateTargetsSync,
  resolveAllAgentSessionStoreTargetsSync,
  resolveSessionStoreTargets,
} from "./targets.js";

async function resolveRealStorePath(sessionsDir: string): Promise<string> {
  return path.resolve(path.join(sessionsDir, "sessions.json"));
}

async function createAgentSessionStores(
  root: string,
  agentIds: string[],
): Promise<Record<string, string>> {
  const storePaths: Record<string, string> = {};
  for (const agentId of agentIds) {
    const sessionsDir = path.join(root, "agents", agentId, "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    await fs.mkdir(sessionsDir, { recursive: true });
    await replaceSessionEntry(
      { storePath, sessionKey: "main" },
      { sessionId: "sid", updatedAt: Date.now() },
    );
    storePaths[agentId] = await resolveRealStorePath(sessionsDir);
  }
  return storePaths;
}

function createCustomRootCfg(customRoot: string, defaultAgentId = "ops"): OpenClawConfig {
  return {
    session: {
      store: path.join(customRoot, "agents", "{agentId}", "sessions", "sessions.json"),
    },
    agents: {
      list: [{ id: defaultAgentId, default: true }],
    },
  };
}

function countMatching<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  let count = 0;
  for (const item of items) {
    if (predicate(item)) {
      count += 1;
    }
  }
  return count;
}

async function resolveTargetsForCustomRoot(home: string, agentIds: string[]) {
  const customRoot = path.join(home, "custom-state");
  const storePaths = await createAgentSessionStores(customRoot, agentIds);
  const cfg = createCustomRootCfg(customRoot);
  const targets = resolveAllAgentSessionStoreTargetsSync(cfg, { env: process.env });
  return { storePaths, targets };
}

function expectTargetsToContainStores(
  targets: Array<{ agentId: string; storePath: string }>,
  stores: Record<string, string>,
): void {
  for (const [agentId, storePath] of Object.entries(stores)) {
    expect(
      targets.some((target) => target.agentId === agentId && target.storePath === storePath),
    ).toBe(true);
  }
}

describe("resolveSessionStoreTargets", () => {
  it("resolves all configured agent stores", async () => {
    await withTempHome(async () => {
      const cfg: OpenClawConfig = {
        session: {
          store: "~/.openclaw/agents/{agentId}/sessions/sessions.json",
        },
        agents: {
          list: [{ id: "main", default: true }, { id: "work" }],
        },
      };

      const env = { ...process.env };
      const targets = resolveSessionStoreTargets(cfg, { allAgents: true }, { env });
      expect(targets).toEqual([
        {
          agentId: "main",
          storePath: resolveStorePath(cfg.session?.store, { agentId: "main", env }),
        },
        {
          agentId: "work",
          storePath: resolveStorePath(cfg.session?.store, { agentId: "work", env }),
        },
      ]);
    });
  });

  it("includes configured ACP harness stores for all-agent session views", async () => {
    await withTempHome(async () => {
      const cfg: OpenClawConfig = {
        session: {
          store: "~/.openclaw/agents/{agentId}/sessions/sessions.json",
        },
        agents: {
          list: [
            { id: "ops", default: true },
            { id: "review", runtime: { type: "acp", acp: { agent: "opencode" } } },
          ],
        },
        acp: {
          defaultAgent: "claude",
          allowedAgents: ["gemini", "*"],
        },
      };

      const env = { ...process.env };
      const targets = resolveSessionStoreTargets(cfg, { allAgents: true }, { env });
      expect(targets).toEqual([
        {
          agentId: "ops",
          storePath: resolveStorePath(cfg.session?.store, { agentId: "ops", env }),
        },
        {
          agentId: "review",
          storePath: resolveStorePath(cfg.session?.store, { agentId: "review", env }),
        },
        {
          agentId: "claude",
          storePath: resolveStorePath(cfg.session?.store, { agentId: "claude", env }),
        },
        {
          agentId: "gemini",
          storePath: resolveStorePath(cfg.session?.store, { agentId: "gemini", env }),
        },
        {
          agentId: "opencode",
          storePath: resolveStorePath(cfg.session?.store, { agentId: "opencode", env }),
        },
      ]);
    });
  });

  it("keeps shared store paths distinct by SQLite owner for --all-agents", () => {
    const cfg: OpenClawConfig = {
      session: {
        store: "/tmp/shared-sessions.json",
      },
      agents: {
        list: [{ id: "main", default: true }, { id: "work" }],
      },
    };

    expect(resolveSessionStoreTargets(cfg, { allAgents: true })).toEqual([
      { agentId: "main", storePath: path.resolve("/tmp/shared-sessions.json") },
      { agentId: "work", storePath: path.resolve("/tmp/shared-sessions.json") },
    ]);
  });

  it("uses the path-owned agent id for explicit agent store paths", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const storePaths = await createAgentSessionStores(stateDir, ["codex-proof"]);
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };

      expect(resolveSessionStoreTargets({}, { store: storePaths["codex-proof"] }, { env })).toEqual(
        [
          {
            agentId: "codex-proof",
            storePath: storePaths["codex-proof"],
          },
        ],
      );
    });
  });

  it("keeps arbitrary explicit store paths on the default agent", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "backups", "sessions", "sessions.json");

      expect(resolveSessionStoreTargets({}, { store: storePath })).toEqual([
        {
          agentId: "main",
          storePath,
        },
      ]);
    });
  });

  it("rejects unknown agent ids", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true }, { id: "work" }],
      },
    };

    expect(() => resolveSessionStoreTargets(cfg, { agent: "ghost" })).toThrow(/Unknown agent id/);
  });

  it("rejects conflicting selectors", () => {
    expect(() => resolveSessionStoreTargets({}, { agent: "main", allAgents: true })).toThrow(
      /cannot be used together/i,
    );
    expect(() =>
      resolveSessionStoreTargets({}, { store: "/tmp/sessions.json", allAgents: true }),
    ).toThrow(/cannot be combined/i);
  });
});

describe("resolveAgentSessionStoreTargetsSync", () => {
  it("resolves one requested agent store from the direct path", async () => {
    await withTempHome(async (home) => {
      const customRoot = path.join(home, "custom-state");
      const storePaths = await createAgentSessionStores(customRoot, ["main", "codex"]);
      const cfg = createCustomRootCfg(customRoot, "main");

      expect(resolveAgentSessionStoreTargetsSync(cfg, "codex", { env: process.env })).toEqual([
        {
          agentId: "codex",
          storePath: storePaths.codex,
        },
      ]);
    });
  });

  it("finds discovered directories whose names normalize to the requested agent", async () => {
    await withTempHome(async (home) => {
      const customRoot = path.join(home, "custom-state");
      const storePaths = await createAgentSessionStores(customRoot, ["main", "Retired Agent"]);
      const cfg = createCustomRootCfg(customRoot, "main");

      expect(
        resolveAgentSessionStoreTargetsSync(cfg, "retired-agent", { env: process.env }),
      ).toEqual([
        {
          agentId: "retired-agent",
          storePath: storePaths["Retired Agent"],
        },
      ]);
    });
  });
});

describe("resolveAllAgentSessionStoreTargetsSync", () => {
  it("includes discovered on-disk agent stores alongside configured targets", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const storePaths = await createAgentSessionStores(stateDir, ["ops", "retired"]);

      const cfg: OpenClawConfig = {
        agents: {
          list: [{ id: "ops", default: true }],
        },
      };

      const targets = resolveAllAgentSessionStoreTargetsSync(cfg, { env: process.env });

      expectTargetsToContainStores(targets, storePaths);
      expect(countMatching(targets, (target) => target.storePath === storePaths.ops)).toBe(1);
    });
  });

  it("includes legacy JSON stores before an agent SQLite database exists", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const sessionsDir = path.join(stateDir, "agents", "legacy", "sessions");
      const storePath = path.join(sessionsDir, "sessions.json");
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(
        storePath,
        JSON.stringify({ main: { sessionId: "legacy-session", updatedAt: Date.now() } }),
        "utf8",
      );

      const targets = resolveAllAgentSessionStoreTargetsSync(
        { agents: { list: [{ id: "legacy", default: true }] } },
        { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
      );

      expect(targets).toContainEqual({ agentId: "legacy", storePath });
    });
  });

  it("discovers retired agent stores under a configured custom session root", async () => {
    await withTempHome(async (home) => {
      const { storePaths, targets } = await resolveTargetsForCustomRoot(home, ["ops", "retired"]);

      expectTargetsToContainStores(targets, storePaths);
      expect(countMatching(targets, (target) => target.storePath === storePaths.ops)).toBe(1);
    });
  });

  it("keeps the actual on-disk store path for discovered retired agents", async () => {
    await withTempHome(async (home) => {
      const { storePaths, targets } = await resolveTargetsForCustomRoot(home, [
        "ops",
        "Retired Agent",
      ]);

      expect(
        targets.some(
          (target) =>
            target.agentId === "retired-agent" && target.storePath === storePaths["Retired Agent"],
        ),
      ).toBe(true);
    });
  });

  it("respects the caller env when resolving configured and discovered store roots", async () => {
    await withTempHome(async (home) => {
      const envStateDir = path.join(home, "env-state");
      const mainSessionsDir = path.join(envStateDir, "agents", "main", "sessions");
      const retiredSessionsDir = path.join(envStateDir, "agents", "retired", "sessions");
      await fs.mkdir(mainSessionsDir, { recursive: true });
      await fs.mkdir(retiredSessionsDir, { recursive: true });
      await replaceSessionEntry(
        { storePath: path.join(mainSessionsDir, "sessions.json"), sessionKey: "main" },
        { sessionId: "sid-main", updatedAt: Date.now() },
      );
      await replaceSessionEntry(
        { storePath: path.join(retiredSessionsDir, "sessions.json"), sessionKey: "main" },
        { sessionId: "sid-retired", updatedAt: Date.now() },
      );

      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: envStateDir,
      };
      const cfg: OpenClawConfig = {};
      const mainStorePath = await resolveRealStorePath(mainSessionsDir);
      const retiredStorePath = await resolveRealStorePath(retiredSessionsDir);

      const targets = resolveAllAgentSessionStoreTargetsSync(cfg, { env });

      expect(
        targets.some((target) => target.agentId === "main" && target.storePath === mainStorePath),
      ).toBe(true);
      expect(
        targets.some(
          (target) => target.agentId === "retired" && target.storePath === retiredStorePath,
        ),
      ).toBe(true);
    });
  });

  it("skips unreadable or invalid discovery roots when other roots are still readable", async () => {
    await withTempHome(async (home) => {
      const customRoot = path.join(home, "custom-state");
      await fs.mkdir(customRoot, { recursive: true });
      await fs.writeFile(path.join(customRoot, "agents"), "not-a-directory", "utf8");

      const envStateDir = path.join(home, "env-state");
      const storePaths = await createAgentSessionStores(envStateDir, ["main", "retired"]);
      const cfg = createCustomRootCfg(customRoot, "main");
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: envStateDir,
      };

      const targets = resolveAllAgentSessionStoreTargetsSync(cfg, { env });
      expect(
        targets.some(
          (target) => target.agentId === "retired" && target.storePath === storePaths.retired,
        ),
      ).toBe(true);
    });
  });

  it("skips symlinked discovered stores under templated agents roots", async () => {
    await withTempHome(async (home) => {
      if (process.platform === "win32") {
        return;
      }
      const customRoot = path.join(home, "custom-state");
      const opsSessionsDir = path.join(customRoot, "agents", "ops", "sessions");
      const opsAgentDbDir = path.join(customRoot, "agents", "ops", "agent");
      const leakedFile = path.join(home, "outside.sqlite");
      await fs.mkdir(opsSessionsDir, { recursive: true });
      await fs.mkdir(opsAgentDbDir, { recursive: true });
      await fs.writeFile(leakedFile, JSON.stringify({ leak: { secret: "x" } }), "utf8");
      await fs.symlink(leakedFile, path.join(opsAgentDbDir, "openclaw-agent.sqlite"));

      const targets = resolveAllAgentSessionStoreTargetsSync(createCustomRootCfg(customRoot), {
        env: process.env,
      });
      const symlinkStoreSuffix = path.join("ops", "sessions", "sessions.json");
      expect(
        targets.some(
          (target) => target.agentId === "ops" && target.storePath.includes(symlinkStoreSuffix),
        ),
      ).toBe(false);
    });
  });

  it("skips discovered directories that only normalize into the default main agent", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const mainSessionsDir = path.join(stateDir, "agents", "main", "sessions");
      const junkSessionsDir = path.join(stateDir, "agents", "###", "sessions");
      await fs.mkdir(mainSessionsDir, { recursive: true });
      await fs.mkdir(junkSessionsDir, { recursive: true });
      await replaceSessionEntry(
        { storePath: path.join(mainSessionsDir, "sessions.json"), sessionKey: "main" },
        { sessionId: "sid-main", updatedAt: Date.now() },
      );
      await replaceSessionEntry(
        {
          agentId: "main",
          storePath: path.join(junkSessionsDir, "sessions.json"),
          sessionKey: "main",
        },
        { sessionId: "sid-junk", updatedAt: Date.now() },
      );

      const cfg: OpenClawConfig = {};
      const mainStorePath = await resolveRealStorePath(mainSessionsDir);
      const targets = resolveAllAgentSessionStoreTargetsSync(cfg, { env: process.env });

      expect(targets).toEqual([
        {
          agentId: "main",
          storePath: mainStorePath,
        },
      ]);
      expect(
        targets.some((target) => target.storePath === path.join(junkSessionsDir, "sessions.json")),
      ).toBe(false);
    });
  });
});

describe("resolveAllAgentSessionStoreCandidateTargetsSync", () => {
  it("includes configured targets before either state file exists", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storePath = resolveStorePath(undefined, { agentId: "main", env });

      expect(
        resolveAllAgentSessionStoreCandidateTargetsSync(
          { agents: { list: [{ default: true, id: "main" }] } },
          { env },
        ),
      ).toContainEqual({ agentId: "main", storePath });
    });
  });

  it("includes retired agent directories after both state files are removed", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const retiredAgentDir = path.join(stateDir, "agents", "retired");
      await fs.mkdir(retiredAgentDir, { recursive: true });
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };

      expect(resolveAllAgentSessionStoreCandidateTargetsSync({}, { env })).toContainEqual({
        agentId: "retired",
        storePath: path.join(retiredAgentDir, "sessions", "sessions.json"),
      });
    });
  });

  it("skips candidate session directories that escape through symlinks", async () => {
    await withTempHome(async (home) => {
      if (process.platform === "win32") {
        return;
      }
      const stateDir = path.join(home, ".openclaw");
      const agentDir = path.join(stateDir, "agents", "retired");
      const outsideSessionsDir = path.join(home, "outside-sessions");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.mkdir(outsideSessionsDir, { recursive: true });
      await fs.symlink(outsideSessionsDir, path.join(agentDir, "sessions"));
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };

      expect(resolveAllAgentSessionStoreCandidateTargetsSync({}, { env })).not.toContainEqual({
        agentId: "retired",
        storePath: path.join(agentDir, "sessions", "sessions.json"),
      });
    });
  });

  it("skips configured agent session directories that escape through symlinks", async () => {
    await withTempHome(async (home) => {
      if (process.platform === "win32") {
        return;
      }
      const customRoot = path.join(home, "custom-state");
      const agentDir = path.join(customRoot, "agents", "ops");
      const outsideSessionsDir = path.join(home, "outside-configured-sessions");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.mkdir(outsideSessionsDir, { recursive: true });
      await fs.symlink(outsideSessionsDir, path.join(agentDir, "sessions"));

      expect(
        resolveAllAgentSessionStoreCandidateTargetsSync(createCustomRootCfg(customRoot), {
          env: process.env,
        }),
      ).not.toContainEqual({
        agentId: "ops",
        storePath: path.join(agentDir, "sessions", "sessions.json"),
      });
    });
  });
});
