// Codex Install Assertions tests cover Codex plugin install E2E helpers.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPathInside,
  findPackageJson,
  npmProjectRootForInstalledPackage,
} from "../../scripts/e2e/lib/codex-install-utils.mjs";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const CODEX_ON_DEMAND_ASSERTIONS_SCRIPT = "scripts/e2e/lib/codex-on-demand/assertions.mjs";
const CODEX_NPM_PLUGIN_LIVE_ASSERTIONS_SCRIPT =
  "scripts/e2e/lib/codex-npm-plugin-live/assertions.mjs";
const DISABLE_EXPERIMENTAL_WARNING = "--disable-warning=ExperimentalWarning";
const tempDirs: string[] = [];
const tmpFixtureFiles = [
  "/tmp/openclaw-codex-agent.err",
  "/tmp/openclaw-codex-agent.json",
  "/tmp/openclaw-codex-inspect.json",
  "/tmp/openclaw-plugins-list.json",
];

afterEach(() => {
  for (const file of tmpFixtureFiles) {
    rmSync(file, { force: true });
  }
  cleanupTempDirs(tempDirs);
});

function nodeOptionsWithoutExperimentalWarnings(): string {
  const current = process.env.NODE_OPTIONS ?? "";
  return current.includes(DISABLE_EXPERIMENTAL_WARNING)
    ? current
    : [current, DISABLE_EXPERIMENTAL_WARNING].filter(Boolean).join(" ");
}

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeAuthProfileStoreSqlite(agentDir: string) {
  mkdirSync(agentDir, { recursive: true });
  const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS auth_profile_store (
        store_key TEXT NOT NULL PRIMARY KEY,
        store_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    db.prepare(
      `
        INSERT INTO auth_profile_store (store_key, store_json, updated_at)
        VALUES (?, ?, ?)
      `,
    ).run(
      "primary",
      JSON.stringify({
        version: 1,
        profiles: {
          "openai:api-key": {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
        },
      }),
      Date.now(),
    );
  } finally {
    db.close();
  }
}

function runCodexOnDemandAssertions(root: string) {
  return spawnSync(process.execPath, [CODEX_ON_DEMAND_ASSERTIONS_SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: path.join(root, "home"),
      NODE_OPTIONS: nodeOptionsWithoutExperimentalWarnings(),
      OPENCLAW_CONFIG_PATH: path.join(root, "state", "openclaw.json"),
      OPENCLAW_STATE_DIR: path.join(root, "state"),
    },
  });
}

function runCodexNpmPluginLiveAssertions(params: {
  root: string;
  marker: string;
  sessionId: string;
  modelRef: string;
  sessionStoreContract?: "legacy-json" | "sqlite";
}) {
  return spawnSync(
    process.execPath,
    [
      CODEX_NPM_PLUGIN_LIVE_ASSERTIONS_SCRIPT,
      "assert-agent-turn",
      params.marker,
      params.sessionId,
      params.modelRef,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: path.join(params.root, "home"),
        NODE_OPTIONS: nodeOptionsWithoutExperimentalWarnings(),
        OPENCLAW_STATE_DIR: path.join(params.root, "state"),
        OPENCLAW_CODEX_NPM_PLUGIN_SESSION_STORE_CONTRACT: params.sessionStoreContract ?? "sqlite",
      },
    },
  );
}

function runCodexNpmPluginLiveConfigure(root: string) {
  return spawnSync(process.execPath, [CODEX_NPM_PLUGIN_LIVE_ASSERTIONS_SCRIPT, "configure"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: path.join(root, "home"),
      NODE_OPTIONS: nodeOptionsWithoutExperimentalWarnings(),
      OPENCLAW_CONFIG_PATH: path.join(root, "state", "openclaw.json"),
      OPENCLAW_STATE_DIR: path.join(root, "state"),
    },
  });
}

function writeCodexBindingStateSqlite(params: {
  stateDir: string;
  sessionKey: string;
  sessionId: string;
  storedSessionId?: string;
  threadId: string;
}) {
  const dbPath = path.join(params.stateDir, "state", "openclaw.sqlite");
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE plugin_state_entries (
        plugin_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (plugin_id, namespace, entry_key)
      );
    `);
    const entryKey = `session-key:main:${createHash("sha256")
      .update(params.sessionKey)
      .digest("base64url")}`;
    db.prepare(
      `INSERT INTO plugin_state_entries (
         plugin_id, namespace, entry_key, value_json, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "codex",
      "app-server-thread-bindings",
      entryKey,
      JSON.stringify({
        version: 1,
        state: "active",
        sessionId: params.storedSessionId ?? params.sessionId,
        binding: {
          threadId: params.threadId,
          cwd: params.stateDir,
          model: "gpt-5.4",
          modelProvider: "codex",
        },
      }),
      Date.now(),
      null,
    );
  } finally {
    db.close();
  }
}

function writeSessionStoreSqlite(params: {
  stateDir: string;
  sessionId: string;
  sessionKey: string;
}) {
  const dbPath = path.join(params.stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE sessions (
        session_id TEXT NOT NULL PRIMARY KEY,
        session_key TEXT NOT NULL,
        agent_harness_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE session_entries (
        session_key TEXT NOT NULL PRIMARY KEY,
        session_id TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE transcript_events (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
    `);
    const now = Date.now();
    db.prepare(
      `INSERT INTO sessions (
         session_id, session_key, agent_harness_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run(params.sessionId, params.sessionKey, "codex", now, now);
    db.prepare(
      `INSERT INTO session_entries (session_key, session_id, entry_json, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(
      params.sessionKey,
      params.sessionId,
      JSON.stringify({
        sessionId: params.sessionId,
        agentHarnessId: "codex",
      }),
      now,
    );
    db.prepare(
      `INSERT INTO transcript_events (session_id, seq, event_json, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(params.sessionId, 0, '{"type":"session"}', now);
  } finally {
    db.close();
  }
}

function createCodexNpmPluginLiveFixture(root: string, storedSessionId?: string) {
  const stateDir = path.join(root, "state");
  const sessionKey = "agent:main:codex-npm-plugin-live";
  const sessionId = "codex-npm-plugin-live";
  const marker = "OPENCLAW-CODEX-NPM-PLUGIN-LIVE-OK";
  const threadId = "thread-codex-npm-live";
  const modelRef = "openai/gpt-5.4";
  writeJson("/tmp/openclaw-codex-agent.json", {
    payloads: [{ text: marker }],
    meta: { executionTrace: { winnerProvider: "openai" } },
  });
  writeSessionStoreSqlite({
    stateDir,
    sessionId,
    sessionKey,
  });
  writeJson(path.join(stateDir, "agents", "main", "codex-home", "sessions", "native.jsonl"), {
    threadId,
    marker,
  });
  writeCodexBindingStateSqlite({
    stateDir,
    sessionKey,
    sessionId,
    storedSessionId,
    threadId,
  });
  return { root, marker, sessionId, modelRef };
}

function createLegacyCodexNpmPluginLiveFixture(root: string) {
  const fixture = createCodexNpmPluginLiveFixture(root);
  const stateDir = path.join(root, "state");
  rmSync(path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"));
  rmSync(path.join(stateDir, "state", "openclaw.sqlite"));
  const sessionFile = path.join(stateDir, "agents", "main", "sessions", "session.jsonl");
  writeJson(sessionFile, { type: "message" });
  writeJson(`${sessionFile}.codex-app-server.json`, {
    schemaVersion: 2,
    threadId: "thread-codex-npm-live",
    cwd: stateDir,
    model: "gpt-5.4",
    modelProvider: "codex",
  });
  writeJson(path.join(stateDir, "agents", "main", "sessions", "sessions.json"), {
    "agent:main:codex-npm-plugin-live": {
      sessionId: fixture.sessionId,
      agentHarnessId: "codex",
      sessionFile,
    },
  });
  return { ...fixture, sessionStoreContract: "legacy-json" as const };
}

function createCodexInstallFixture(root: string) {
  const stateDir = path.join(root, "state");
  const npmRoot = path.join(stateDir, "npm");
  const installPath = path.join(npmRoot, "projects", "codex", "node_modules", "@openclaw", "codex");
  const projectRoot = npmProjectRootForInstalledPackage(installPath, "@openclaw/codex");
  writeJson(path.join(installPath, "package.json"), { name: "@openclaw/codex" });
  const openAiCodexRoot = path.join(projectRoot, "node_modules", "@openai", "codex");
  writeJson(path.join(openAiCodexRoot, "package.json"), {
    name: "@openai/codex",
    bin: { codex: "bin/codex.js" },
  });
  const codexBin = path.join(openAiCodexRoot, "bin", "codex.js");
  mkdirSync(path.dirname(codexBin), { recursive: true });
  writeFileSync(codexBin, "#!/usr/bin/env node\n", { mode: 0o755 });
  chmodSync(codexBin, 0o755);
  writeJson(path.join(stateDir, "openclaw.json"), {
    agents: { defaults: { model: { primary: "openai/gpt-5.6" } } },
    models: { providers: { openai: { agentRuntime: { id: "codex" } } } },
    plugins: {
      installs: {
        codex: {
          installPath,
          source: "npm",
          spec: "npm:@openclaw/codex",
        },
      },
    },
  });
  writeJson("/tmp/openclaw-codex-inspect.json", {
    plugin: { id: "codex", status: "loaded", agentHarnessIds: ["codex"] },
  });
  writeJson("/tmp/openclaw-plugins-list.json", {
    plugins: [{ id: "codex", enabled: true, status: "loaded" }],
  });
  writeAuthProfileStoreSqlite(path.join(stateDir, "agents", "main", "agent"));
}

describe("Codex install helpers", () => {
  it("configures the canonical OpenAI model for the Codex runtime by default", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-npm-configure-");

    const result = runCodexNpmPluginLiveConfigure(root);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const config = JSON.parse(readFileSync(path.join(root, "state", "openclaw.json"), "utf8")) as {
      agents: {
        defaults: {
          model: { primary: string; fallbacks: string[] };
          models: Record<string, { agentRuntime: { id: string } }>;
        };
      };
    };

    expect(config.agents.defaults.model).toEqual({
      primary: "openai/gpt-5.4",
      fallbacks: [],
    });
    expect(config.agents.defaults.models).toMatchObject({
      "openai/gpt-5.4": { agentRuntime: { id: "codex" } },
    });
    expect(config.agents.defaults.models).not.toHaveProperty("codex/gpt-5.4");
  });

  it("resolves package roots and package manifests inside managed npm installs", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-install-utils-");
    const packageRoot = path.join(
      root,
      "state",
      "npm",
      "projects",
      "codex",
      "node_modules",
      "@openclaw",
      "codex",
    );
    const projectRoot = npmProjectRootForInstalledPackage(packageRoot, "@openclaw/codex");
    const dependencyPackage = path.join(
      projectRoot,
      "node_modules",
      "@openai",
      "codex",
      "package.json",
    );
    writeJson(dependencyPackage, { name: "@openai/codex" });

    expect(projectRoot).toBe(path.join(root, "state", "npm", "projects", "codex"));
    expect(findPackageJson("@openai/codex", [packageRoot, projectRoot])).toBe(dependencyPackage);
    expect(() =>
      assertPathInside(projectRoot, dependencyPackage, "codex dependency"),
    ).not.toThrow();
    expect(() => assertPathInside(projectRoot, os.tmpdir(), "outside path")).toThrow(
      "outside path resolved outside",
    );
  });

  it("accepts a complete on-demand Codex npm install fixture", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-on-demand-");
    createCodexInstallFixture(root);

    const result = runCodexOnDemandAssertions(root);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("accepts SQLite-backed session and Codex binding state in the npm live assertion", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-npm-live-");
    const fixture = createCodexNpmPluginLiveFixture(root);

    const result = runCodexNpmPluginLiveAssertions(fixture);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("accepts the explicit frozen-target JSON session and sidecar binding contract", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-npm-live-legacy-");
    const fixture = createLegacyCodexNpmPluginLiveFixture(root);

    const result = runCodexNpmPluginLiveAssertions(fixture);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("keeps current targets fail-closed when the SQLite session database is missing", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-npm-live-no-sqlite-");
    const fixture = createLegacyCodexNpmPluginLiveFixture(root);

    const result = runCodexNpmPluginLiveAssertions({
      ...fixture,
      sessionStoreContract: "sqlite",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing agent session database");
  });

  it("rejects a Codex binding owned by a stale physical session generation", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-npm-live-stale-");
    const fixture = createCodexNpmPluginLiveFixture(root, "previous-session");

    const result = runCodexNpmPluginLiveAssertions(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "belongs to session previous-session, expected codex-npm-plugin-live",
    );
  });

  it("rejects on-demand fixtures missing the managed @openai/codex dependency", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-on-demand-missing-");
    createCodexInstallFixture(root);
    rmSync(path.join(root, "state", "npm", "projects", "codex", "node_modules", "@openai"), {
      force: true,
      recursive: true,
    });

    const result = runCodexOnDemandAssertions(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing @openai/codex dependency under managed npm root");
  });

  it("rejects on-demand fixtures missing the managed Codex executable", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-on-demand-missing-bin-");
    createCodexInstallFixture(root);
    rmSync(
      path.join(
        root,
        "state",
        "npm",
        "projects",
        "codex",
        "node_modules",
        "@openai",
        "codex",
        "bin",
      ),
      { force: true, recursive: true },
    );

    const result = runCodexOnDemandAssertions(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing managed Codex binary:");
  });
});
