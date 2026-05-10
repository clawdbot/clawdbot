import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTalkTestProviderConfig,
  TALK_TEST_PROVIDER_API_KEY_PATH,
  TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS,
  TALK_TEST_PROVIDER_ID,
} from "../test-utils/talk-test-provider.js";
import type { SecretsApplyPlan } from "./plan.js";

const { clearSecretsRuntimeSnapshotMock, prepareSecretsRuntimeSnapshotMock } = vi.hoisted(() => ({
  clearSecretsRuntimeSnapshotMock: vi.fn(),
  prepareSecretsRuntimeSnapshotMock: vi.fn(async () => undefined),
}));

vi.mock("./runtime.js", () => ({
  clearSecretsRuntimeSnapshot: clearSecretsRuntimeSnapshotMock,
  prepareSecretsRuntimeSnapshot: prepareSecretsRuntimeSnapshotMock,
}));

let runSecretsApply: typeof import("./apply.js").runSecretsApply;
let applyTesting: typeof import("./apply.js").__testing;
let clearSecretsRuntimeSnapshot: typeof import("./runtime.js").clearSecretsRuntimeSnapshot;

const OPENAI_API_KEY_ENV_REF = {
  source: "env",
  provider: "default",
  id: "OPENAI_API_KEY",
} as const;

type ApplyFixture = {
  rootDir: string;
  stateDir: string;
  configPath: string;
  authStorePath: string;
  authJsonPath: string;
  envPath: string;
  env: NodeJS.ProcessEnv;
};

function stripVolatileConfigMeta(input: string): Record<string, unknown> {
  const parsed = JSON.parse(input) as Record<string, unknown>;
  const meta =
    parsed.meta && typeof parsed.meta === "object" && !Array.isArray(parsed.meta)
      ? { ...(parsed.meta as Record<string, unknown>) }
      : undefined;
  if (meta && "lastTouchedAt" in meta) {
    delete meta.lastTouchedAt;
  }
  if (meta) {
    parsed.meta = meta;
  }
  return parsed;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createOpenAiProviderConfig(apiKey: unknown = "sk-openai-plaintext") {
  return {
    baseUrl: "https://api.openai.com/v1",
    api: "openai-completions",
    apiKey,
    models: [{ id: "gpt-5", name: "gpt-5" }],
  };
}

function buildFixturePaths(rootDir: string) {
  const stateDir = path.join(rootDir, ".openclaw");
  return {
    rootDir,
    stateDir,
    configPath: path.join(stateDir, "openclaw.json"),
    authStorePath: path.join(stateDir, "agents", "main", "agent", "auth-profiles.json"),
    authJsonPath: path.join(stateDir, "agents", "main", "agent", "auth.json"),
    envPath: path.join(stateDir, ".env"),
  };
}

async function createApplyFixture(): Promise<ApplyFixture> {
  const paths = buildFixturePaths(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-apply-")),
  );
  await fs.mkdir(path.dirname(paths.configPath), { recursive: true });
  await fs.mkdir(path.dirname(paths.authStorePath), { recursive: true });
  return {
    ...paths,
    env: {
      OPENCLAW_STATE_DIR: paths.stateDir,
      OPENCLAW_CONFIG_PATH: paths.configPath,
      OPENAI_API_KEY: "sk-live-env", // pragma: allowlist secret
    },
  };
}

async function seedDefaultApplyFixture(fixture: ApplyFixture): Promise<void> {
  await writeJsonFile(fixture.configPath, {
    models: {
      providers: {
        openai: createOpenAiProviderConfig(),
      },
    },
  });
  await writeJsonFile(fixture.authStorePath, {
    version: 1,
    profiles: {
      "openai:default": {
        type: "api_key",
        provider: "openai",
        key: "sk-ope...text", // pragma: allowlist secret
        keyRef: OPENAI_API_KEY_ENV_REF,
      },
    },
  });
  await writeJsonFile(fixture.authJsonPath, {
    openai: {
      type: "api_key",
      key: "sk-openai-plaintext", // pragma: allowlist secret
    },
  });
  await fs.writeFile(
    fixture.envPath,
    "OPENAI_API_KEY=sk-openai-plaintext\nUNRELATED=value\n", // pragma: allowlist secret
    "utf8",
  );
}

async function applyPlanAndReadConfig<T>(
  fixture: ApplyFixture,
  plan: SecretsApplyPlan,
): Promise<T> {
  const result = await runSecretsApply({ plan, env: fixture.env, write: true });
  expect(result.changed).toBe(true);
  return JSON.parse(await fs.readFile(fixture.configPath, "utf8")) as T;
}

function createPlan(params: {
  targets: SecretsApplyPlan["targets"];
  options?: SecretsApplyPlan["options"];
  providerUpserts?: SecretsApplyPlan["providerUpserts"];
  providerDeletes?: SecretsApplyPlan["providerDeletes"];
}): SecretsApplyPlan {
  return {
    version: 1,
    protocolVersion: 1,
    generatedAt: new Date().toISOString(),
    generatedBy: "manual",
    targets: params.targets,
    ...(params.options ? { options: params.options } : {}),
    ...(params.providerUpserts ? { providerUpserts: params.providerUpserts } : {}),
    ...(params.providerDeletes ? { providerDeletes: params.providerDeletes } : {}),
  };
}

function createOpenAiProviderTarget(params?: {
  path?: string;
  pathSegments?: string[];
  providerId?: string;
}): SecretsApplyPlan["targets"][number] {
  return {
    type: "models.providers.apiKey",
    path: params?.path ?? "models.providers.openai.apiKey",
    ...(params?.pathSegments ? { pathSegments: params.pathSegments } : {}),
    providerId: params?.providerId ?? "openai",
    ref: OPENAI_API_KEY_ENV_REF,
  };
}

function createOpenAiExecProviderTarget(): SecretsApplyPlan["targets"][number] {
  return {
    type: "models.providers.apiKey",
    path: "models.providers.openai.apiKey",
    providerId: "openai",
    ref: { source: "exec", provider: "execmain", id: "providers/openai/apiKey" },
  };
}

function createOpenAiExecProviderPlan(): SecretsApplyPlan {
  return createPlan({
    targets: [createOpenAiExecProviderTarget()],
    options: {
      scrubEnv: false,
      scrubAuthProfilesForProviderTargets: false,
      scrubLegacyAuthJson: false,
    },
  });
}

function createOpenAiProviderHeaderTarget(params?: {
  path?: string;
  pathSegments?: string[];
}): SecretsApplyPlan["targets"][number] {
  return {
    type: "models.providers.headers",
    path: params?.path ?? "models.providers.openai.headers.x-api-key",
    ...(params?.pathSegments ? { pathSegments: params.pathSegments } : {}),
    ref: OPENAI_API_KEY_ENV_REF,
  };
}

async function writeOpenAiExecResolverConfig(params: {
  fixture: ApplyFixture;
  execScriptPath: string;
  execLogPath?: string;
}): Promise<void> {
  await fs.writeFile(
    params.execScriptPath,
    [
      "#!/bin/sh",
      ...(params.execLogPath ? [`printf 'x\\n' >> ${JSON.stringify(params.execLogPath)}`] : []),
      "cat >/dev/null",
      'printf \'{"protocolVersion":1,"values":{"providers/openai/apiKey":"sk-openai-exec"}}\'', // pragma: allowlist secret
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 },
  );

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
      providers: {
        openai: createOpenAiProviderConfig(),
      },
    },
  });
}

function createOneWayScrubOptions(): NonNullable<SecretsApplyPlan["options"]> {
  return {
    scrubEnv: true,
    scrubAuthProfilesForProviderTargets: true,
    scrubLegacyAuthJson: true,
  };
}

describe("secrets apply", () => {
  let fixture: ApplyFixture;

  beforeAll(async () => {
    ({ __testing: applyTesting, runSecretsApply } = await import("./apply.js"));
    ({ clearSecretsRuntimeSnapshot } = await import("./runtime.js"));
  });

  beforeEach(async () => {
    prepareSecretsRuntimeSnapshotMock.mockClear();
    clearSecretsRuntimeSnapshot();
    fixture = await createApplyFixture();
    await seedDefaultApplyFixture(fixture);
  });

  afterEach(async () => {
    clearSecretsRuntimeSnapshot();
    await fs.rm(fixture.rootDir, { recursive: true, force: true });
  });

  it("preflights and applies one-way scrub without plaintext backups", async () => {
    const plan = createPlan({
      targets: [createOpenAiProviderTarget()],
      options: createOneWayScrubOptions(),
    });

    const dryRun = await runSecretsApply({ plan, env: fixture.env, write: false });
    expect(dryRun.mode).toBe("dry-run");
    expect(dryRun.changed).toBe(true);
    expect(dryRun.skippedExecRefs).toBe(0);
    expect(dryRun.checks.resolvabilityComplete).toBe(true);

    const applied = await runSecretsApply({ plan, env: fixture.env, write: true });
    expect(applied.mode).toBe("write");
    expect(applied.changed).toBe(true);
    expect(prepareSecretsRuntimeSnapshotMock).toHaveBeenCalledTimes(1);

    const nextConfig = JSON.parse(await fs.readFile(fixture.configPath, "utf8")) as {
      models: { providers: { openai: { apiKey: unknown } } };
    };
    expect(nextConfig.models.providers.openai.apiKey).toEqual(OPENAI_API_KEY_ENV_REF);

    const nextAuthStore = JSON.parse(await fs.readFile(fixture.authStorePath, "utf8")) as {
      profiles: { "openai:default": { key?: string; keyRef?: unknown } };
    };
    expect(nextAuthStore.profiles["openai:default"].key).toBeUndefined();
    expect(nextAuthStore.profiles["openai:default"].keyRef).toEqual({
      source: "env",
      provider: "default",
      id: "OPENAI_API_KEY",
    });

    const nextAuthJson = JSON.parse(await fs.readFile(fixture.authJsonPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(nextAuthJson.openai).toBeUndefined();

    const nextEnv = await fs.readFile(fixture.envPath, "utf8");
    expect(nextEnv).not.toContain("sk-openai-plaintext");
    expect(nextEnv).toContain("UNRELATED=value");
  });

  it("preserves auth-profile tokenRef during provider scrub", async () => {
    await writeJsonFile(fixture.authStorePath, {
      version: 1,
      profiles: {
        "openai:bot": {
          type: "token",
          provider: "openai",
          token: "sk-token-plaintext", // pragma: allowlist secret
          tokenRef: OPENAI_API_KEY_ENV_REF,
        },
      },
    });
    const plan = createPlan({
      targets: [createOpenAiProviderTarget()],
      options: createOneWayScrubOptions(),
    });

    await runSecretsApply({ plan, env: fixture.env, write: true });

    const nextAuthStore = JSON.parse(await fs.readFile(fixture.authStorePath, "utf8")) as {
      profiles: { "openai:bot": { token?: string; tokenRef?: unknown } };
    };
    expect(nextAuthStore.profiles["openai:bot"].token).toBeUndefined();
    expect(nextAuthStore.profiles["openai:bot"].tokenRef).toEqual(OPENAI_API_KEY_ENV_REF);
  });

  it("scrubs malformed auth-profile ref residue during provider scrub", async () => {
    await writeJsonFile(fixture.authStorePath, {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-openai-plaintext", // pragma: allowlist secret
          keyRef: "secretref-managed", // pragma: allowlist secret
        },
      },
    });
    const plan = createPlan({
      targets: [createOpenAiProviderTarget()],
      options: createOneWayScrubOptions(),
    });

    await runSecretsApply({ plan, env: fixture.env, write: true });

    const nextAuthStore = JSON.parse(await fs.readFile(fixture.authStorePath, "utf8")) as {
      profiles: { "openai:default": { key?: string; keyRef?: unknown } };
    };
    expect(nextAuthStore.profiles["openai:default"].key).toBeUndefined();
    expect(nextAuthStore.profiles["openai:default"].keyRef).toBeUndefined();
  });

  it("skips exec SecretRef checks during dry-run unless explicitly allowed", async () => {
    if (process.platform === "win32") {
      return;
    }
    const execLogPath = path.join(fixture.rootDir, "exec-calls.log");
    const execScriptPath = path.join(fixture.rootDir, "resolver.sh");
    await writeOpenAiExecResolverConfig({ fixture, execScriptPath, execLogPath });

    const plan = createOpenAiExecProviderPlan();

    const dryRunSkipped = await runSecretsApply({ plan, env: fixture.env, write: false });
    expect(dryRunSkipped.mode).toBe("dry-run");
    expect(dryRunSkipped.skippedExecRefs).toBe(1);
    expect(dryRunSkipped.checks.resolvabilityComplete).toBe(false);
    try {
      await fs.stat(execLogPath);
      throw new Error("Expected exec log stat to fail");
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    }

    const dryRunAllowed = await runSecretsApply({
      plan,
      env: fixture.env,
      write: false,
      allowExec: true,
    });
    expect(dryRunAllowed.mode).toBe("dry-run");
    expect(dryRunAllowed.skippedExecRefs).toBe(0);
    const callLog = await fs.readFile(execLogPath, "utf8");
    expect(callLog.split("\n").some((line) => line.trim().length > 0)).toBe(true);
  });

  it("ignores unrelated auth-profile store refs during allowExec dry-run preflight", async () => {
    if (process.platform === "win32") {
      return;
    }
    const execScriptPath = path.join(fixture.rootDir, "resolver.sh");
    await writeOpenAiExecResolverConfig({ fixture, execScriptPath });
    await writeJsonFile(fixture.authStorePath, {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "MISSING_AUTH_STORE_KEY" },
        },
      },
    });

    const plan = createOpenAiExecProviderPlan();

    const result = await runSecretsApply({ plan, env: fixture.env, write: false, allowExec: true });
    expect(result.mode).toBe("dry-run");
    expect(result.skippedExecRefs).toBe(0);
    expect(result.checks.resolvabilityComplete).toBe(true);
  });

  it("ignores unrelated auth-profile store refs during no-op write apply", async () => {
    await writeJsonFile(fixture.configPath, {
      models: {
        providers: {
          openai: {
            ...createOpenAiProviderConfig(),
            apiKey: OPENAI_API_KEY_ENV_REF,
          },
        },
      },
    });
    await writeJsonFile(fixture.authStorePath, {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "MISSING_AUTH_STORE_KEY" },
        },
      },
    });

    const plan = createPlan({
      targets: [createOpenAiProviderTarget()],
      options: {
        scrubEnv: false,
        scrubAuthProfilesForProviderTargets: false,
        scrubLegacyAuthJson: false,
      },
    });

    const result = await runSecretsApply({ plan, env: fixture.env, write: true });
    expect(result.mode).toBe("write");
    expect(result.changed).toBe(false);
    expect(result.changedFiles).toStrictEqual([]);
    expect(result.checks.resolvabilityComplete).toBe(true);
  });

  it("rejects write mode for exec plans unless allowExec is set", async () => {
    const plan = createPlan({
      targets: [
        {
          type: "models.providers.apiKey",
          path: "models.providers.openai.apiKey",
          providerId: "openai",
          ref: { source: "exec", provider: "execmain", id: "providers/openai/apiKey" },
        },
      ],
      options: {
        scrubEnv: false,
        scrubAuthProfilesForProviderTargets: false,
        scrubLegacyAuthJson: false,
      },
    });

    await expect(runSecretsApply({ plan, env: fixture.env, write: true })).rejects.toThrow(
      "Plan contains exec SecretRefs/providers. Re-run with --allow-exec.",
    );
  });

  it("rejects write mode for plans with exec provider upserts unless allowExec is set", async () => {
    const plan = createPlan({
      targets: [createOpenAiProviderTarget()],
      providerUpserts: {
        execmain: {
          source: "exec",
          command: "/bin/echo",
          args: ["ok"],
        },
      },
      options: {
        scrubEnv: false,
        scrubAuthProfilesForProviderTargets: false,
        scrubLegacyAuthJson: false,
      },
    });

    await expect(runSecretsApply({ plan, env: fixture.env, write: true })).rejects.toThrow(
      "Plan contains exec SecretRefs/providers. Re-run with --allow-exec.",
    );
  });

  it("applies auth-profiles sibling ref targets to the scoped agent store", async () => {
    const plan: SecretsApplyPlan = {
      version: 1,
      protocolVersion: 1,
      generatedAt: new Date().toISOString(),
      generatedBy: "manual",
      targets: [
        {
          type: "auth-profiles.api_key.key",
          path: "profiles.openai:default.key",
          pathSegments: ["profiles", "openai:default", "key"],
          agentId: "main",
          ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      ],
      options: {
        scrubEnv: false,
        scrubAuthProfilesForProviderTargets: false,
        scrubLegacyAuthJson: false,
      },
    };

    const result = await runSecretsApply({ plan, env: fixture.env, write: true });
    expect(result.changed).toBe(true);
    expect(result.changedFiles).toContain(fixture.authStorePath);

    const nextAuthStore = JSON.parse(await fs.readFile(fixture.authStorePath, "utf8")) as {
      profiles: { "openai:default": { key?: string; keyRef?: unknown } };
    };
    expect(nextAuthStore.profiles["openai:default"].key).toBeUndefined();
    expect(nextAuthStore.profiles["openai:default"].keyRef).toEqual({
      source: "env",
      provider: "default",
      id: "OPENAI_API_KEY",
    });
  });

  it("creates a new auth-profiles mapping when provider metadata is supplied", async () => {
    const plan: SecretsApplyPlan = {
      version: 1,
      protocolVersion: 1,
      generatedAt: new Date().toISOString(),
      generatedBy: "manual",
      targets: [
        {
          type: "auth-profiles.token.token",
          path: "profiles.openai:bot.token",
          pathSegments: ["profiles", "openai:bot", "token"],
          agentId: "main",
          authProfileProvider: "openai",
          ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      ],
      options: {
        scrubEnv: false,
        scrubAuthProfilesForProviderTargets: false,
        scrubLegacyAuthJson: false,
      },
    };

    await runSecretsApply({ plan, env: fixture.env, write: true });
    const nextAuthStore = JSON.parse(await fs.readFile(fixture.authStorePath, "utf8")) as {
      profiles: {
        "openai:bot": {
          type: string;
          provider: string;
          tokenRef?: unknown;
        };
      };
    };
    expect(nextAuthStore.profiles["openai:bot"]).toEqual({
      type: "token",
      provider: "openai",
      tokenRef: {
        source: "env",
        provider: "default",
        id: "OPENAI_API_KEY",
      },
    });
  });

  it("is idempotent on repeated write applies", async () => {
    const plan = createPlan({
      targets: [createOpenAiProviderTarget()],
      options: createOneWayScrubOptions(),
    });

    const first = await runSecretsApply({ plan, env: fixture.env, write: true });
    expect(first.changed).toBe(true);
    const configAfterFirst = await fs.readFile(fixture.configPath, "utf8");
    const authStoreAfterFirst = await fs.readFile(fixture.authStorePath, "utf8");
    const authJsonAfterFirst = await fs.readFile(fixture.authJsonPath, "utf8");
    const envAfterFirst = await fs.readFile(fixture.envPath, "utf8");

    await fs.chmod(fixture.configPath, 0o400);
    await fs.chmod(fixture.authStorePath, 0o400);

    const second = await runSecretsApply({ plan, env: fixture.env, write: true });
    expect(second.mode).toBe("write");
    const configAfterSecond = await fs.readFile(fixture.configPath, "utf8");
    expect(stripVolatileConfigMeta(configAfterSecond)).toEqual(
      stripVolatileConfigMeta(configAfterFirst),
    );
    await expect(fs.readFile(fixture.authStorePath, "utf8")).resolves.toBe(authStoreAfterFirst);
    await expect(fs.readFile(fixture.authJsonPath, "utf8")).resolves.toBe(authJsonAfterFirst);
    await expect(fs.readFile(fixture.envPath, "utf8")).resolves.toBe(envAfterFirst);
  });

  it("applies targets safely when map keys contain dots", async () => {
    await writeJsonFile(fixture.configPath, {
      models: {
        providers: {
          "openai.dev": createOpenAiProviderConfig(),
        },
      },
    });

    const plan = createPlan({
      targets: [
        createOpenAiProviderTarget({
          path: "models.providers.openai.dev.apiKey",
          pathSegments: ["models", "providers", "openai.dev", "apiKey"],
          providerId: "openai.dev",
        }),
      ],
      options: {
        scrubEnv: false,
        scrubAuthProfilesForProviderTargets: false,
        scrubLegacyAuthJson: false,
      },
    });

    const nextConfig = (await applyTesting.projectConfigForTest({
      plan,
      env: fixture.env,
    })) as {
      models?: {
        providers?: Record<string, { apiKey?: unknown }>;
      };
    };
    expect(nextConfig.models?.providers?.["openai.dev"]?.apiKey).toEqual(OPENAI_API_KEY_ENV_REF);
    expect(nextConfig.models?.providers?.openai).toBeUndefined();
  });

  it("migrates skills entries apiKey targets alongside provider api keys", async () => {
    await writeJsonFile(fixture.configPath, {
      models: {
        providers: {
          openai: createOpenAiProviderConfig(),
        },
      },
      skills: {
        entries: {
          "qa-secret-test": {
            enabled: true,
            apiKey: "sk-skill-plaintext", // pragma: allowlist secret
          },
        },
      },
    });

    const plan = createPlan({
      targets: [
        createOpenAiProviderTarget({ pathSegments: ["models", "providers", "openai", "apiKey"] }),
        {
          type: "skills.entries.apiKey",
          path: "skills.entries.qa-secret-test.apiKey",
          pathSegments: ["skills", "entries", "qa-secret-test", "apiKey"],
          ref: OPENAI_API_KEY_ENV_REF,
        },
      ],
      options: createOneWayScrubOptions(),
    });

    const nextConfig = await applyPlanAndReadConfig<{
      models: { providers: { openai: { apiKey: unknown } } };
      skills: { entries: { "qa-secret-test": { apiKey: unknown } } };
    }>(fixture, plan);
    expect(nextConfig.models.providers.openai.apiKey).toEqual(OPENAI_API_KEY_ENV_REF);
    expect(nextConfig.skills.entries["qa-secret-test"].apiKey).toEqual(OPENAI_API_KEY_ENV_REF);

    const rawConfig = await fs.readFile(fixture.configPath, "utf8");
    expect(rawConfig).not.toContain("sk-openai-plaintext");
    expect(rawConfig).not.toContain("sk-skill-plaintext");
  });

  it("applies talk provider target types", async () => {
    await writeJsonFile(
      fixture.configPath,
      buildTalkTestProviderConfig("sk-talk-plaintext"), // pragma: allowlist secret
    );

    const plan: SecretsApplyPlan = {
      version: 1,
      protocolVersion: 1,
      generatedAt: new Date().toISOString(),
      generatedBy: "manual",
      targets: [
        {
          type: "talk.providers.*.apiKey",
          path: TALK_TEST_PROVIDER_API_KEY_PATH,
          pathSegments: [...TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS],
          ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      ],
      options: {
        scrubEnv: false,
        scrubAuthProfilesForProviderTargets: false,
        scrubLegacyAuthJson: false,
      },
    };

    const nextConfig = (await applyTesting.projectConfigForTest({
      plan,
      env: fixture.env,
    })) as {
      talk?: { providers?: Record<string, { apiKey?: unknown }> };
    };
    expect(nextConfig.talk?.providers?.[TALK_TEST_PROVIDER_ID]?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "OPENAI_API_KEY",
    });
  });

  it("applies model provider header targets", async () => {
    await writeJsonFile(fixture.configPath, {
      models: {
        providers: {
          openai: {
            ...createOpenAiProviderConfig(),
            headers: {
              "x-api-key": "sk-header-plaintext",
            },
          },
        },
      },
    });

    const plan = createPlan({
      targets: [
        createOpenAiProviderHeaderTarget({
          pathSegments: ["models", "providers", "openai", "headers", "x-api-key"],
        }),
      ],
      options: {
        scrubEnv: false,
        scrubAuthProfilesForProviderTargets: false,
        scrubLegacyAuthJson: false,
      },
    });

    const nextConfig = (await applyTesting.projectConfigForTest({
      plan,
      env: fixture.env,
    })) as {
      models?: {
        providers?: {
          openai?: {
            headers?: Record<string, unknown>;
          };
        };
      };
    };
    expect(nextConfig.models?.providers?.openai?.headers?.["x-api-key"]).toEqual(
      OPENAI_API_KEY_ENV_REF,
    );
  });

  it("applies array-indexed targets for agent memory search", async () => {
    await fs.writeFile(
      fixture.configPath,
      `${JSON.stringify(
        {
          agents: {
            list: [
              {
                id: "main",
                memorySearch: {
                  remote: {
                    apiKey: "sk-memory-plaintext", // pragma: allowlist secret
                  },
                },
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const plan: SecretsApplyPlan = {
      version: 1,
      protocolVersion: 1,
      generatedAt: new Date().toISOString(),
      generatedBy: "manual",
      targets: [
        {
          type: "agents.list[].memorySearch.remote.apiKey",
          path: "agents.list.0.memorySearch.remote.apiKey",
          pathSegments: ["agents", "list", "0", "memorySearch", "remote", "apiKey"],
          ref: { source: "env", provider: "default", id: "MEMORY_REMOTE_API_KEY" },
        },
      ],
      options: {
        scrubEnv: false,
        scrubAuthProfilesForProviderTargets: false,
        scrubLegacyAuthJson: false,
      },
    };

    fixture.env.MEMORY_REMOTE_API_KEY = "sk-memory-live-env"; // pragma: allowlist secret
    const nextConfig = (await applyTesting.projectConfigForTest({
      plan,
      env: fixture.env,
    })) as {
      agents?: {
        list?: Array<{
          memorySearch?: {
            remote?: {
              apiKey?: unknown;
            };
          };
        }>;
      };
    };
    expect(nextConfig.agents?.list?.[0]?.memorySearch?.remote?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "MEMORY_REMOTE_API_KEY",
    });
  });

  it("rejects plan targets that do not match allowed secret-bearing paths", async () => {
    const plan: SecretsApplyPlan = {
      version: 1,
      protocolVersion: 1,
      generatedAt: new Date().toISOString(),
      generatedBy: "manual",
      targets: [
        {
          type: "models.providers.apiKey",
          path: "models.providers.openai.baseUrl",
          pathSegments: ["models", "providers", "openai", "baseUrl"],
          providerId: "openai",
          ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      ],
    };

    await expect(runSecretsApply({ plan, env: fixture.env, write: false })).rejects.toThrow(
      "Invalid plan target path",
    );
  });

  it("rejects plan targets with forbidden prototype-like path segments", async () => {
    const plan: SecretsApplyPlan = {
      version: 1,
      protocolVersion: 1,
      generatedAt: new Date().toISOString(),
      generatedBy: "manual",
      targets: [
        {
          type: "skills.entries.apiKey",
          path: "skills.entries.__proto__.apiKey",
          pathSegments: ["skills", "entries", "__proto__", "apiKey"],
          ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      ],
    };

    await expect(runSecretsApply({ plan, env: fixture.env, write: false })).rejects.toThrow(
      "Invalid plan target path",
    );
  });

  it("applies provider upserts and deletes from plan", async () => {
    await writeJsonFile(fixture.configPath, {
      secrets: {
        providers: {
          envmain: { source: "env" },
          fileold: { source: "file", path: "/tmp/old-secrets.json", mode: "json" },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-completions",
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
        },
      },
    });

    const plan = createPlan({
      providerUpserts: {
        filemain: {
          source: "file",
          path: "/tmp/new-secrets.json",
          mode: "json",
        },
      },
      providerDeletes: ["fileold"],
      targets: [],
    });

    const nextConfig = (await applyTesting.projectConfigForTest({
      plan,
      env: fixture.env,
    })) as {
      secrets?: {
        providers?: Record<string, unknown>;
      };
    };
    expect(nextConfig.secrets?.providers?.fileold).toBeUndefined();
    expect(nextConfig.secrets?.providers?.filemain).toEqual({
      source: "file",
      path: "/tmp/new-secrets.json",
      mode: "json",
    });
  });
});
