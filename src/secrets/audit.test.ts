/** Tests secrets audit reporting and remediation hints. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  noteCommittedSharedAuthStoreOwnership,
  resolveSharedAuthStorePath,
} from "../agents/auth-profiles/path-resolve.js";
import {
  resolveAuthProfileDatabasePath,
  writePersistedAuthProfileStoreRaw,
} from "../agents/auth-profiles/sqlite.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { runSecretsAudit } from "./audit.js";
import { writeSecretStoreEntry } from "./store/secret-store.js";

type AuditFixture = {
  rootDir: string;
  stateDir: string;
  configPath: string;
  agentDir: string;
  authStorePath: string;
  authJsonPath: string;
  modelsPath: string;
  envPath: string;
  env: NodeJS.ProcessEnv;
};

const OPENAI_API_KEY_MARKER = "OPENAI_API_KEY"; // pragma: allowlist secret
const MAX_AUDIT_MODELS_JSON_BYTES = 5 * 1024 * 1024;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function countNonEmptyLines(value: string): number {
  let count = 0;
  for (const line of value.split("\n")) {
    if (line.trim().length > 0) {
      count += 1;
    }
  }
  return count;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeAuthStore(fixture: AuditFixture, value: unknown): void {
  writePersistedAuthProfileStoreRaw(value, fixture.agentDir);
}

async function writeExecResolverShellScript(params: {
  scriptPath: string;
  logPath: string;
  values: Record<string, string>;
}) {
  await fs.writeFile(
    params.scriptPath,
    [
      "#!/bin/sh",
      `printf 'x\\n' >> ${JSON.stringify(params.logPath)}`,
      "cat >/dev/null",
      `printf '${JSON.stringify({ protocolVersion: 1, values: params.values }).replaceAll("'", "'\\''")}'`, // pragma: allowlist secret
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 },
  );
}

async function writeExecSecretsAuditConfig(params: {
  fixture: AuditFixture;
  execScriptPath: string;
  providers: Array<{
    id: string;
    baseUrl: string;
    modelId: string;
    modelName: string;
    headerRefId?: string;
  }>;
}) {
  await writeJsonFile(params.fixture.configPath, {
    secrets: {
      providers: {
        execmain: {
          source: "exec",
          command: params.execScriptPath,
          jsonOnly: true,
          timeoutMs: 20_000,
          noOutputTimeoutMs: 10_000,
        },
      },
    },
    models: {
      providers: Object.fromEntries(
        params.providers.map((provider) => [
          provider.id,
          {
            baseUrl: provider.baseUrl,
            api: "openai-completions",
            apiKey: {
              source: "exec",
              provider: "execmain",
              id: `providers/${provider.id}/apiKey`,
            },
            ...(provider.headerRefId
              ? {
                  headers: {
                    Authorization: {
                      source: "exec",
                      provider: "execmain",
                      id: provider.headerRefId,
                    },
                  },
                }
              : {}),
            models: [{ id: provider.modelId, name: provider.modelName }],
          },
        ]),
      ),
    },
  });
}

function resolveRuntimePathEnv(): string {
  if (typeof process.env.PATH === "string" && process.env.PATH.trim().length > 0) {
    return process.env.PATH;
  }
  return "/usr/bin:/bin";
}

function hasFinding(
  report: Awaited<ReturnType<typeof runSecretsAudit>>,
  predicate: (entry: { code: string; file: string; jsonPath?: string }) => boolean,
): boolean {
  return report.findings.some((entry) =>
    predicate(entry as { code: string; file: string; jsonPath?: string }),
  );
}

function expectFindingCode(report: Awaited<ReturnType<typeof runSecretsAudit>>, code: string) {
  expect(hasFinding(report, (entry) => entry.code === code)).toBe(true);
}

function expectFindingFile(report: Awaited<ReturnType<typeof runSecretsAudit>>, filePath: string) {
  expect(hasFinding(report, (entry) => entry.file === filePath)).toBe(true);
}

async function expectPathMissing(filePath: string): Promise<void> {
  try {
    await fs.stat(filePath);
    throw new Error(`Expected ${filePath} to be missing`);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
  }
}

async function createAuditFixture(): Promise<AuditFixture> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-audit-"));
  const stateDir = path.join(rootDir, ".openclaw");
  const configPath = path.join(stateDir, "openclaw.json");
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  const authStorePath = resolveAuthProfileDatabasePath(agentDir);
  const authJsonPath = path.join(agentDir, "auth.json");
  const modelsPath = path.join(agentDir, "models.json");
  const envPath = path.join(stateDir, ".env");

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.mkdir(agentDir, { recursive: true });

  return {
    rootDir,
    stateDir,
    configPath,
    agentDir,
    authStorePath,
    authJsonPath,
    modelsPath,
    envPath,
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENAI_API_KEY: "env-openai-key", // pragma: allowlist secret
      PATH: resolveRuntimePathEnv(),
    },
  };
}

async function seedAuditFixture(fixture: AuditFixture): Promise<void> {
  const seededProvider = {
    openai: {
      baseUrl: "https://api.openai.com/v1",
      api: "openai-completions",
      apiKey: { source: "env", provider: "default", id: OPENAI_API_KEY_MARKER },
      models: [{ id: "gpt-5", name: "gpt-5" }],
    },
  };
  const seededProfiles = new Map<string, Record<string, string>>([
    [
      "openai:default",
      {
        type: "api_key",
        provider: "openai",
        key: "sk-openai-plaintext",
      },
    ],
  ]);
  await writeJsonFile(fixture.configPath, {
    models: { providers: seededProvider },
  });
  writeAuthStore(fixture, {
    version: 1,
    profiles: Object.fromEntries(seededProfiles),
  });
  await writeJsonFile(fixture.modelsPath, {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        api: "openai-completions",
        apiKey: OPENAI_API_KEY_MARKER,
        models: [{ id: "gpt-5", name: "gpt-5" }],
      },
    },
  });
  await fs.writeFile(
    fixture.envPath,
    `${OPENAI_API_KEY_MARKER}=sk-openai-plaintext\n`, // pragma: allowlist secret
    "utf8",
  );
}

describe("secrets audit", () => {
  let fixture: AuditFixture;

  async function writeModelsProvider(
    overrides: Partial<{
      apiKey: unknown;
      headers: Record<string, unknown>;
    }> = {},
  ) {
    await writeJsonFile(fixture.modelsPath, {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-completions",
          apiKey: OPENAI_API_KEY_MARKER,
          models: [{ id: "gpt-5", name: "gpt-5" }],
          ...overrides,
        },
      },
    });
  }

  function expectModelsFinding(
    report: Awaited<ReturnType<typeof runSecretsAudit>>,
    params: { code: string; jsonPath?: string; present?: boolean },
  ) {
    expect(
      hasFinding(
        report,
        (entry) =>
          entry.code === params.code &&
          entry.file === fixture.modelsPath &&
          (params.jsonPath === undefined || entry.jsonPath === params.jsonPath),
      ),
    ).toBe(params.present ?? true);
  }

  beforeEach(async () => {
    fixture = await createAuditFixture();
    await writeJsonFile(fixture.configPath, {});
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(fixture.rootDir, { recursive: true, force: true });
  });

  it("reports plaintext + shadowing findings", async () => {
    await seedAuditFixture(fixture);
    const report = await runSecretsAudit({ env: fixture.env });
    expect(report.status).toBe("findings");
    expect(report.summary.plaintextCount).toBeGreaterThan(0);
    expect(report.summary.shadowedRefCount).toBeGreaterThan(0);
    expectFindingCode(report, "REF_SHADOWED");
    expectFindingCode(report, "PLAINTEXT_FOUND");
  });

  it("audits inactive Talk speech and realtime provider references independently", async () => {
    const activeKey = { source: "env", provider: "default", id: OPENAI_API_KEY_MARKER };
    const providerSelection = (missingKey: string) => ({
      provider: "openai",
      providers: {
        openai: { apiKey: activeKey },
        inactive: { apiKey: { source: "env", provider: "default", id: missingKey } },
      },
    });
    await writeJsonFile(fixture.configPath, {
      talk: {
        ...providerSelection("MISSING_TALK_SPEECH_KEY"),
        realtime: providerSelection("MISSING_TALK_REALTIME_KEY"),
      },
    });

    const report = await runSecretsAudit({ env: fixture.env });

    expect(
      report.findings
        .filter((finding) => finding.code === "REF_UNRESOLVED")
        .map((finding) => finding.jsonPath)
        .toSorted(),
    ).toEqual(["talk.providers.inactive.apiKey", "talk.realtime.providers.inactive.apiKey"]);
  });

  it("reports plaintext that duplicates the store while resolving store refs", async () => {
    writeSecretStoreEntry({
      scope: { kind: "team" },
      name: "STORED_API_KEY",
      value: "shared-store-value",
      kind: "secret",
      updatedBy: "test",
      database: { env: fixture.env },
    });
    await writeJsonFile(fixture.configPath, {
      models: {
        providers: {
          plaintext: {
            baseUrl: "https://plaintext.example.test/v1",
            api: "openai-completions",
            apiKey: "shared-store-value",
            models: [{ id: "fixture", name: "fixture" }],
          },
          referenced: {
            baseUrl: "https://referenced.example.test/v1",
            api: "openai-completions",
            apiKey: { source: "store", provider: "default", id: "STORED_API_KEY" },
            models: [{ id: "fixture", name: "fixture" }],
          },
        },
      },
    });

    const report = await runSecretsAudit({ env: fixture.env });
    expect(report.summary.storeResidueCount).toBe(1);
    expect(report.findings.find((entry) => entry.code === "STORE_PLAINTEXT_RESIDUE")).toMatchObject(
      {
        jsonPath: "models.providers.plaintext.apiKey",
        message: expect.stringContaining("STORED_API_KEY"),
      },
    );
    expect(
      report.findings.some(
        (entry) =>
          entry.code === "REF_UNRESOLVED" &&
          entry.jsonPath === "models.providers.referenced.apiKey",
      ),
    ).toBe(false);
  });

  it("does not inspect or mutate legacy auth.json during audit", async () => {
    await writeJsonFile(fixture.authJsonPath, {
      openai: {
        type: "api_key",
        key: "sk-legacy-auth-json",
      },
    });

    const report = await runSecretsAudit({ env: fixture.env });
    expectFindingCode(report, "LEGACY_RESIDUE");
    expect(report.filesScanned).not.toContain(fixture.authJsonPath);
    const authJsonStat = await fs.stat(fixture.authJsonPath);
    expect(authJsonStat.isFile()).toBe(true);
    await expectPathMissing(fixture.authStorePath);
  });

  it("ignores malformed legacy auth JSON instead of reading it", async () => {
    await fs.writeFile(fixture.authJsonPath, "{invalid-json", "utf8");

    const report = await runSecretsAudit({ env: fixture.env });
    expectFindingCode(report, "LEGACY_RESIDUE");
    expectFindingFile(report, fixture.authJsonPath);
  });

  it("reports Doctor-created auth archives without reading their contents", async () => {
    const archivePaths = [
      `${fixture.authJsonPath}.migrated-2026-07-25T12-00-00.000Z-fake`,
      `${fixture.authJsonPath}.sqlite-import.1753430400000.bak`,
    ];
    for (const archivePath of archivePaths) {
      await fs.writeFile(archivePath, "opaque fake credential bytes", "utf8");
    }

    const report = await runSecretsAudit({ env: fixture.env });
    expectFindingCode(report, "LEGACY_RESIDUE");
    for (const archivePath of archivePaths) {
      expectFindingFile(report, archivePath);
      expect(report.filesScanned).not.toContain(archivePath);
    }
  });

  it("skips exec ref resolution during audit unless explicitly allowed", async () => {
    if (process.platform === "win32") {
      return;
    }
    const execLogPath = path.join(fixture.rootDir, "exec-calls-skipped.log");
    const execScriptPath = path.join(fixture.rootDir, "resolver-skipped.sh");
    await writeExecResolverShellScript({
      scriptPath: execScriptPath,
      logPath: execLogPath,
      values: {
        "providers/openai/apiKey": "value:providers/openai/apiKey",
      },
    });
    await writeExecSecretsAuditConfig({
      fixture,
      execScriptPath,
      providers: [
        {
          id: "openai",
          baseUrl: "https://api.openai.com/v1",
          modelId: "gpt-5",
          modelName: "gpt-5",
        },
      ],
    });

    const report = await runSecretsAudit({ env: fixture.env });
    expect(report.resolution.resolvabilityComplete).toBe(false);
    expect(report.resolution.skippedExecRefs).toBe(1);
    expect(report.summary.unresolvedRefCount).toBe(0);
    await expectPathMissing(execLogPath);
  });

  it("batches ref resolution per provider during audit when --allow-exec is enabled", async () => {
    if (process.platform === "win32") {
      return;
    }
    const execLogPath = path.join(fixture.rootDir, "exec-calls.log");
    const execScriptPath = path.join(fixture.rootDir, "resolver.sh");
    await writeExecResolverShellScript({
      scriptPath: execScriptPath,
      logPath: execLogPath,
      values: {
        "providers/openai/apiKey": "value:providers/openai/apiKey",
        "providers/openai/headers/Authorization": "value:providers/openai/headers/Authorization",
      },
    });
    await writeExecSecretsAuditConfig({
      fixture,
      execScriptPath,
      providers: [
        {
          id: "openai",
          baseUrl: "https://api.openai.com/v1",
          modelId: "gpt-5",
          modelName: "gpt-5",
          headerRefId: "providers/openai/headers/Authorization",
        },
      ],
    });

    const report = await runSecretsAudit({ env: fixture.env, allowExec: true });
    expect(report.summary.unresolvedRefCount).toBe(0);
    expect(report.resolution.refsChecked).toBe(2);

    const callLog = await fs.readFile(execLogPath, "utf8");
    const callCount = countNonEmptyLines(callLog);
    expect(callCount).toBe(1);
  });

  it("short-circuits per-ref fallback for provider-wide batch failures when --allow-exec is enabled", async () => {
    if (process.platform === "win32") {
      return;
    }
    const execLogPath = path.join(fixture.rootDir, "exec-fail-calls.log");
    const execScriptPath = path.join(fixture.rootDir, "resolver-fail.mjs");
    await fs.writeFile(
      execScriptPath,
      [
        "#!/usr/bin/env node",
        "import fs from 'node:fs';",
        `fs.appendFileSync(${JSON.stringify(execLogPath)}, 'x\\n');`,
        "process.exit(1);",
      ].join("\n"),
      { encoding: "utf8", mode: 0o700 },
    );

    await fs.writeFile(
      fixture.configPath,
      `${JSON.stringify(
        {
          secrets: {
            providers: {
              execmain: {
                source: "exec",
                command: execScriptPath,
                jsonOnly: true,
                passEnv: ["PATH"],
              },
            },
          },
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                api: "openai-completions",
                apiKey: { source: "exec", provider: "execmain", id: "providers/openai/apiKey" },
                headers: {
                  Authorization: {
                    source: "exec",
                    provider: "execmain",
                    id: "providers/openai/headers/Authorization",
                  },
                },
                models: [{ id: "gpt-5", name: "gpt-5" }],
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const report = await runSecretsAudit({ env: fixture.env, allowExec: true });
    expect(report.summary.unresolvedRefCount).toBeGreaterThanOrEqual(2);

    const callLog = await fs.readFile(execLogPath, "utf8");
    const callCount = countNonEmptyLines(callLog);
    expect(callCount).toBe(1);
  });

  it("scans agent models.json files for plaintext provider apiKey values", async () => {
    await writeModelsProvider({ apiKey: "sk-models-plaintext" }); // pragma: allowlist secret

    const report = await runSecretsAudit({ env: fixture.env });
    expectModelsFinding(report, {
      code: "PLAINTEXT_FOUND",
      jsonPath: "providers.openai.apiKey",
    });
    expect(report.filesScanned).toContain(fixture.modelsPath);
  });

  it("scans agent models.json files for plaintext provider header values", async () => {
    await writeModelsProvider({
      headers: {
        Authorization: "Bearer sk-header-plaintext", // pragma: allowlist secret
      },
    });

    const report = await runSecretsAudit({ env: fixture.env });
    expectModelsFinding(report, {
      code: "PLAINTEXT_FOUND",
      jsonPath: "providers.openai.headers.Authorization",
    });
  });

  it("does not flag non-sensitive routing headers in models.json", async () => {
    await writeModelsProvider({
      headers: {
        "X-Proxy-Region": "us-west",
      },
    });

    const report = await runSecretsAudit({ env: fixture.env });
    expectModelsFinding(report, {
      code: "PLAINTEXT_FOUND",
      jsonPath: "providers.openai.headers.X-Proxy-Region",
      present: false,
    });
  });

  it("exempts only known models.json apiKey markers from plaintext audit", async () => {
    await writeJsonFile(fixture.modelsPath, {
      providers: {
        knownMarker: {
          apiKey: OPENAI_API_KEY_MARKER,
        },
        arbitraryAllCaps: {
          apiKey: "ALLCAPS_SAMPLE", // pragma: allowlist secret
        },
      },
    });

    const report = await runSecretsAudit({ env: fixture.env });
    expectModelsFinding(report, {
      code: "PLAINTEXT_FOUND",
      jsonPath: "providers.knownMarker.apiKey",
      present: false,
    });
    expectModelsFinding(report, {
      code: "PLAINTEXT_FOUND",
      jsonPath: "providers.arbitraryAllCaps.apiKey",
    });
  });

  it("does not flag models.json header marker values as plaintext", async () => {
    await writeModelsProvider({
      headers: {
        Authorization: "secretref-env:OPENAI_HEADER_TOKEN", // pragma: allowlist secret
        "x-managed-token": "secretref-managed", // pragma: allowlist secret
      },
    });

    const report = await runSecretsAudit({ env: fixture.env });
    expectModelsFinding(report, {
      code: "PLAINTEXT_FOUND",
      jsonPath: "providers.openai.headers.Authorization",
      present: false,
    });
    expectModelsFinding(report, {
      code: "PLAINTEXT_FOUND",
      jsonPath: "providers.openai.headers.x-managed-token",
      present: false,
    });
  });

  it("reports unresolved models.json SecretRef objects in provider headers", async () => {
    await writeModelsProvider({
      headers: {
        Authorization: {
          source: "env",
          provider: "default",
          id: "OPENAI_HEADER_TOKEN", // pragma: allowlist secret
        },
      },
    });

    const report = await runSecretsAudit({ env: fixture.env });
    expectModelsFinding(report, {
      code: "REF_UNRESOLVED",
      jsonPath: "providers.openai.headers.Authorization",
    });
  });

  it("reports malformed models.json as unresolved findings", async () => {
    await fs.writeFile(fixture.modelsPath, "{bad-json", "utf8");
    const report = await runSecretsAudit({ env: fixture.env });
    expectModelsFinding(report, { code: "REF_UNRESOLVED" });
  });

  it("reports non-regular models.json files as unresolved findings", async () => {
    await fs.rm(fixture.modelsPath, { force: true });
    await fs.mkdir(fixture.modelsPath, { recursive: true });
    const report = await runSecretsAudit({ env: fixture.env });
    expectModelsFinding(report, { code: "REF_UNRESOLVED" });
  });

  it("reports oversized models.json as unresolved findings", async () => {
    // The audit rejects by stat before reading, so a sparse file proves the size bound cheaply.
    await fs.writeFile(fixture.modelsPath, "", "utf8");
    await fs.truncate(fixture.modelsPath, MAX_AUDIT_MODELS_JSON_BYTES + 256);

    const report = await runSecretsAudit({ env: fixture.env });
    expectModelsFinding(report, { code: "REF_UNRESOLVED" });
  });

  it("scans active agent-dir override models.json even when outside state dir", async () => {
    const externalAgentDir = path.join(fixture.rootDir, "external-agent");
    const externalModelsPath = path.join(externalAgentDir, "models.json");
    await fs.mkdir(externalAgentDir, { recursive: true });
    await writeJsonFile(externalModelsPath, {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-completions",
          apiKey: "sk-external-plaintext", // pragma: allowlist secret
          models: [{ id: "gpt-5", name: "gpt-5" }],
        },
      },
    });

    const report = await runSecretsAudit({
      env: {
        ...fixture.env,
        OPENCLAW_AGENT_DIR: externalAgentDir,
      },
    });
    expect(
      hasFinding(
        report,
        (entry) =>
          entry.code === "PLAINTEXT_FOUND" &&
          entry.file === externalModelsPath &&
          entry.jsonPath === "providers.openai.apiKey",
      ),
    ).toBe(true);
    expect(report.filesScanned).toContain(externalModelsPath);
  });

  it("classifies auth profile env shorthands as refs with or without explicit keyRef", async () => {
    writeAuthStore(fixture, {
      version: 1,
      profiles: {
        "openai:dollar": {
          type: "api_key",
          provider: "openai",
          key: "$OPENAI_API_KEY", // pragma: allowlist secret
        },
        "openai:braced": {
          type: "api_key",
          provider: "openai",
          key: "${OPENAI_API_KEY}", // pragma: allowlist secret
        },
        "openai:dollar-with-ref": {
          type: "api_key",
          provider: "openai",
          key: "$OPENAI_API_KEY", // pragma: allowlist secret
          keyRef: { source: "env", id: "OPENAI_API_KEY" },
        },
        "openai:braced-with-ref": {
          type: "api_key",
          provider: "openai",
          key: "${OPENAI_API_KEY}", // pragma: allowlist secret
          keyRef: { source: "env", id: "OPENAI_API_KEY" },
        },
        "openai:plaintext-with-ref": {
          type: "api_key",
          provider: "openai",
          key: "sk-leftover-plaintext", // pragma: allowlist secret
          keyRef: { source: "env", id: "OPENAI_API_KEY" },
        },
      },
    });

    const report = await runSecretsAudit({ env: fixture.env });
    const authPlaintextPaths = report.findings
      .filter((entry) => entry.code === "PLAINTEXT_FOUND" && entry.file === fixture.authStorePath)
      .map((entry) => entry.jsonPath);
    expect(authPlaintextPaths).toEqual(["profiles.openai:plaintext-with-ref.key"]);
  });

  it("reads a relocated shared store from the explicitly routed state root", async () => {
    const ambientStateDir = path.join(fixture.rootDir, "ambient-state");
    const ambientAgentDir = path.join(ambientStateDir, "agents", "main", "agent");
    vi.stubEnv("OPENCLAW_STATE_DIR", ambientStateDir);
    writePersistedAuthProfileStoreRaw(
      {
        version: 1,
        profiles: {
          "openai:ambient": {
            type: "api_key",
            provider: "openai",
            key: "sk-ambient-plaintext",
          },
        },
      },
      ambientAgentDir,
    );
    const stateDatabase = openOpenClawStateDatabase({ env: fixture.env }).db;
    stateDatabase
      .prepare(
        `INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
         VALUES ('auth.sharedStore', ?, 1)`,
      )
      .run(JSON.stringify({ location: "state-db" }));
    stateDatabase
      .prepare(
        "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, 1)",
      )
      .run(
        "authProfiles.store",
        JSON.stringify({
          version: 1,
          profiles: {
            "openai:target": {
              type: "api_key",
              provider: "openai",
              key: "sk-target-plaintext",
            },
          },
        }),
      );
    noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, fixture.env);

    const report = await runSecretsAudit({ env: fixture.env });
    const sharedFindings = report.findings
      .filter(
        (entry) =>
          entry.code === "PLAINTEXT_FOUND" &&
          entry.file === resolveSharedAuthStorePath(fixture.env),
      )
      .map((entry) => entry.jsonPath);

    expect(sharedFindings).toContain("profiles.openai:target.key");
    expect(sharedFindings).not.toContain("profiles.openai:ambient.key");
    expect(report.filesScanned).not.toContain(resolveAuthProfileDatabasePath(ambientAgentDir));
  });

  it("exempts direct routing headers but audits request headers in openclaw config", async () => {
    await writeJsonFile(fixture.configPath, {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-completions",
            apiKey: { source: "env", provider: "default", id: OPENAI_API_KEY_MARKER },
            headers: {
              "X-Proxy-Region": "us-west",
            },
            request: {
              headers: {
                "X-Proxy-Region": "us-west",
              },
            },
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
        },
      },
    });

    const report = await runSecretsAudit({ env: fixture.env });
    expect(
      hasFinding(
        report,
        (entry) =>
          entry.code === "PLAINTEXT_FOUND" &&
          entry.file === fixture.configPath &&
          entry.jsonPath === "models.providers.openai.headers.X-Proxy-Region",
      ),
    ).toBe(false);
    expect(
      hasFinding(
        report,
        (entry) =>
          entry.code === "PLAINTEXT_FOUND" &&
          entry.file === fixture.configPath &&
          entry.jsonPath === "models.providers.openai.request.headers.X-Proxy-Region",
      ),
    ).toBe(true);
  });

  it("exempts only known openclaw.json model provider apiKey markers", async () => {
    for (const { apiKey, isPlaintext } of [
      { apiKey: "lmstudio-local", isPlaintext: false },
      { apiKey: "ollama-local", isPlaintext: false },
      { apiKey: "sk-real-plaintext", isPlaintext: true },
    ]) {
      await writeJsonFile(fixture.configPath, {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              api: "openai-completions",
              apiKey,
              models: [{ id: "gpt-5", name: "gpt-5" }],
            },
          },
        },
      });

      const report = await runSecretsAudit({ env: fixture.env });
      expect(
        hasFinding(
          report,
          (entry) =>
            entry.code === "PLAINTEXT_FOUND" &&
            entry.file === fixture.configPath &&
            entry.jsonPath === "models.providers.openai.apiKey",
        ),
      ).toBe(isPlaintext);
    }
  });

  it("scans .env in legacy .clawdbot state directory via automatic fallback", async () => {
    // Do NOT set OPENCLAW_STATE_DIR or OPENCLAW_CONFIG_PATH — rely on
    // resolveStateDir's automatic legacy-directory fallback. A controlled
    // HOME that contains only .clawdbot (no .openclaw) exercises the exact
    // path the old resolveConfigDir call could not reach: resolveConfigDir
    // always returns $HOME/.openclaw, so it would miss the .env inside
    // .clawdbot.  resolveStateDir finds .clawdbot via its legacy-dir scan.
    const homeDir = tempDirs.make("openclaw-secrets-audit-legacy-");
    const legacyStateDir = path.join(homeDir, ".clawdbot");
    const configPath = path.join(legacyStateDir, "openclaw.json");
    const envPath = path.join(legacyStateDir, ".env");
    const agentDir = path.join(legacyStateDir, "agents", "main", "agent");

    await fs.mkdir(agentDir, { recursive: true });

    const env = {
      HOME: homeDir,
      OPENAI_API_KEY: "env-openai-key", // pragma: allowlist secret
      PATH: resolveRuntimePathEnv(),
    };

    await writeJsonFile(configPath, {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-completions",
            apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
        },
      },
    });

    await fs.writeFile(
      envPath,
      "OPENAI_API_KEY=sk-legacy-plaintext\n", // pragma: allowlist secret
      "utf8",
    );

    try {
      const report = await runSecretsAudit({ env });
      // Config-based key is ref'd from env, so no plaintext finding for config;
      // but the .env file should be scanned and reported via the legacy fallback.
      expect(report.status).toBe("findings");
      expect(report.findings.some((f) => f.code === "PLAINTEXT_FOUND" && f.file === envPath)).toBe(
        true,
      );
    } finally {
      closeOpenClawAgentDatabasesForTest();
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("scans config and state .env files when the config path is external", async () => {
    await seedAuditFixture(fixture);
    const configDir = path.join(fixture.rootDir, "config");
    const configPath = path.join(configDir, "openclaw.json");
    const configEnvPath = path.join(configDir, ".env");
    await fs.mkdir(configDir, { recursive: true });
    await fs.copyFile(fixture.configPath, configPath);
    await fs.copyFile(fixture.envPath, configEnvPath);
    fixture.env.OPENCLAW_CONFIG_PATH = configPath;

    const report = await runSecretsAudit({ env: fixture.env });

    expectFindingFile(report, configEnvPath);
    expectFindingFile(report, fixture.envPath);
  });
});
