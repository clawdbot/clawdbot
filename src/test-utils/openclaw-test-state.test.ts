// Tests isolated OpenClaw test-state setup and cleanup behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import {
  closeAuthProfileReadPool,
  resolveAuthProfileDatabasePath,
} from "../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import {
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
} from "../config/sessions/session-transcript-reconcile.js";
import {
  GATEWAY_STARTUP_MUTATED_ENV_KEYS,
  snapshotGatewayStartupEnv,
} from "../gateway/test-helpers.env.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { createOpenClawTestState, withOpenClawTestState } from "../plugin-sdk/test-state.js";
import {
  closeOpenClawAgentDatabaseByPath,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseByPath,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue, withEnvAsync } from "./env.js";
import * as sessionCleanup from "./session-state-cleanup.js";

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.stat(targetPath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`expected missing path: ${targetPath}`);
}

describe("openclaw test state", () => {
  it.each([
    { stage: "realpath", layout: "home" },
    { stage: ".openclaw", layout: "home" },
    { stage: "workspace", layout: "state-only" },
    { stage: "home", layout: "split" },
    { stage: "config", layout: "split" },
    { stage: "environment", layout: "home" },
  ] as const)("rolls back $stage acquisition in $layout layout", async ({ stage, layout }) => {
    const parent = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "test-state-acquisition-")),
    );
    const prefix = path.join(path.basename(parent), "fixture-");
    const unrelated = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: path.join(parent, "unrelated") },
    });
    try {
      await withEnvAsync(
        {
          OPENCLAW_AGENT_DIR: path.join(parent, "previous-agent"),
          PI_CODING_AGENT_DIR: path.join(parent, "previous-legacy-agent"),
          OPENCLAW_ACQUISITION_EMPTY: "",
          OPENCLAW_ACQUISITION_ABSENT: undefined,
        },
        async () => {
          const keys = [
            "HOME",
            "USERPROFILE",
            "HOMEDRIVE",
            "HOMEPATH",
            "OPENCLAW_HOME",
            "OPENCLAW_STATE_DIR",
            "OPENCLAW_CONFIG_PATH",
            "OPENCLAW_AGENT_DIR",
            "PI_CODING_AGENT_DIR",
            "OPENCLAW_ACQUISITION_EMPTY",
            "OPENCLAW_ACQUISITION_ABSENT",
          ];
          const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
          const snapshot = captureEnv(keys);
          const fault = new Error(`failed ${stage} acquisition`);
          const mkdir = fs.mkdir;
          const writeFile = fs.writeFile;
          const set = Reflect.set;
          const cleanupSpy = vi.spyOn(sessionCleanup, "cleanupSessionStateForTest");
          const faultSpy =
            stage === "realpath"
              ? vi.spyOn(fs, "realpath").mockRejectedValueOnce(fault)
              : stage === "config"
                ? vi.spyOn(fs, "writeFile").mockImplementationOnce(async (...args) => {
                    await writeFile(...args);
                    throw fault;
                  })
                : stage === "environment"
                  ? vi.spyOn(Reflect, "set").mockImplementation((...args) => {
                      const result = set(...args);
                      const [target, key] = args;
                      if (target === process.env && key === "HOME") {
                        faultSpy.mockRestore();
                        throw fault;
                      }
                      return result;
                    })
                  : vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
                      const result = await mkdir(...args);
                      if (path.basename(String(args[0])) === stage) {
                        throw fault;
                      }
                      return result;
                    });
          try {
            await expect(
              createOpenClawTestState({
                prefix,
                layout,
                scenario: "minimal",
                applyEnv: stage !== "config",
                env: {
                  OPENCLAW_ACQUISITION_EMPTY: "changed",
                  OPENCLAW_ACQUISITION_ABSENT: "added",
                },
              }),
            ).rejects.toBe(fault);
            expect(Object.fromEntries(keys.map((key) => [key, process.env[key]]))).toEqual(
              previous,
            );
            expect(await fs.readdir(parent)).toEqual(["unrelated"]);
            expect(unrelated.db.isOpen).toBe(true);
            expect(cleanupSpy).not.toHaveBeenCalled();
            faultSpy.mockRestore();

            const recovered = await createOpenClawTestState({
              prefix,
              layout: "split",
              scenario: "minimal",
              applyEnv: false,
            });
            try {
              expect(Object.fromEntries(keys.map((key) => [key, process.env[key]]))).toEqual(
                previous,
              );
              expect(recovered.configPath).toBe(
                path.join(recovered.root, "config", "openclaw.json"),
              );
              expect(JSON.parse(await fs.readFile(recovered.configPath, "utf8"))).toEqual({});
              recovered.applyEnv();
              expect(process.env.HOME).toBe(recovered.home);
              expect(process.env.OPENCLAW_STATE_DIR).toBe(recovered.stateDir);
            } finally {
              await recovered.cleanup();
            }
            await recovered.cleanup();
            expect(Object.fromEntries(keys.map((key) => [key, process.env[key]]))).toEqual(
              previous,
            );
            expect(await fs.readdir(parent)).toEqual(["unrelated"]);
            expect(unrelated.db.isOpen).toBe(true);
          } finally {
            faultSpy.mockRestore();
            cleanupSpy.mockRestore();
            snapshot.restore();
          }
        },
      );
    } finally {
      closeOpenClawStateDatabaseByPath(unrelated.path);
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("creates an isolated home layout with spawn env and restores process env", async () => {
    const previousHome = process.env.HOME;
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const previousGatewayStartupEnv = snapshotGatewayStartupEnv();

    const state = await createOpenClawTestState({
      label: "unit",
      scenario: "minimal",
    });

    try {
      expect(state.home).toBe(path.join(state.root, "home"));
      expect(state.stateDir).toBe(path.join(state.home, ".openclaw"));
      expect(state.configPath).toBe(path.join(state.stateDir, "openclaw.json"));
      expect(state.workspaceDir).toBe(path.join(state.home, "workspace"));
      expect(state.env.HOME).toBe(state.home);
      expect(state.env.OPENCLAW_HOME).toBe(state.home);
      expect(state.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
      expect(state.env.OPENCLAW_CONFIG_PATH).toBe(state.configPath);
      expect(process.env.HOME).toBe(state.home);
      expect(process.env.OPENCLAW_HOME).toBe(state.home);
      expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toStrictEqual({});
      for (const key of GATEWAY_STARTUP_MUTATED_ENV_KEYS) {
        setTestEnvValue(key, `mutated-${key}`);
      }
    } finally {
      await state.cleanup();
    }

    expect(process.env.HOME).toBe(previousHome);
    expect(process.env.OPENCLAW_HOME).toBe(previousOpenClawHome);
    expect(process.env.OPENCLAW_STATE_DIR).toBe(previousStateDir);
    expect(process.env.OPENCLAW_CONFIG_PATH).toBe(previousConfigPath);
    expect(snapshotGatewayStartupEnv()).toEqual(previousGatewayStartupEnv);
    await expectPathMissing(state.root);
  });

  it("supports state-only layout without overriding HOME", async () => {
    const previousHome = process.env.HOME;

    await withOpenClawTestState(
      {
        layout: "state-only",
        scenario: "empty",
      },
      async (state) => {
        expect(process.env.HOME).toBe(previousHome);
        expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
        expect(process.env.OPENCLAW_CONFIG_PATH).toBe(state.configPath);
        expect(state.env.HOME).toBe(previousHome);
        await expectPathMissing(state.configPath);
      },
    );
  });

  it.each([
    { agentEnv: undefined, applyEnv: true },
    { agentEnv: undefined, applyEnv: false },
    { agentEnv: "main", applyEnv: true },
    { agentEnv: "main", applyEnv: false },
  ] as const)(
    "isolates inherited agent selectors with $agentEnv and applyEnv=$applyEnv",
    async ({ agentEnv, applyEnv }) => {
      const inherited = {
        OPENCLAW_AGENT_DIR: "/tmp/outside-openclaw-agent",
        PI_CODING_AGENT_DIR: "/tmp/outside-legacy-agent",
      };
      await withEnvAsync(inherited, async () => {
        const state = await createOpenClawTestState({
          layout: agentEnv === "main" ? "home" : "state-only",
          agentEnv,
          applyEnv,
        });

        try {
          const expectedAgentDir = agentEnv === "main" ? state.agentDir() : undefined;
          expect(state.env.OPENCLAW_AGENT_DIR).toBe(expectedAgentDir);
          expect(state.env.PI_CODING_AGENT_DIR).toBeUndefined();
          expect(process.env.OPENCLAW_AGENT_DIR).toBe(
            applyEnv ? expectedAgentDir : inherited.OPENCLAW_AGENT_DIR,
          );
          expect(process.env.PI_CODING_AGENT_DIR).toBe(
            applyEnv ? undefined : inherited.PI_CODING_AGENT_DIR,
          );
          expect(state.agentDir()).toBe(path.join(state.stateDir, "agents", "main", "agent"));
        } finally {
          await state.cleanup();
        }

        expect(process.env.OPENCLAW_AGENT_DIR).toBe(inherited.OPENCLAW_AGENT_DIR);
        expect(process.env.PI_CODING_AGENT_DIR).toBe(inherited.PI_CODING_AGENT_DIR);
      });
    },
  );

  it.each([undefined, "main"] as const)(
    "allows explicit agent-dir overrides with agentEnv=%s and restores absent or empty selectors",
    async (agentEnv) => {
      await withEnvAsync({ OPENCLAW_AGENT_DIR: undefined, PI_CODING_AGENT_DIR: "" }, async () => {
        const overrides = {
          OPENCLAW_AGENT_DIR: "/tmp/explicit-openclaw-agent",
          PI_CODING_AGENT_DIR: "/tmp/explicit-legacy-agent",
        };
        const state = await createOpenClawTestState({ agentEnv, applyEnv: false, env: overrides });
        try {
          expect(state.env.OPENCLAW_AGENT_DIR).toBe(overrides.OPENCLAW_AGENT_DIR);
          expect(state.env.PI_CODING_AGENT_DIR).toBe(overrides.PI_CODING_AGENT_DIR);
          expect(process.env.OPENCLAW_AGENT_DIR).toBeUndefined();
          expect(process.env.PI_CODING_AGENT_DIR).toBe("");
          state.applyEnv();
          expect(process.env.OPENCLAW_AGENT_DIR).toBe(overrides.OPENCLAW_AGENT_DIR);
          expect(process.env.PI_CODING_AGENT_DIR).toBe(overrides.PI_CODING_AGENT_DIR);
        } finally {
          await state.cleanup();
        }
        expect(process.env.OPENCLAW_AGENT_DIR).toBeUndefined();
        expect(process.env.PI_CODING_AGENT_DIR).toBe("");
      });
    },
  );

  it("writes scenario configs and auth profile stores", async () => {
    await withOpenClawTestState(
      {
        scenario: "update-stable",
      },
      async (state) => {
        expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toEqual({
          update: {
            channel: "stable",
          },
          plugins: {},
        });

        const profilePath = await state.writeAuthProfiles({
          version: 1,
          profiles: {
            "openai:test": {
              type: "api_key",
              provider: "openai",
              key: "sk-test",
            },
          },
        });

        expect(profilePath).toBe(path.join(state.agentDir(), "openclaw-agent.sqlite"));
        const profiles = loadPersistedAuthProfileStore(state.agentDir());
        expect(profiles?.version).toBe(1);
        expect(profiles?.profiles["openai:test"]?.provider).toBe("openai");
      },
    );
  });

  it("closes only fixture-owned databases before restoring env", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const unrelatedRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-test-state-unrelated-"),
    );
    const unrelatedEnv = {
      ...process.env,
      OPENCLAW_STATE_DIR: path.join(unrelatedRoot, "state"),
    };
    const state = await createOpenClawTestState({
      layout: "state-only",
      label: "database-cleanup",
    });
    const authStore = {
      version: 1,
      profiles: {
        "openai:test": {
          type: "api_key" as const,
          provider: "openai",
          key: "sk-test",
        },
      },
    };
    const fixtureAuthDir = state.agentDir("auth-reader");
    const fixtureAuthPath = resolveAuthProfileDatabasePath(fixtureAuthDir);
    saveAuthProfileStore(authStore, fixtureAuthDir, {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    });
    const unrelatedAgentDir = path.join(unrelatedRoot, "state", "agents", "outside", "agent");
    saveAuthProfileStore(authStore, unrelatedAgentDir, {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    });
    const fixtureShared = openOpenClawStateDatabase({ env: state.env });
    const fixtureAgent = openOpenClawAgentDatabase({
      agentId: "worker",
      env: state.env,
    });
    const unrelatedShared = openOpenClawStateDatabase({ env: unrelatedEnv });
    const unrelatedAgent = openOpenClawAgentDatabase({
      agentId: "outside",
      env: unrelatedEnv,
    });
    const openSpy = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
    expect(loadPersistedAuthProfileStore(state.agentDir("auth-reader"))).not.toBeNull();
    expect(loadPersistedAuthProfileStore(unrelatedAgentDir)).not.toBeNull();
    const readOnlyDatabases = openSpy.mock.calls.flatMap((call, index) => {
      if (call[1]?.readOnly !== true) {
        return [];
      }
      const database = openSpy.mock.results[index]?.value as DatabaseSync | undefined;
      return database ? [{ path: path.resolve(call[0]), database }] : [];
    });
    const fixtureAuthReader = readOnlyDatabases.find(
      (entry) => entry.path === path.resolve(fixtureAuthPath),
    )?.database;
    const unrelatedAuthReader = readOnlyDatabases.find(
      (entry) => entry.path === path.resolve(unrelatedAgent.path),
    )?.database;
    if (!fixtureAuthReader || !unrelatedAuthReader) {
      throw new Error("expected fixture and unrelated pooled auth readers");
    }
    expect(fixtureAuthReader.isOpen).toBe(true);
    expect(unrelatedAuthReader.isOpen).toBe(true);
    const restoreEnv = state.restoreEnv;
    const originalRm = fs.rm;
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation((...args) => {
      expect(fixtureAuthReader.isOpen).toBe(false);
      expect(unrelatedAuthReader.isOpen).toBe(true);
      return originalRm(...args);
    });
    state.restoreEnv = () => {
      expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
      expect(fixtureAuthReader.isOpen).toBe(false);
      expect(fixtureShared.db.isOpen).toBe(false);
      expect(fixtureAgent.db.isOpen).toBe(false);
      expect(unrelatedAuthReader.isOpen).toBe(true);
      expect(unrelatedShared.db.isOpen).toBe(true);
      expect(unrelatedAgent.db.isOpen).toBe(true);
      restoreEnv();
    };

    try {
      await state.cleanup();

      expect(process.env.OPENCLAW_STATE_DIR).toBe(previousStateDir);
      expect(rmSpy).toHaveBeenCalledWith(state.root, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 25,
      });
      await expectPathMissing(state.root);
      expect(unrelatedAuthReader.isOpen).toBe(true);
      expect(unrelatedShared.db.isOpen).toBe(true);
      expect(unrelatedAgent.db.isOpen).toBe(true);
    } finally {
      state.restoreEnv = restoreEnv;
      restoreEnv();
      closeAuthProfileReadPool({ kind: "database", databasePath: fixtureAuthPath });
      closeAuthProfileReadPool({ kind: "database", databasePath: unrelatedAgent.path });
      closeOpenClawAgentDatabaseByPath(fixtureAgent.path);
      closeOpenClawAgentDatabaseByPath(unrelatedAgent.path);
      closeOpenClawStateDatabaseByPath(fixtureShared.path);
      closeOpenClawStateDatabaseByPath(unrelatedShared.path);
      openSpy.mockRestore();
      rmSpy.mockRestore();
      await fs.rm(state.root, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 25,
      });
      await fs.rm(unrelatedRoot, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 25,
      });
    }
  });

  it("does not recreate fixture databases from a deferred transcript reconcile", async () => {
    const state = await createOpenClawTestState({ label: "deferred-reconcile" });
    const options = { agentId: "main", env: state.env };
    const agent = openOpenClawAgentDatabase(options);
    const shared = openOpenClawStateDatabase({ env: state.env });
    const realSetImmediate = globalThis.setImmediate;
    let resumeReconcile: (() => void) | undefined;
    const immediateSpy = vi.spyOn(globalThis, "setImmediate").mockImplementationOnce((callback) => {
      resumeReconcile = () => callback();
      return realSetImmediate(() => undefined);
    });
    const originalRm = fs.rm;
    let removalStarted = false;
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation((...args) => {
      if (args[0] === state.root) {
        removalStarted = true;
      }
      return originalRm(...args);
    });
    const openSpy = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
    let cleanup: Promise<void> | undefined;
    let reconcile: Promise<void> | undefined;
    try {
      startSessionTranscriptIndexReconcile(options);
      reconcile = waitForSessionTranscriptIndexReconcile(options);
      expect(resumeReconcile).toBeDefined();
      cleanup = state.cleanup();

      // Empty drains settle before this real event-loop checkpoint. Old cleanup
      // reaches rm; repaired cleanup must keep the fixture alive for the owner.
      await new Promise<void>((resolve) => {
        realSetImmediate(resolve);
      });
      if (removalStarted) {
        await cleanup;
        expect(agent.db.isOpen).toBe(false);
        await expectPathMissing(state.root);
      } else {
        expect(agent.db.isOpen).toBe(true);
        expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
      }
      resumeReconcile?.();
      await reconcile;
      await cleanup;

      await expectPathMissing(state.root);
      await expectPathMissing(agent.path);
      await expectPathMissing(shared.path);
      expect(isOpenClawAgentDatabaseOpen(agent.path)).toBe(false);
      expect(agent.db.isOpen).toBe(false);
      expect(shared.db.isOpen).toBe(false);
      expect(openSpy.mock.calls.filter(([pathname]) => pathname === agent.path)).toEqual([]);
    } finally {
      immediateSpy.mockRestore();
      resumeReconcile?.();
      await reconcile;
      await cleanup;
      await state.cleanup();
      openSpy.mockRestore();
      rmSpy.mockRestore();
      // cleanup is idempotent, so explicitly dispose anything the pre-fix
      // reconcile recreated after it returned.
      closeOpenClawAgentDatabaseByPath(agent.path);
      closeOpenClawStateDatabaseByPath(shared.path);
      await fs.rm(state.root, { recursive: true, force: true });
    }
  });

  it("preserves callback failures after closing fixture databases", async () => {
    const callbackError = new Error("fixture callback failed");
    let root = "";
    let shared: ReturnType<typeof openOpenClawStateDatabase> | undefined;
    let agent: ReturnType<typeof openOpenClawAgentDatabase> | undefined;

    await expect(
      withOpenClawTestState({ layout: "state-only", label: "callback-failure" }, async (state) => {
        root = state.root;
        shared = openOpenClawStateDatabase({ env: state.env });
        agent = openOpenClawAgentDatabase({
          agentId: "main",
          env: state.env,
        });
        throw callbackError;
      }),
    ).rejects.toBe(callbackError);

    expect(shared?.db.isOpen).toBe(false);
    expect(agent?.db.isOpen).toBe(false);
    await expectPathMissing(root);
  });

  it("creates upgrade survivor fixture state", async () => {
    await withOpenClawTestState(
      {
        scenario: "upgrade-survivor",
      },
      async (state) => {
        const config = JSON.parse(await fs.readFile(state.configPath, "utf8"));
        expect(config.update?.channel).toBe("stable");
        expect(config.plugins?.enabled).toBe(true);
        expect(config.plugins?.allow).toStrictEqual(["discord", "telegram", "whatsapp", "memory"]);
      },
    );
  });

  it("keeps external-service env scoped to the fixture", async () => {
    const previousPolicy = process.env.OPENCLAW_SERVICE_REPAIR_POLICY;

    await withOpenClawTestState(
      {
        scenario: "external-service",
      },
      async (state) => {
        expect(process.env.OPENCLAW_SERVICE_REPAIR_POLICY).toBe("external");
        expect(state.env.OPENCLAW_SERVICE_REPAIR_POLICY).toBe("external");
      },
    );

    expect(process.env.OPENCLAW_SERVICE_REPAIR_POLICY).toBe(previousPolicy);
  });
});
