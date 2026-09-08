// Session target tests cover persisted channel targets for sessions.
import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db-registry.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { OpenClawConfig } from "../config.js";
import { resolveSessionStorePathCore } from "./paths.js";
import { listSessionEntriesReadOnly, replaceSessionEntry } from "./session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import {
  resolveExistingAgentSessionStoreTargetsSync,
  resolveSessionStoreTargets,
} from "./targets.js";
import { createAgentSessionStores, EXPLICIT_MAIN_CONFIG } from "./targets.test-support.js";

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
          storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: "main", env }),
        },
        {
          agentId: "work",
          storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: "work", env }),
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
          storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: "ops", env }),
        },
        {
          agentId: "review",
          storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: "review", env }),
        },
        {
          agentId: "claude",
          storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: "claude", env }),
        },
        {
          agentId: "gemini",
          storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: "gemini", env }),
        },
        {
          agentId: "opencode",
          storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: "opencode", env }),
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

  it("keeps a colliding fixed-store target on the configured default", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(home, ".openclaw") };
      const storePath = path.join(home, "ops.json");
      const diagnostics: string[] = [];
      const cfg: OpenClawConfig = {
        session: { store: storePath },
        agents: { entries: { main: { default: true }, ops: {} } },
      };

      expect(resolveSessionStoreTargets(cfg, { allAgents: true }, { env, diagnostics })).toEqual([
        { agentId: "main", storePath },
        { agentId: "ops", storePath },
      ]);
      expect(diagnostics).toContainEqual(expect.stringContaining('suffixed owner(s): "ops"'));
    });
  });

  it("lands colliding fixed-store writes in distinct owner databases", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(home, ".openclaw") };
      const storePath = path.join(home, "ops.json");

      await replaceSessionEntry(
        {
          agentId: "main",
          defaultAgentId: "main",
          env,
          storePath,
          sessionKey: "agent:main:main",
        },
        { sessionId: "main-session", updatedAt: 1 },
      );
      await replaceSessionEntry(
        {
          agentId: "ops",
          defaultAgentId: "main",
          env,
          storePath,
          sessionKey: "agent:ops:main",
        },
        { sessionId: "ops-session", updatedAt: 2 },
      );

      const mainPath = resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: "main",
        defaultAgentId: "main",
        env,
      }).path;
      const opsPath = resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: "ops",
        defaultAgentId: "main",
        env,
      }).path;
      expect(mainPath).not.toBe(opsPath);
      await expect(fs.stat(mainPath)).resolves.toBeDefined();
      await expect(fs.stat(opsPath)).resolves.toBeDefined();
      expect(
        listSessionEntriesReadOnly({
          agentId: "main",
          defaultAgentId: "main",
          env,
          storePath,
        }).map(({ sessionKey }) => sessionKey),
      ).toEqual(["agent:main:main"]);
      expect(
        listSessionEntriesReadOnly({
          agentId: "ops",
          defaultAgentId: "main",
          env,
          storePath,
        }).map(({ sessionKey }) => sessionKey),
      ).toEqual(["agent:ops:main"]);
    });
  });

  it("keeps a promoted default on its registered suffixed database", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(home, ".openclaw") };
      const storePath = path.join(home, "shared.json");
      await replaceSessionEntry(
        {
          agentId: "worker",
          defaultAgentId: "main",
          env,
          storePath,
          sessionKey: "agent:worker:main",
        },
        { model: "before-promotion", sessionId: "worker-session", updatedAt: 1 },
      );
      const beforePromotionPath = resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: "worker",
        defaultAgentId: "main",
        env,
      }).path;

      await replaceSessionEntry(
        {
          agentId: "worker",
          defaultAgentId: "worker",
          env,
          storePath,
          sessionKey: "agent:worker:main",
        },
        { model: "after-promotion", sessionId: "worker-session", updatedAt: 2 },
      );
      const afterPromotionPath = resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: "worker",
        defaultAgentId: "worker",
        env,
      }).path;

      expect(afterPromotionPath).toBe(beforePromotionPath);
      expect(afterPromotionPath).toBe(path.join(home, "shared.worker.sqlite"));
      await expect(fs.stat(path.join(home, "shared.sqlite"))).rejects.toThrow();
      expect(
        listSessionEntriesReadOnly({
          agentId: "worker",
          defaultAgentId: "worker",
          env,
          storePath,
        }),
      ).toEqual([
        {
          sessionKey: "agent:worker:main",
          entry: expect.objectContaining({
            model: "after-promotion",
            sessionId: "worker-session",
          }),
        },
      ]);
    });
  });

  it("does not let durable metadata override ambiguous suffix registration", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(home, ".openclaw") };
      const storePath = path.join(home, "shared.json");
      await replaceSessionEntry(
        {
          agentId: "worker",
          defaultAgentId: "main",
          env,
          storePath,
          sessionKey: "agent:worker:main",
        },
        { sessionId: "worker-session", updatedAt: 1 },
      );
      const occupiedPath = resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: "worker",
        defaultAgentId: "main",
        env,
      }).path;
      registerOpenClawAgentDatabase({ agentId: "ops", env, path: occupiedPath });

      expect(
        resolveSqliteTargetFromSessionStorePath(storePath, {
          agentId: "worker",
          defaultAgentId: "main",
          env,
        }).path,
      ).toBe(path.join(home, "shared.worker.2.sqlite"));
    });
  });

  it("retains a shared-store claimant when the physical owner left the roster", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(home, ".openclaw") };
      const storePath = path.join(home, "shared.sqlite");
      await replaceSessionEntry(
        {
          agentId: "main",
          defaultAgentId: "main",
          env,
          storePath,
          sessionKey: "agent:main:main",
        },
        { sessionId: "main-session", updatedAt: 1 },
      );
      await replaceSessionEntry(
        {
          agentId: "ops",
          defaultAgentId: "main",
          env,
          storePath,
          sessionKey: "agent:ops:main",
        },
        { sessionId: "ops-session", updatedAt: 2 },
      );
      const cfg: OpenClawConfig = {
        session: { store: storePath },
        agents: { entries: { ops: { default: true }, other: {} } },
      };
      const diagnostics: string[] = [];
      expect(resolveSessionStoreTargets(cfg, { allAgents: true }, { env, diagnostics })).toEqual([
        { agentId: "ops", storePath },
      ]);
      expect(diagnostics).toEqual([
        `Session store target collision at ${storePath}: owner "main" selected by database-path; ignored owner(s): "other".`,
      ]);
      expect(resolveExistingAgentSessionStoreTargetsSync(cfg, "ops", { env })).toEqual([
        { agentId: "ops", storePath },
      ]);
    });
  });

  it("honors a registered owner over the configured default for a fixed-store collision", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storePath = path.join(home, "ops.json");
      const cfg: OpenClawConfig = {
        session: { store: storePath },
        agents: { entries: { main: { default: true }, ops: {} } },
      };
      const unsuffixedPath = resolveSqliteTargetFromSessionStorePath(storePath).path;
      registerOpenClawAgentDatabase({ agentId: "ops", env, path: unsuffixedPath });
      await replaceSessionEntry(
        {
          agentId: "ops",
          defaultAgentId: "main",
          env,
          storePath,
          sessionKey: "main",
        },
        { sessionId: "ops-session", updatedAt: 1 },
      );
      const diagnostics: string[] = [];

      expect(resolveSessionStoreTargets(cfg, { allAgents: true }, { env, diagnostics })).toEqual([
        { agentId: "main", storePath },
        { agentId: "ops", storePath },
      ]);
      expect(diagnostics).toContainEqual(
        expect.stringContaining('owner "ops" selected by database-registry'),
      );
      expect(resolveExistingAgentSessionStoreTargetsSync(cfg, "main", { env })).toEqual([]);
    });
  });

  it("honors durable database ownership after its registry row is removed", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storePath = path.join(home, "ops.json");
      await replaceSessionEntry(
        {
          agentId: "ops",
          defaultAgentId: "ops",
          env,
          storePath,
          sessionKey: "agent:ops:main",
        },
        { sessionId: "ops-session", updatedAt: 1 },
      );
      const unsuffixedPath = resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: "ops",
        defaultAgentId: "ops",
        env,
      }).path;
      unregisterOpenClawAgentDatabase({ agentId: "ops", env, path: unsuffixedPath });

      expect(
        resolveSqliteTargetFromSessionStorePath(storePath, {
          agentId: "ops",
          defaultAgentId: "main",
          env,
        }).path,
      ).toBe(unsuffixedPath);
      expect(
        resolveSqliteTargetFromSessionStorePath(storePath, {
          agentId: "main",
          defaultAgentId: "main",
          env,
        }).path,
      ).toBe(path.join(home, "ops.main.sqlite"));

      const diagnostics: string[] = [];
      const cfg: OpenClawConfig = {
        session: { store: storePath },
        agents: { entries: { main: { default: true }, ops: {} } },
      };
      expect(resolveSessionStoreTargets(cfg, { allAgents: true }, { env, diagnostics })).toEqual([
        { agentId: "main", storePath },
        { agentId: "ops", storePath },
      ]);
      expect(diagnostics).toContainEqual(
        expect.stringContaining('owner "ops" selected by database-path'),
      );
    });
  });

  it("does not let a scoped losing owner claim an unregistered fixed-store database", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storePath = path.join(home, "ops.json");
      const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: "main",
      }).path;
      const cfg: OpenClawConfig = {
        session: { store: storePath },
        agents: { entries: { main: { default: true }, ops: {} } },
      };
      await replaceSessionEntry(
        { agentId: "main", env, storePath, sessionKey: "main" },
        { sessionId: "main-session", updatedAt: 1 },
      );
      unregisterOpenClawAgentDatabase({ agentId: "main", env, path: databasePath });

      expect(resolveExistingAgentSessionStoreTargetsSync(cfg, "ops", { env })).toEqual([]);
      expect(resolveExistingAgentSessionStoreTargetsSync(cfg, "main", { env })).toEqual([
        { agentId: "main", storePath },
      ]);
    });
  });

  it("keeps ambiguous registry ownership off the unsuffixed target", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storePath = path.join(home, "ops.json");
      const databasePath = resolveSqliteTargetFromSessionStorePath(storePath).path;
      registerOpenClawAgentDatabase({ agentId: "ops", env, path: databasePath });
      registerOpenClawAgentDatabase({ agentId: "main", env, path: databasePath });
      const cfg: OpenClawConfig = {
        session: { store: storePath },
        agents: { entries: { main: { default: true }, ops: {} } },
      };
      const diagnostics: string[] = [];

      expect(resolveSessionStoreTargets(cfg, { allAgents: true }, { env, diagnostics })).toEqual([
        { agentId: "main", storePath },
        { agentId: "ops", storePath },
      ]);
      expect(diagnostics).toContainEqual(
        expect.stringContaining("registry ownership is ambiguous"),
      );
    });
  });

  it("prefers a canonical database-path owner over a conflicting registry row", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      const databasePath = resolveSqliteTargetFromSessionStorePath(storePath).path;
      registerOpenClawAgentDatabase({ agentId: "ops", env, path: databasePath });
      const cfg: OpenClawConfig = {
        session: { store: storePath },
        agents: { entries: { main: { default: true }, ops: {} } },
      };

      expect(resolveSessionStoreTargets(cfg, { allAgents: true }, { env })).toEqual([
        { agentId: "main", storePath },
      ]);
    });
  });

  it("fails closed when the ownership registry cannot be read", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const registryPath = resolveOpenClawStateSqlitePath(env);
      await fs.mkdir(path.dirname(registryPath), { recursive: true });
      await fs.writeFile(registryPath, "not a sqlite database", "utf-8");
      const cfg: OpenClawConfig = {
        session: { store: path.join(home, "ops.json") },
        agents: { entries: { main: { default: true }, ops: {} } },
      };

      expect(() => resolveSessionStoreTargets(cfg, { allAgents: true }, { env })).toThrow();
    });
  });

  it("uses the path-owned agent id for explicit agent store paths", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const storePaths = await createAgentSessionStores(stateDir, ["codex-proof"]);
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };

      expect(
        resolveSessionStoreTargets(
          EXPLICIT_MAIN_CONFIG,
          { store: storePaths["codex-proof"] },
          { env },
        ),
      ).toEqual([
        {
          agentId: "codex-proof",
          storePath: storePaths["codex-proof"],
        },
      ]);
    });
  });

  it("keeps arbitrary explicit store paths on the default agent", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "backups", "sessions", "sessions.json");

      expect(resolveSessionStoreTargets(EXPLICIT_MAIN_CONFIG, { store: storePath })).toEqual([
        {
          agentId: "main",
          storePath,
        },
      ]);
    });
  });

  it("uses the persisted owner when --store targets the configured fixed store", () => {
    const storePath = path.resolve("/tmp/restart-shaped-shared.sqlite");
    const cfg: OpenClawConfig = {
      session: { store: storePath },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { research: {}, ops: {} },
      },
    };

    expect(resolveSessionStoreTargets(cfg, { store: storePath })).toEqual([
      { agentId: "ops", storePath },
    ]);
    expect(() => resolveSessionStoreTargets(cfg, { agent: "research", store: storePath })).toThrow(
      'Session store belongs to agent "ops", not requested agent "research"',
    );
  });

  it("rejects a path-inferred agent that conflicts with the persisted fixed-store owner", () => {
    const storePath = path.resolve("/tmp/agents/research/sessions/sessions.json");
    const cfg: OpenClawConfig = {
      session: { store: storePath },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    };

    expect(() => resolveSessionStoreTargets(cfg, { store: storePath })).toThrow(
      'Session store belongs to agent "research", not requested agent "ops"',
    );
  });

  it("allows an explicit store path with an explicit fleet agent", () => {
    const storePath = path.resolve("/tmp/explicit-fleet-sessions.json");
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { Ops: {}, research: {} } },
    };

    expect(resolveSessionStoreTargets(cfg, { agent: "ops", store: storePath })).toEqual([
      { agentId: "ops", storePath },
    ]);
    expect(() =>
      resolveSessionStoreTargets(cfg, {
        agent: "ops",
        store: path.resolve("/tmp/agents/research/sessions/sessions.json"),
      }),
    ).toThrow('Session store belongs to agent "research", not requested agent "ops"');
  });

  it("accepts case-insensitive legacy main paths but rejects aliases", () => {
    const cfg: OpenClawConfig = { agents: { list: [{ id: "ops", default: true }] } };
    const mainPath = path.resolve("/tmp/agents/Main/sessions/sessions.json");

    expect(resolveSessionStoreTargets(cfg, { store: mainPath })).toEqual([
      { agentId: "main", storePath: mainPath },
    ]);
    for (const alias of ["main!", "main "]) {
      const storePath = path.resolve("/tmp/agents", alias, "sessions", "sessions.json");
      expect(resolveSessionStoreTargets(cfg, { store: storePath })).toEqual([
        { agentId: "ops", storePath },
      ]);
    }
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
