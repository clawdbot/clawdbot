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
import { writePluginInstallIndexForE2E } from "../../scripts/e2e/lib/plugin-index-sqlite.mjs";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const CODEX_ON_DEMAND_ASSERTIONS_SCRIPT = "scripts/e2e/lib/codex-on-demand/assertions.mjs";
const CODEX_NPM_PLUGIN_LIVE_ASSERTIONS_SCRIPT =
  "scripts/e2e/lib/codex-npm-plugin-live/assertions.mjs";
const DISABLE_EXPERIMENTAL_WARNING = "--disable-warning=ExperimentalWarning";
const tempDirs: string[] = [];
const tmpFixtureFiles = [
  "/tmp/openclaw-codex-agent.err",
  "/tmp/openclaw-codex-agent.json",
  "/tmp/openclaw-codex-followthrough.err",
  "/tmp/openclaw-codex-followthrough.json",
  "/tmp/openclaw-codex-inspect.json",
  "/tmp/openclaw-codex-plugin-inspect.json",
  "/tmp/openclaw-codex-plugins-list.json",
  "/tmp/openclaw-onboard.json",
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
  bindingStoreContract?: "legacy-sidecar" | "plugin-kv";
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
        OPENCLAW_CODEX_NPM_PLUGIN_BINDING_STORE_CONTRACT:
          params.bindingStoreContract ?? "plugin-kv",
        OPENCLAW_CODEX_NPM_PLUGIN_SESSION_STORE_CONTRACT: params.sessionStoreContract ?? "sqlite",
      },
    },
  );
}

function runCodexNpmPluginLiveFollowthroughAssertions(params: {
  root: string;
  progressMarker: string;
  completeMarker: string;
  sessionId: string;
  modelRef: string;
  artifactPath: string;
  inputPaths: string[];
  bindingStoreContract?: "legacy-sidecar" | "plugin-kv";
  sessionStoreContract?: "legacy-json" | "sqlite";
  assertionEnv?: Record<string, string>;
}) {
  return spawnSync(
    process.execPath,
    [
      CODEX_NPM_PLUGIN_LIVE_ASSERTIONS_SCRIPT,
      "assert-followthrough",
      params.progressMarker,
      params.completeMarker,
      params.sessionId,
      params.modelRef,
      params.artifactPath,
      ...params.inputPaths,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: path.join(params.root, "home"),
        NODE_OPTIONS: nodeOptionsWithoutExperimentalWarnings(),
        OPENCLAW_STATE_DIR: path.join(params.root, "state"),
        OPENCLAW_CODEX_NPM_PLUGIN_BINDING_STORE_CONTRACT:
          params.bindingStoreContract ?? "plugin-kv",
        OPENCLAW_CODEX_NPM_PLUGIN_SESSION_STORE_CONTRACT: params.sessionStoreContract ?? "sqlite",
        ...params.assertionEnv,
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

function runCodexNpmPluginLivePluginAssertions(root: string) {
  return spawnSync(
    process.execPath,
    [CODEX_NPM_PLUGIN_LIVE_ASSERTIONS_SCRIPT, "assert-plugin", "npm:@openclaw/codex"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: path.join(root, "home"),
        NODE_OPTIONS: nodeOptionsWithoutExperimentalWarnings(),
        OPENCLAW_CONFIG_PATH: path.join(root, "state", "openclaw.json"),
        OPENCLAW_STATE_DIR: path.join(root, "state"),
      },
    },
  );
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
      CREATE TABLE session_nodes (
        session_key TEXT NOT NULL PRIMARY KEY,
        current_session_id TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE session_windows (
        session_id TEXT NOT NULL PRIMARY KEY,
        session_key TEXT NOT NULL,
        agent_harness_id TEXT,
        created_at INTEGER NOT NULL,
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
      `INSERT INTO session_windows (
         session_id, session_key, agent_harness_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run(params.sessionId, params.sessionKey, "codex", now, now);
    db.prepare(
      `INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
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

function replaceSessionTranscriptMessages(params: {
  stateDir: string;
  sessionId: string;
  messages: unknown[];
}) {
  const dbPath = path.join(params.stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    const now = Date.now();
    db.prepare("DELETE FROM transcript_events WHERE session_id = ?").run(params.sessionId);
    const insert = db.prepare(
      `INSERT INTO transcript_events (session_id, seq, event_json, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    insert.run(params.sessionId, 0, '{"type":"session"}', now);
    params.messages.forEach((message, index) => {
      insert.run(
        params.sessionId,
        index + 1,
        JSON.stringify({ type: "message", message }),
        now + index + 1,
      );
    });
  } finally {
    db.close();
  }
}

function transcriptToolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args, input: args }],
  };
}

function transcriptToolResult(id: string, name: string, isError = false) {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    isError,
    content: [{ type: "toolResult", id, name, content: "ok" }],
  };
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

function createCodexNpmPluginLiveFollowthroughFixture(params: {
  root: string;
  replyTexts?: string[];
  artifactText?: string;
  messageFinals?: Array<boolean | undefined>;
  readFails?: boolean;
  bindingStoreContract?: "legacy-sidecar" | "plugin-kv";
  sessionStoreContract?: "legacy-json" | "sqlite";
  workPlacement?:
    | "between"
    | "before-progress"
    | "before-progress-result"
    | "write-result-after-completion";
}) {
  const fixture = createCodexNpmPluginLiveFixture(params.root);
  const progressMarker = `${fixture.marker}-FOLLOWTHROUGH-PROGRESS`;
  const completeMarker = `${fixture.marker}-FOLLOWTHROUGH-COMPLETE`;
  const workspaceDir = path.join(params.root, "state", "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  const inputPaths = ["ALPHA.md", "BETA.md", "GAMMA.md"].map((name, index) => {
    const inputPath = path.join(workspaceDir, name);
    writeFileSync(inputPath, `hidden-${index + 1}\n`, "utf8");
    return inputPath;
  });
  const artifactPath = path.join(workspaceDir, "codex-progress-followthrough.txt");
  writeFileSync(artifactPath, params.artifactText ?? "hidden-1\nhidden-2\nhidden-3\n", "utf8");
  const replyTexts = params.replyTexts ?? [progressMarker, completeMarker];
  writeJson("/tmp/openclaw-codex-followthrough.json", {
    payloads: replyTexts.map((text) => ({ text })),
    meta: { executionTrace: { winnerProvider: "openai" } },
  });
  const messageFinals = params.messageFinals ?? [undefined, true];
  const messageCalls = [progressMarker, completeMarker].map((text, index) => {
    const args = {
      action: "send",
      message: text,
      ...(messageFinals[index] === undefined ? {} : { final: messageFinals[index] }),
    };
    const id = `message-${index + 1}`;
    return [transcriptToolCall(id, "message", args), transcriptToolResult(id, "message")];
  });
  const [progressCalls, completionCalls] = messageCalls;
  if (!progressCalls || !completionCalls) {
    throw new Error("expected progress and completion message fixtures");
  }
  const readId = "workspace-read";
  const readMessages = [
    transcriptToolCall(readId, "bash", {
      command: "cat *.md",
    }),
    transcriptToolResult(readId, "bash", params.readFails),
  ];
  const writeId = "workspace-write";
  const writeMessages = [
    transcriptToolCall(writeId, "bash", {
      command: "cat *.md > codex-progress-followthrough.txt",
    }),
    transcriptToolResult(writeId, "bash"),
  ];
  const workMessages = [...readMessages, ...writeMessages];
  let transcriptMessages;
  if (params.workPlacement === "before-progress") {
    transcriptMessages = [...workMessages, ...progressCalls, ...completionCalls];
  } else if (params.workPlacement === "before-progress-result") {
    transcriptMessages = [progressCalls[0], ...workMessages, progressCalls[1], ...completionCalls];
  } else if (params.workPlacement === "write-result-after-completion") {
    transcriptMessages = [
      ...progressCalls,
      ...readMessages,
      ...writeMessages.slice(0, 1),
      ...completionCalls,
      ...writeMessages.slice(1),
    ];
  } else {
    transcriptMessages = [...progressCalls, ...workMessages, ...completionCalls];
  }
  const transcriptEvents = [
    { type: "session" },
    ...transcriptMessages.map((message) => ({ type: "message", message })),
  ];
  replaceSessionTranscriptMessages({
    stateDir: path.join(params.root, "state"),
    sessionId: fixture.sessionId,
    messages: transcriptMessages,
  });
  const result = {
    ...fixture,
    progressMarker,
    completeMarker,
    artifactPath,
    inputPaths,
  };
  return params.sessionStoreContract === "legacy-json"
    ? convertCodexNpmPluginLiveFixtureToLegacy(
        result,
        transcriptEvents,
        params.bindingStoreContract ?? "plugin-kv",
      )
    : result;
}

function convertCodexNpmPluginLiveFixtureToLegacy<
  Fixture extends { root: string; sessionId: string },
>(
  fixture: Fixture,
  transcriptEvents: unknown[] = [{ type: "message" }],
  bindingStoreContract: "legacy-sidecar" | "plugin-kv" = "legacy-sidecar",
) {
  const stateDir = path.join(fixture.root, "state");
  rmSync(path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"));
  const sessionFile = path.join(stateDir, "agents", "main", "sessions", "session.jsonl");
  mkdirSync(path.dirname(sessionFile), { recursive: true });
  writeFileSync(
    sessionFile,
    `${transcriptEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
  if (bindingStoreContract === "legacy-sidecar") {
    rmSync(path.join(stateDir, "state", "openclaw.sqlite"));
    writeJson(`${sessionFile}.codex-app-server.json`, {
      schemaVersion: 2,
      threadId: "thread-codex-npm-live",
      cwd: stateDir,
      model: "gpt-5.4",
      modelProvider: "codex",
    });
  }
  writeJson(path.join(stateDir, "agents", "main", "sessions", "sessions.json"), {
    "agent:main:codex-npm-plugin-live": {
      sessionId: fixture.sessionId,
      agentHarnessId: "codex",
      sessionFile,
    },
  });
  return {
    ...fixture,
    bindingStoreContract,
    sessionStoreContract: "legacy-json" as const,
  };
}

function createLegacyCodexNpmPluginLiveFixture(root: string) {
  return convertCodexNpmPluginLiveFixtureToLegacy(createCodexNpmPluginLiveFixture(root));
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
  writeFileSync(codexBin, '#!/usr/bin/env node\nconsole.log("codex-cli 0.0.0-test");\n', {
    mode: 0o755,
  });
  chmodSync(codexBin, 0o755);
  writeJson(path.join(stateDir, "openclaw.json"), {
    agents: { defaults: { model: { primary: "openai/gpt-5.6" } } },
    models: { providers: { openai: { agentRuntime: { id: "codex" } } } },
  });
  writePluginInstallIndexForE2E(
    {
      installRecords: {
        codex: {
          installPath,
          source: "npm",
          spec: "npm:@openclaw/codex",
        },
      },
    },
    { stateDir },
  );
  writeJson("/tmp/openclaw-onboard.json", {
    ok: true,
    mode: "local",
    authChoice: "openai-api-key",
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

    expect(result.status, result.stderr).toBe(0);
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

  it("accepts the canonical harness-only Codex plugin registration", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-harness-registration-");
    createCodexInstallFixture(root);
    const installPath = path.join(
      root,
      "state",
      "npm",
      "projects",
      "codex",
      "node_modules",
      "@openclaw",
      "codex",
    );
    writePluginInstallIndexForE2E(
      {
        installRecords: {
          codex: {
            installPath,
            source: "npm",
            spec: "@openclaw/codex",
            resolvedVersion: "2026.7.2",
            resolvedSpec: "@openclaw/codex@2026.7.2",
          },
        },
      },
      { stateDir: path.join(root, "state") },
    );
    writeJson("/tmp/openclaw-codex-plugins-list.json", {
      plugins: [{ id: "codex", enabled: true, status: "loaded" }],
      diagnostics: [],
    });
    writeJson("/tmp/openclaw-codex-plugin-inspect.json", {
      plugin: {
        id: "codex",
        status: "loaded",
        providerIds: [],
        agentHarnessIds: ["codex"],
      },
      capabilities: [{ kind: "agent-harness", ids: ["codex"] }],
      diagnostics: [],
    });

    const result = runCodexNpmPluginLivePluginAssertions(root);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
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

  it("rejects on-demand fixtures without the canonical SQLite install record", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-on-demand-no-index-");
    createCodexInstallFixture(root);
    rmSync(path.join(root, "state", "state", "openclaw.sqlite"), { force: true });

    const result = runCodexOnDemandAssertions(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing codex install record");
  });

  it("rejects duplicate onboarding terminal JSON documents", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-on-demand-duplicate-terminal-");
    createCodexInstallFixture(root);
    writeFileSync(
      "/tmp/openclaw-onboard.json",
      `${JSON.stringify({ ok: true })}\n${JSON.stringify({ ok: true })}\n`,
      "utf8",
    );

    const result = runCodexOnDemandAssertions(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unexpected non-whitespace character after JSON");
  });

  it("accepts SQLite-backed session and Codex binding state in the npm live assertion", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-npm-live-");
    const fixture = createCodexNpmPluginLiveFixture(root);

    const result = runCodexNpmPluginLiveAssertions(fixture);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it.each(["sqlite", "legacy-json"] as const)(
    "accepts progress, artifact work, and completion with the %s session contract",
    (sessionStoreContract) => {
      const root = makeTempDir(tempDirs, "openclaw-codex-npm-followthrough-");
      const fixture = createCodexNpmPluginLiveFollowthroughFixture({ root, sessionStoreContract });

      const result = runCodexNpmPluginLiveFollowthroughAssertions(fixture);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    },
  );

  it("accepts settled failed work before a later successful artifact write", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-npm-followthrough-recovered-work-");
    const fixture = createCodexNpmPluginLiveFollowthroughFixture({ root, readFails: true });

    const result = runCodexNpmPluginLiveFollowthroughAssertions(fixture);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it.each(
    (["sqlite", "legacy-json"] as const).flatMap(
      (sessionStoreContract) =>
        [
          [
            sessionStoreContract,
            "event count",
            "OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_TRANSCRIPT_WALK_ENTRIES",
            "2",
            "exceeded 2 events",
          ],
          [
            sessionStoreContract,
            "aggregate bytes",
            "OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_TRANSCRIPT_SCAN_BYTES",
            "128",
            "exceeded 128 bytes",
          ],
        ] as const,
    ),
  )(
    "rejects an oversized %s transcript by %s before assertions",
    (sessionStoreContract, _label, envName, limit, errorText) => {
      const root = makeTempDir(tempDirs, "openclaw-codex-npm-followthrough-bounded-");
      const fixture = createCodexNpmPluginLiveFollowthroughFixture({
        root,
        sessionStoreContract,
      });

      const result = runCodexNpmPluginLiveFollowthroughAssertions({
        ...fixture,
        assertionEnv: { [envName]: limit },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(errorText);
    },
  );

  it("rejects a Codex live turn that stops after its progress message", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-npm-followthrough-progress-only-");
    const fixture = createCodexNpmPluginLiveFollowthroughFixture({
      root,
      replyTexts: ["OPENCLAW-CODEX-NPM-PLUGIN-LIVE-OK-FOLLOWTHROUGH-PROGRESS"],
    });

    const result = runCodexNpmPluginLiveFollowthroughAssertions(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("expected exact progress and completion replies");
  });

  it("rejects a Codex live turn whose follow-through artifact is incomplete", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-npm-followthrough-incomplete-");
    const fixture = createCodexNpmPluginLiveFollowthroughFixture({
      root,
      artifactText: "hidden-1\n",
    });

    const result = runCodexNpmPluginLiveFollowthroughAssertions(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unexpected Codex follow-through artifact");
  });

  it("rejects workspace work outside the progress and completion messages", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-npm-followthrough-work-order-");
    const fixture = createCodexNpmPluginLiveFollowthroughFixture({
      root,
      workPlacement: "before-progress",
    });

    const result = runCodexNpmPluginLiveFollowthroughAssertions(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "expected progress to be the first completed tool call in its turn",
    );
  });

  it.each(["sqlite", "legacy-json"] as const)(
    "rejects workspace work issued before progress delivery completes with the %s session contract",
    (sessionStoreContract) => {
      const root = makeTempDir(tempDirs, "openclaw-codex-npm-followthrough-batched-work-");
      const fixture = createCodexNpmPluginLiveFollowthroughFixture({
        root,
        sessionStoreContract,
        workPlacement: "before-progress-result",
      });

      const result = runCodexNpmPluginLiveFollowthroughAssertions(fixture);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "expected progress to be the first completed tool call in its turn",
      );
    },
  );

  it("rejects a malformed legacy follow-through transcript", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-npm-followthrough-legacy-malformed-");
    const fixture = createCodexNpmPluginLiveFollowthroughFixture({
      root,
      sessionStoreContract: "legacy-json",
    });
    const sessionFile = path.join(root, "state", "agents", "main", "sessions", "session.jsonl");
    writeFileSync(sessionFile, `${readFileSync(sessionFile, "utf8")}not-json\n`, "utf8");

    const result = runCodexNpmPluginLiveFollowthroughAssertions(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid OpenClaw legacy transcript event");
  });

  it("rejects completion sent before the artifact write succeeds", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-npm-followthrough-pending-write-");
    const fixture = createCodexNpmPluginLiveFollowthroughFixture({
      root,
      workPlacement: "write-result-after-completion",
    });

    const result = runCodexNpmPluginLiveFollowthroughAssertions(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("expected all workspace work to settle before completion");
  });

  it.each([
    ["explicit progress", [false, true]],
    ["missing completion", [undefined, undefined]],
  ] as const)("rejects %s Codex message final controls", (_label, messageFinals) => {
    const root = makeTempDir(tempDirs, "openclaw-codex-npm-followthrough-final-controls-");
    const fixture = createCodexNpmPluginLiveFollowthroughFixture({
      root,
      messageFinals: [...messageFinals],
    });

    const result = runCodexNpmPluginLiveFollowthroughAssertions(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("expected exact message final controls");
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

  it("rejects a present managed Codex wrapper when its native executable is unavailable", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-on-demand-broken-native-");
    createCodexInstallFixture(root);
    const codexBin = path.join(
      root,
      "state",
      "npm",
      "projects",
      "codex",
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    writeFileSync(
      codexBin,
      '#!/usr/bin/env node\nconsole.error("Missing optional dependency @openai/codex-linux-x64");\nprocess.exit(1);\n',
      { mode: 0o755 },
    );

    const result = runCodexOnDemandAssertions(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("managed Codex --version failed (exit status 1)");
    expect(result.stderr).toContain("Missing optional dependency @openai/codex-linux-x64");
  });
});
