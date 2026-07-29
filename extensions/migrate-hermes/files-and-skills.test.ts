// Migrate Hermes tests cover files and skills plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadAuthProfileStoreWithoutExternalProfiles } from "openclaw/plugin-sdk/agent-runtime";
import { MIGRATION_REASON_TARGET_EXISTS } from "openclaw/plugin-sdk/migration";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAuthItems } from "./auth.js";
import { buildHermesMigrationProvider } from "./provider.js";
import { discoverHermesSource } from "./source.js";
import { resolveTargets } from "./targets.js";
import { cleanupTempRoots, makeContext, makeTempRoot, writeFile } from "./test/provider-helpers.js";

describe("Hermes migration file and skill items", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempRoots();
  });

  function configRuntime(config: Record<string, unknown>) {
    return {
      config: {
        current: () => config,
        mutateConfigFile: async ({
          mutate,
        }: {
          mutate: (draft: Record<string, unknown>) => void | Promise<void>;
        }) => {
          const next = structuredClone(config);
          await mutate(next);
          Object.keys(config).forEach((key) => {
            delete config[key];
          });
          Object.assign(config, next);
          return { nextConfig: next };
        },
      },
    } as never;
  }

  function itemById<T extends { id: string }>(items: T[], id: string): T | undefined {
    return items.find((item) => item.id === id);
  }

  function fakeJwt(payload: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${header}.${body}.signature`;
  }

  const hermesAccessField = ["access", "token"].join("_");
  const hermesRefreshField = ["refresh", "token"].join("_");

  it("discovers nested skills while pruning inactive packages", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    await writeFile(path.join(source, "skills", "coding", "review", "SKILL.md"), "# Review\n");
    await writeFile(
      path.join(source, "skills", "coding", "review", "subskills", "lint", "SKILL.md"),
      "# Lint\n",
    );
    await writeFile(
      path.join(source, "skills", "coding", "review", "references", "old", "SKILL.md"),
      "# Old\n",
    );
    await writeFile(path.join(source, "skills", ".archive", "retired", "SKILL.md"), "# Old\n");

    const plan = await buildHermesMigrationProvider().plan(
      makeContext({ source, stateDir, workspaceDir }),
    );
    const skills = plan.items.filter((item) => item.kind === "skill");
    expect(skills).toHaveLength(2);
    expect(itemById(skills, "skill:coding:review")).toEqual(
      expect.objectContaining({
        id: "skill:coding:review",
        source: path.join(source, "skills", "coding", "review"),
        target: path.join(workspaceDir, "skills", "review"),
      }),
    );
    expect(itemById(skills, "skill:coding:review:subskills:lint")).toEqual(
      expect.objectContaining({
        source: path.join(source, "skills", "coding", "review", "subskills", "lint"),
        target: path.join(workspaceDir, "skills", "lint"),
      }),
    );
  });

  it("resolves HERMES_HOME through active_profile unless it already names a profile", async () => {
    const root = await makeTempRoot();
    const hermesRoot = path.join(root, "hermes");
    const profileRoot = path.join(hermesRoot, "profiles", "coder");
    await writeFile(path.join(hermesRoot, "active_profile"), "coder\n");
    await writeFile(path.join(profileRoot, "memories", "MEMORY.md"), "coder memory\n");

    expect(
      (
        await discoverHermesSource(undefined, {
          env: { HERMES_HOME: hermesRoot },
          platform: "darwin",
        })
      ).root,
    ).toBe(profileRoot);
    expect(
      (
        await discoverHermesSource(undefined, {
          env: { HERMES_HOME: profileRoot },
          platform: "darwin",
        })
      ).root,
    ).toBe(profileRoot);
    // Supervised default slot pins to the root profile, ignoring active_profile.
    expect(
      (
        await discoverHermesSource(undefined, {
          env: { HERMES_HOME: hermesRoot, HERMES_S6_SUPERVISED_CHILD: "1" },
          platform: "darwin",
        })
      ).root,
    ).toBe(hermesRoot);
  });

  it("honors implicit Hermes active profiles and Windows legacy state", async () => {
    const root = await makeTempRoot();
    const home = path.join(root, "home");
    const defaultRoot = path.join(home, ".hermes");
    const profileRoot = path.join(defaultRoot, "profiles", "coder");
    await writeFile(path.join(defaultRoot, "active_profile"), "coder\n");
    await writeFile(path.join(profileRoot, "config.yaml"), "model: openai/gpt-5.6\n");

    expect(
      (await discoverHermesSource(undefined, { env: { HOME: home }, platform: "darwin" })).root,
    ).toBe(profileRoot);
    expect((await discoverHermesSource(profileRoot)).root).toBe(profileRoot);

    await writeFile(path.join(defaultRoot, "active_profile"), "../escape\n");
    expect(
      (await discoverHermesSource(undefined, { env: { HOME: home }, platform: "darwin" })).root,
    ).toBe(defaultRoot);

    const windowsHome = path.join(root, "windows-home");
    const localAppData = path.join(windowsHome, "AppData", "Local");
    const nativeWindowsRoot = path.join(localAppData, "hermes");
    const legacyWindowsRoot = path.join(windowsHome, ".hermes");
    await writeFile(path.join(legacyWindowsRoot, "config.yaml"), "model: legacy\n");
    expect(
      (
        await discoverHermesSource(undefined, {
          env: { LOCALAPPDATA: localAppData, USERPROFILE: windowsHome },
          platform: "win32",
        })
      ).root,
    ).toBe(legacyWindowsRoot);
    await writeFile(path.join(nativeWindowsRoot, "config.yaml"), "model: current\n");
    expect(
      (
        await discoverHermesSource(undefined, {
          env: { LOCALAPPDATA: localAppData, USERPROFILE: windowsHome },
          platform: "win32",
        })
      ).root,
    ).toBe(nativeWindowsRoot);

    const personaHome = path.join(root, "persona-home");
    const personaLocalAppData = path.join(personaHome, "AppData", "Local");
    const personaLegacyRoot = path.join(personaHome, ".hermes");
    await writeFile(path.join(personaLegacyRoot, "SOUL.md"), "Legacy persona\n");
    expect(
      (
        await discoverHermesSource(undefined, {
          env: { LOCALAPPDATA: personaLocalAppData, USERPROFILE: personaHome },
          platform: "win32",
        })
      ).root,
    ).toBe(personaLegacyRoot);
  });

  it("uses global Hermes auth per provider when the active profile has no local entry", async () => {
    const root = await makeTempRoot();
    const home = path.join(root, "home");
    const hermesRoot = path.join(home, ".hermes");
    const profileRoot = path.join(hermesRoot, "profiles", "coder");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const access = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-global" },
      "https://api.openai.com/profile": { email: "global@example.test" },
    });
    await writeFile(path.join(hermesRoot, "active_profile"), "coder\n");
    await writeFile(path.join(profileRoot, "config.yaml"), "model: openai/gpt-5.6\n");
    await writeFile(path.join(profileRoot, "auth.json"), JSON.stringify({ providers: {} }));
    await writeFile(
      path.join(hermesRoot, "auth.json"),
      JSON.stringify({
        providers: {
          "openai-codex": {
            tokens: {
              [hermesAccessField]: access,
              [hermesRefreshField]: "global-refresh",
            },
          },
        },
      }),
    );

    const source = await discoverHermesSource(undefined, {
      env: { HOME: home },
      platform: "darwin",
    });
    expect(source.root).toBe(profileRoot);
    expect(source.globalAuthPath).toBe(path.join(hermesRoot, "auth.json"));
    const ctx = makeContext({ source: profileRoot, stateDir, workspaceDir, includeSecrets: true });
    const items = await buildAuthItems({ ctx, source, targets: resolveTargets(ctx) });
    expect(items).toEqual([
      expect.objectContaining({
        source: path.join(hermesRoot, "auth.json"),
        details: expect.objectContaining({ provider: "openai" }),
      }),
    ]);
  });

  it("maps supported OAuth model providers and requests fresh OpenClaw authentication", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const xaiProvider = ["xai", "oauth"].join("-");
    const minimaxProvider = ["minimax", "oauth"].join("-");
    await writeFile(
      path.join(source, "config.yaml"),
      `model:\n  provider: ${xaiProvider}\n  default: grok-4.1-fast\n`,
    );
    await writeFile(
      path.join(source, "auth.json"),
      JSON.stringify({
        providers: {
          anthropic: {},
          nous: {},
          "qwen-oauth": {},
          "qwen-cli": {},
          "qwen-portal": {},
          [xaiProvider]: {},
          [minimaxProvider]: {},
        },
      }),
    );

    const plan = await buildHermesMigrationProvider().plan(
      makeContext({
        source,
        stateDir: path.join(root, "state"),
        workspaceDir: path.join(root, "workspace"),
      }),
    );

    expect(itemById(plan.items, "config:default-model")?.details?.model).toBe("xai/grok-4.1-fast");
    const reauthItems = plan.items.filter(
      (item) => item.kind === "manual" && item.message?.includes("credentials cannot be reused"),
    );
    expect(reauthItems.map((item) => item.reason)).toEqual([
      "Authenticate anthropic in OpenClaw after migration.",
      "Authenticate nous in OpenClaw after migration.",
      "Authenticate qwen with an API key after migration: openclaw onboard --auth-choice qwen-api-key.",
      "Authenticate minimax-portal in OpenClaw after migration.",
      "Authenticate xai in OpenClaw after migration.",
    ]);
  });

  it("requests reauthentication only for OAuth credential-pool entries", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    await writeFile(path.join(source, "config.yaml"), "{}\n");
    await writeFile(
      path.join(source, "auth.json"),
      JSON.stringify({
        credential_pool: {
          anthropic: [{ auth_type: "api_key" }],
          nous: [{ auth_type: "oauth" }],
        },
      }),
    );

    const plan = await buildHermesMigrationProvider().plan(
      makeContext({
        source,
        stateDir: path.join(root, "state"),
        workspaceDir: path.join(root, "workspace"),
      }),
    );

    expect(
      plan.items
        .filter((item) => item.id.startsWith("manual:auth-reauthenticate:"))
        .map((item) => item.id),
    ).toEqual(["manual:auth-reauthenticate:nous"]);
  });

  async function expectPathMissing(targetPath: string): Promise<void> {
    try {
      await fs.access(targetPath);
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
      return;
    }
    throw new Error(`Expected path to be missing: ${targetPath}`);
  }

  it("reports normalized skill-name collisions instead of overwriting during apply", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    await writeFile(path.join(source, "skills", "team-a", "review", "SKILL.md"), "# A\n");
    await writeFile(path.join(source, "skills", "team-b", "review", "SKILL.md"), "# B\n");

    const provider = buildHermesMigrationProvider();
    const plan = await provider.plan(makeContext({ source, stateDir, workspaceDir }));
    const skillItems = plan.items.filter((item) => item.kind === "skill");

    expect(skillItems).toHaveLength(2);
    const reviewA = itemById(skillItems, "skill:team-a:review");
    const reviewB = itemById(skillItems, "skill:team-b:review");
    expect(reviewA?.status).toBe("conflict");
    expect(reviewA?.reason).toBe('multiple Hermes skill directories normalize to "review"');
    expect(reviewA?.target).toBe(path.join(workspaceDir, "skills", "review"));
    expect(reviewB?.status).toBe("conflict");

    const result = await provider.apply(
      makeContext({
        source,
        stateDir,
        workspaceDir,
        overwrite: true,
        reportDir: path.join(root, "report"),
      }),
    );

    expect(result.summary.conflicts).toBe(2);
    await expectPathMissing(path.join(workspaceDir, "skills", "review"));
  });

  it("reports late-created copy targets as conflicts without overwriting", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    await writeFile(path.join(source, "AGENTS.md"), "# Hermes agents\n");

    const provider = buildHermesMigrationProvider();
    const ctx = makeContext({ source, stateDir, workspaceDir, reportDir });
    const plan = await provider.plan(ctx);
    await writeFile(path.join(workspaceDir, "AGENTS.md"), "# Late agents\n");

    const result = await provider.apply(ctx, plan);

    const agents = itemById(result.items, "workspace:AGENTS.md");
    expect(agents?.status).toBe("conflict");
    expect(agents?.reason).toBe(MIGRATION_REASON_TARGET_EXISTS);
    expect(result.summary.conflicts).toBe(1);
    expect(await fs.readFile(path.join(workspaceDir, "AGENTS.md"), "utf8")).toBe("# Late agents\n");
  });

  it("applies files, appended memories, item backups, reports, and opt-in API keys", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    await writeFile(path.join(source, ".env"), "OPENAI_API_KEY=sk-hermes\n");
    await writeFile(path.join(source, "AGENTS.md"), "# Hermes agents\n");
    await writeFile(path.join(source, "memories", "MEMORY.md"), "memory line\n");
    await writeFile(path.join(source, "skills", "Ship It", "SKILL.md"), "# Ship It\n");
    await writeFile(path.join(workspaceDir, "AGENTS.md"), "# Existing agents\n");

    const provider = buildHermesMigrationProvider();
    const config: Record<string, unknown> = {};
    const result = await provider.apply(
      makeContext({
        source,
        stateDir,
        workspaceDir,
        includeSecrets: true,
        overwrite: true,
        reportDir,
        runtime: configRuntime(config),
      }),
    );

    expect(result.summary.errors).toBe(0);
    expect(result.summary.conflicts).toBe(0);
    expect(await fs.readFile(path.join(workspaceDir, "AGENTS.md"), "utf8")).toBe(
      "# Hermes agents\n",
    );
    expect(
      await fs.readFile(path.join(workspaceDir, "skills", "ship-it", "SKILL.md"), "utf8"),
    ).toBe("# Ship It\n");
    await expect(fs.access(path.join(reportDir, "summary.md"))).resolves.toBeUndefined();
    expect(await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8")).toContain(
      "Imported from Hermes",
    );
    const copiedAgentsItem = result.items.find((item) => item.id === "workspace:AGENTS.md");
    expect(String(copiedAgentsItem?.details?.backupPath)).toContain("AGENTS.md");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    try {
      const authStore = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
      expect(authStore.profiles?.["openai:hermes-import"]).toEqual(
        expect.objectContaining({
          type: "api_key",
          provider: "openai",
          key: "sk-hermes",
        }),
      );
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousAgentDir === undefined) {
        delete process.env.OPENCLAW_AGENT_DIR;
      } else {
        process.env.OPENCLAW_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("keeps repeated memory imports byte-identical", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    await writeFile(path.join(source, "memories", "MEMORY.md"), "one memory\n");
    const provider = buildHermesMigrationProvider();
    const ctx = makeContext({
      source,
      stateDir,
      workspaceDir,
      overwrite: true,
      runtime: configRuntime({}),
    });
    await provider.apply(ctx);
    const first = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8");
    const secondResult = await provider.apply(ctx);
    expect(await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8")).toBe(first);
    expect(itemById(secondResult.items, "memory:MEMORY.md")?.status).toBe("skipped");
  });

  it("fails planning on malformed Hermes YAML", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    await writeFile(path.join(source, "config.yaml"), "model: [unterminated\n");
    await expect(
      buildHermesMigrationProvider().plan(
        makeContext({
          source,
          stateDir: path.join(root, "state"),
          workspaceDir: path.join(root, "ws"),
        }),
      ),
    ).rejects.toThrow(`Failed to parse Hermes config at ${path.join(source, "config.yaml")}`);
  });

  it("archives unsupported Hermes state without copying raw auth credentials", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    await writeFile(path.join(source, "logs", "session.log"), "log line\n");
    await writeFile(path.join(source, "pairing", "approved.json"), '{"approved":[]}\n');
    await writeFile(path.join(source, "platforms", "pairing", "telegram.json"), "{}\n");
    await writeFile(path.join(source, "gateway_state.json"), '{"running":false}\n');
    await writeFile(path.join(source, "channel_directory.json"), "{}\n");
    await writeFile(path.join(source, "channel_aliases.json"), "{}\n");
    await writeFile(path.join(source, "processes.json"), "{}\n");
    await writeFile(path.join(source, "feishu_comment_pairing.json"), "{}\n");
    await writeFile(path.join(source, "auth.json"), '{"token":"opaque"}\n');
    new DatabaseSync(path.join(source, "retaindb_queue.db")).close();

    const provider = buildHermesMigrationProvider();
    const plan = await provider.plan(makeContext({ source, stateDir, workspaceDir, reportDir }));

    const plannedLogs = itemById(plan.items, "archive:logs");
    expect(plannedLogs?.kind).toBe("archive");
    expect(plannedLogs?.action).toBe("archive");
    expect(plannedLogs?.status).toBe("planned");
    for (const itemId of [
      "archive:pairing",
      "archive:platforms",
      "archive:gateway_state.json",
      "archive:channel_directory.json",
      "archive:channel_aliases.json",
      "archive:processes.json",
      "archive:feishu_comment_pairing.json",
      "archive:retaindb_queue.db",
    ]) {
      expect(itemById(plan.items, itemId)?.status).toBe("planned");
    }
    expect(plan.items.find((item) => item.id === "archive:auth.json")).toBeUndefined();
    expect(plan.warnings).toEqual([
      "Some Hermes files are archive-only. They will be copied into the migration report for manual review, not loaded into OpenClaw.",
    ]);

    const result = await provider.apply(makeContext({ source, stateDir, workspaceDir, reportDir }));

    expect(result.summary.errors).toBe(0);
    const migratedLogs = itemById(result.items, "archive:logs");
    expect(migratedLogs?.status).toBe("migrated");
    expect(migratedLogs?.target).toBe(path.join(reportDir, "archive", "logs"));
    expect(await fs.readFile(path.join(reportDir, "archive", "logs", "session.log"), "utf8")).toBe(
      "log line\n",
    );
    expect(
      await fs.readFile(path.join(reportDir, "archive", "pairing", "approved.json"), "utf8"),
    ).toBe('{"approved":[]}\n');
    expect(
      await fs.readFile(
        path.join(reportDir, "archive", "platforms", "pairing", "telegram.json"),
        "utf8",
      ),
    ).toBe("{}\n");
    await expect(
      fs.access(path.join(reportDir, "archive", "retaindb_queue.db")),
    ).resolves.toBeUndefined();
    await expectPathMissing(path.join(reportDir, "archive", "auth.json"));
    await expectPathMissing(path.join(workspaceDir, "logs", "session.log"));
  });

  it("archives committed Hermes SQLite WAL state", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    const stateDbPath = path.join(source, "state.db");
    await fs.mkdir(source, { recursive: true });

    const sourceDb = new DatabaseSync(stateDbPath);
    try {
      sourceDb.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE marker(value TEXT NOT NULL);
        PRAGMA wal_checkpoint(TRUNCATE);
      `);
      sourceDb.prepare("INSERT INTO marker(value) VALUES (?)").run("committed-only-in-wal");
      expect((await fs.stat(`${stateDbPath}-wal`)).size).toBeGreaterThan(0);

      const provider = buildHermesMigrationProvider();
      const result = await provider.apply(
        makeContext({ source, stateDir, workspaceDir, reportDir }),
      );

      const archivedState = itemById(result.items, "archive:state.db");
      const archivedStatePath = path.join(reportDir, "archive", "state.db");
      expect(archivedState?.status).toBe("migrated");
      expect(archivedState?.source).toBe(stateDbPath);
      expect(archivedState?.target).toBe(archivedStatePath);

      const archivedDb = new DatabaseSync(archivedStatePath, { readOnly: true });
      try {
        expect(archivedDb.prepare("SELECT value FROM marker").all()).toEqual([
          { value: "committed-only-in-wal" },
        ]);
        expect(archivedDb.prepare("PRAGMA integrity_check").get()).toEqual({
          integrity_check: "ok",
        });
      } finally {
        archivedDb.close();
      }
    } finally {
      sourceDb.close();
    }
  });

  it("discovers the current Hermes state database for archival", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const currentStatePath = path.join(source, "hermes_state.db");
    await fs.mkdir(source, { recursive: true });
    new DatabaseSync(currentStatePath).close();

    const plan = await buildHermesMigrationProvider().plan(
      makeContext({
        source,
        stateDir: path.join(root, "state"),
        workspaceDir: path.join(root, "workspace"),
      }),
    );

    expect(itemById(plan.items, "archive:hermes_state.db")?.source).toBe(currentStatePath);
  });

  it("preserves raw Hermes state when SQLite snapshotting fails", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    const stateDbPath = path.join(source, "state.db");
    const archivedStatePath = path.join(reportDir, "archive", "state.db");
    await writeFile(stateDbPath, "legacy non-SQLite Hermes state\n");

    const provider = buildHermesMigrationProvider();
    const result = await provider.apply(makeContext({ source, stateDir, workspaceDir, reportDir }));

    const archivedState = itemById(result.items, "archive:state.db");
    expect(archivedState?.status).toBe("error");
    expect(archivedState?.target).toBe(archivedStatePath);
    expect(archivedState?.reason).toContain(
      "SQLite snapshot failed; database recovery files preserved for manual review",
    );
    expect(await fs.readFile(path.join(archivedStatePath, "state.db"), "utf8")).toBe(
      "legacy non-SQLite Hermes state\n",
    );
    expect(result.summary.errors).toBe(1);
  });

  it("tolerates a disappearing optional SQLite recovery sidecar", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const stateDbPath = path.join(source, "state.db");
    const walPath = `${stateDbPath}-wal`;
    const reportDir = path.join(root, "report");
    await writeFile(stateDbPath, "legacy non-SQLite Hermes state\n");
    await writeFile(walPath, "transient wal\n");
    const copyFile = fs.copyFile.bind(fs);
    vi.spyOn(fs, "copyFile").mockImplementation(async (sourcePath, targetPath, mode) => {
      if (sourcePath === walPath) {
        await fs.rm(walPath, { force: true });
        throw Object.assign(new Error("sidecar vanished"), { code: "ENOENT" });
      }
      return await copyFile(sourcePath, targetPath, mode);
    });

    const result = await buildHermesMigrationProvider().apply(
      makeContext({
        source,
        stateDir: path.join(root, "state"),
        workspaceDir: path.join(root, "workspace"),
        reportDir,
      }),
    );

    const archivedState = itemById(result.items, "archive:state.db");
    expect(archivedState?.status).toBe("error");
    expect(archivedState?.reason).toContain("recovery files preserved");
    expect(await fs.readFile(path.join(reportDir, "archive", "state.db", "state.db"), "utf8")).toBe(
      "legacy non-SQLite Hermes state\n",
    );
  });

  it("ignores legacy Hermes OpenAI auth.json OAuth state", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    await writeFile(
      path.join(source, "auth.json"),
      JSON.stringify({
        providers: {
          openai: {
            tokens: {
              access_token: "old-access",
              refresh_token: "old-refresh",
            },
          },
        },
        credential_pool: {
          openai: [
            {
              access_token: "pool-access",
              refresh_token: "pool-refresh",
            },
          ],
        },
      }),
    );

    const provider = buildHermesMigrationProvider();
    const plan = await provider.plan(
      makeContext({ source, stateDir, workspaceDir, includeSecrets: true }),
    );

    expect(plan.items.some((item) => item.kind === "auth")).toBe(false);
  });

  it("plans current Hermes OpenAI OAuth state for import with a cutover warning", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    await writeFile(
      path.join(source, "auth.json"),
      JSON.stringify({
        providers: {
          "openai-codex": {
            tokens: {
              [hermesAccessField]: fakeJwt({
                "https://api.openai.com/auth": { chatgpt_account_id: "acct-hermes" },
                "https://api.openai.com/profile": { email: "hermes@example.test" },
              }),
              [hermesRefreshField]: "placeholder",
            },
          },
        },
      }),
    );

    const plan = await buildHermesMigrationProvider().plan(
      makeContext({ source, stateDir, workspaceDir, includeSecrets: true }),
    );

    expect(plan.items.find((item) => item.kind === "auth")).toEqual(
      expect.objectContaining({
        status: "planned",
        sensitive: true,
        details: expect.objectContaining({
          provider: "openai",
          sourceKind: "hermes-auth-json",
        }),
      }),
    );
    expect(plan.warnings).toContain(
      "Hermes and OpenClaw must not keep using the same imported OpenAI OAuth refresh grant after migration; reauthenticate one side before running both.",
    );
  });

  it("ignores empty Hermes auth.json credential containers", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    await writeFile(
      path.join(source, "auth.json"),
      JSON.stringify({
        providers: {},
        credential_pool: {},
        tokens: { anthropic: { access: "other-access", refresh: "other-refresh" } },
      }),
    );

    const provider = buildHermesMigrationProvider();
    const plan = await provider.plan(
      makeContext({ source, stateDir, workspaceDir, includeSecrets: true }),
    );

    expect(plan.items.some((item) => item.kind === "auth")).toBe(false);
  });
});
