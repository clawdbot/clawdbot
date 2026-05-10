import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSecretsAudit } from "./audit.js";

type AuditFixture = {
  rootDir: string;
  stateDir: string;
  configPath: string;
  authStorePath: string;
  authJsonPath: string;
  modelsPath: string;
  envPath: string;
  env: NodeJS.ProcessEnv;
};

const OPENAI_API_KEY_MARKER = "OPENAI_API_KEY"; // pragma: allowlist secret
const MAX_AUDIT_MODELS_JSON_BYTES = 5 * 1024 * 1024;

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
  const authStorePath = path.join(stateDir, "agents", "main", "agent", "auth-profiles.json");
  const authJsonPath = path.join(stateDir, "agents", "main", "agent", "auth.json");
  const modelsPath = path.join(stateDir, "agents", "main", "agent", "models.json");
  const envPath = path.join(stateDir, ".env");

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.mkdir(path.dirname(authStorePath), { recursive: true });

  return {
    rootDir,
    stateDir,
    configPath,
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
  await writeJsonFile(fixture.authStorePath, {
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
    await seedAuditFixture(fixture);
  });

  afterEach(async () => {
    await fs.rm(fixture.rootDir, { recursive: true, force: true });
  });

  it("reports plaintext + shadowing findings", async () => {
    const report = await runSecretsAudit({ env: fixture.env });
    expect(report.status).toBe("findings");
    expect(report.summary.plaintextCount).toBeGreaterThan(0);
    expect(report.summary.shadowedRefCount).toBeGreaterThan(0);
    expectFindingCode(report, "REF_SHADOWED");
    expectFindingCode(report, "PLAINTEXT_FOUND");
  });

  it("does not mutate legacy auth.json during audit", async () => {
    await fs.rm(fixture.authStorePath, { force: true });
    await writeJsonFile(fixture.authJsonPath, {
      openai: {
        type: "api_key",
        key: "sk-legacy-auth-json",
      },
    });

    const report = await runSecretsAudit({ env: fixture.env });
    expectFindingCode(report, "LEGACY_RESIDUE");
    const authJsonStat = await fs.stat(fixture.authJsonPath);
    expect(authJsonStat.isFile()).toBe(true);
    await expectPathMissing(fixture.authStorePath);
  });

  it("reports malformed sidecar JSON as findings instead of crashing", async () => {
    await fs.writeFile(fixture.authStorePath, "{invalid-json", "utf8");
    await fs.writeFile(fixture.authJsonPath, "{invalid-json", "utf8");

    const report = await runSecretsAudit({ env: fixture.env });
    expectFindingFile(report, fixture.authStorePath);
    expectFindingFile(report, fixture.authJsonPath);
    expectFindingCode(report, "REF_UNRESOLVED");
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
    await fs.rm(fixture.authStorePath, { force: true });
    await fs.writeFile(fixture.envPath, "", "utf8");

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
        "providers/moonshot/apiKey": "value:providers/moonshot/apiKey",
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
        {
          id: "moonshot",
          baseUrl: "https://api.moonshot.cn/v1",
          modelId: "moonshot-v1-8k",
          modelName: "moonshot-v1-8k",
        },
      ],
    });
    await fs.rm(fixture.authStorePath, { force: true });
    await fs.writeFile(fixture.envPath, "", "utf8");

    const report = await runSecretsAudit({ env: fixture.env, allowExec: true });
    expect(report.summary.unresolvedRefCount).toBe(0);

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
                models: [{ id: "gpt-5", name: "gpt-5" }],
              },
              moonshot: {
                baseUrl: "https://api.moonshot.cn/v1",
                api: "openai-completions",
                apiKey: { source: "exec", provider: "execmain", id: "providers/moonshot/apiKey" },
                models: [{ id: "moonshot-v1-8k", name: "moonshot-v1-8k" }],
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.rm(fixture.authStorePath, { force: true });
    await fs.writeFile(fixture.envPath, "", "utf8");

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

  it("does not flag models.json marker values as plaintext", async () => {
    await writeModelsProvider();

    const report = await runSecretsAudit({ env: fixture.env });
    expectModelsFinding(report, {
      code: "PLAINTEXT_FOUND",
      jsonPath: "providers.openai.apiKey",
      present: false,
    });
  });

  it("flags arbitrary all-caps models.json apiKey values as plaintext", async () => {
    await writeModelsProvider({ apiKey: "ALLCAPS_SAMPLE" }); // pragma: allowlist secret

    const report = await runSecretsAudit({ env: fixture.env });
    expectModelsFinding(report, {
      code: "PLAINTEXT_FOUND",
      jsonPath: "providers.openai.apiKey",
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
    const oversizedApiKey = "a".repeat(MAX_AUDIT_MODELS_JSON_BYTES + 256);
    await writeJsonFile(fixture.modelsPath, {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-completions",
          apiKey: oversizedApiKey,
          models: [{ id: "gpt-5", name: "gpt-5" }],
        },
      },
    });

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

  it("does not flag non-sensitive routing headers in openclaw config", async () => {
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
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
        },
      },
    });
    await writeJsonFile(fixture.authStorePath, {
      version: 1,
      profiles: {},
    });
    await fs.writeFile(fixture.envPath, "", "utf8");

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
  });
});
