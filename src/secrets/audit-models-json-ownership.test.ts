/** models.json env-marker ownership: model-provider only, not talk surfaces. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { runSecretsAudit } from "./audit.js";

type AuditFixture = {
  rootDir: string;
  stateDir: string;
  configPath: string;
  agentDir: string;
  modelsPath: string;
  env: NodeJS.ProcessEnv;
};

const OPENAI_API_KEY_MARKER = "OPENAI_API_KEY"; // pragma: allowlist secret

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function resolveRuntimePathEnv(): string {
  if (typeof process.env.PATH === "string" && process.env.PATH.trim().length > 0) {
    return process.env.PATH;
  }
  return "/usr/bin:/bin";
}

async function createAuditFixture(): Promise<AuditFixture> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-audit-own-"));
  const stateDir = path.join(rootDir, ".openclaw");
  const configPath = path.join(stateDir, "openclaw.json");
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  const modelsPath = path.join(agentDir, "models.json");
  await fs.mkdir(agentDir, { recursive: true });
  return {
    rootDir,
    stateDir,
    configPath,
    agentDir,
    modelsPath,
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENAI_API_KEY: "env-openai-key", // pragma: allowlist secret
      PATH: resolveRuntimePathEnv(),
    },
  };
}

function expectModelsFinding(
  report: Awaited<ReturnType<typeof runSecretsAudit>>,
  params: { code: string; jsonPath?: string; present?: boolean },
): void {
  const present = params.present !== false;
  const found = report.findings.some(
    (entry) =>
      entry.code === params.code &&
      entry.file.endsWith("models.json") &&
      (params.jsonPath === undefined || entry.jsonPath === params.jsonPath),
  );
  if (present) {
    expect(found).toBe(true);
  } else {
    expect(found).toBe(false);
  }
}

describe("secrets audit models.json env-marker ownership", () => {
  let fixture: AuditFixture;

  beforeEach(async () => {
    fixture = await createAuditFixture();
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(fixture.rootDir, { recursive: true, force: true });
  });

  it("does not flag custom-provider env SecretRef markers owned by models.providers", async () => {
    const customProviderId = "custom-factchat-cloud-mindlogic-ai";
    const customEnvId = "FACTCHAT_API_KEY"; // pragma: allowlist secret
    await writeJsonFile(fixture.configPath, {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-completions",
            apiKey: { source: "env", provider: "default", id: OPENAI_API_KEY_MARKER },
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
          [customProviderId]: {
            baseUrl: "https://factchat.example/v1",
            api: "openai-completions",
            apiKey: { source: "env", provider: "default", id: customEnvId },
            models: [{ id: "grok-4.1-fast", name: "grok-4.1-fast" }],
          },
        },
      },
    });
    await writeJsonFile(fixture.modelsPath, {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-completions",
          apiKey: OPENAI_API_KEY_MARKER,
          models: [{ id: "gpt-5", name: "gpt-5" }],
        },
        [customProviderId]: {
          baseUrl: "https://factchat.example/v1",
          api: "openai-completions",
          apiKey: customEnvId,
          models: [{ id: "grok-4.1-fast", name: "grok-4.1-fast" }],
        },
      },
    });

    const report = await runSecretsAudit({ env: fixture.env });
    expectModelsFinding(report, {
      code: "PLAINTEXT_FOUND",
      jsonPath: `providers.${customProviderId}.apiKey`,
      present: false,
    });
    expectModelsFinding(report, {
      code: "REF_UNRESOLVED",
      jsonPath: `providers.${customProviderId}.apiKey`,
      present: false,
    });
  });

  it("still flags bare custom markers when models.providers does not own the env SecretRef", async () => {
    const customProviderId = "custom-factchat-cloud-mindlogic-ai";
    await writeJsonFile(fixture.configPath, {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-completions",
            apiKey: { source: "env", provider: "default", id: OPENAI_API_KEY_MARKER },
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
          [customProviderId]: {
            baseUrl: "https://factchat.example/v1",
            api: "openai-completions",
            apiKey: { source: "env", provider: "default", id: "OTHER_FACTCHAT_API_KEY" }, // pragma: allowlist secret
            models: [{ id: "grok-4.1-fast", name: "grok-4.1-fast" }],
          },
        },
      },
    });
    await writeJsonFile(fixture.modelsPath, {
      providers: {
        [customProviderId]: {
          baseUrl: "https://factchat.example/v1",
          api: "openai-completions",
          apiKey: "FACTCHAT_API_KEY", // pragma: allowlist secret
          models: [{ id: "grok-4.1-fast", name: "grok-4.1-fast" }],
        },
      },
    });

    const report = await runSecretsAudit({ env: fixture.env });
    expectModelsFinding(report, {
      code: "PLAINTEXT_FOUND",
      jsonPath: `providers.${customProviderId}.apiKey`,
    });
  });

  it("does not accept a models.providers env SecretRef for a different provider id", async () => {
    await writeJsonFile(fixture.configPath, {
      models: {
        providers: {
          "owned-provider": {
            baseUrl: "https://owned.example/v1",
            api: "openai-completions",
            apiKey: { source: "env", provider: "default", id: "SHARED_CUSTOM_API_KEY" }, // pragma: allowlist secret
            models: [{ id: "m1", name: "m1" }],
          },
          "other-provider": {
            baseUrl: "https://other.example/v1",
            api: "openai-completions",
            apiKey: "sk-other-plaintext", // pragma: allowlist secret
            models: [{ id: "m2", name: "m2" }],
          },
        },
      },
    });
    await writeJsonFile(fixture.modelsPath, {
      providers: {
        "other-provider": {
          baseUrl: "https://other.example/v1",
          api: "openai-completions",
          apiKey: "SHARED_CUSTOM_API_KEY", // pragma: allowlist secret
          models: [{ id: "m2", name: "m2" }],
        },
      },
    });

    const report = await runSecretsAudit({ env: fixture.env });
    expectModelsFinding(report, {
      code: "PLAINTEXT_FOUND",
      jsonPath: "providers.other-provider.apiKey",
    });
  });

  it("does not let talk.providers env SecretRef exempt a plaintext models.json apiKey", async () => {
    const providerId = "shared-provider";
    const envId = "SHARED_TALK_AND_MODEL_KEY"; // pragma: allowlist secret
    await writeJsonFile(fixture.configPath, {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-completions",
            apiKey: { source: "env", provider: "default", id: OPENAI_API_KEY_MARKER },
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
        },
      },
      talk: {
        providers: {
          [providerId]: {
            apiKey: { source: "env", provider: "default", id: envId },
          },
        },
      },
    });
    await writeJsonFile(fixture.modelsPath, {
      providers: {
        [providerId]: {
          baseUrl: "https://model.example/v1",
          api: "openai-completions",
          apiKey: envId,
          models: [{ id: "m1", name: "m1" }],
        },
      },
    });

    const report = await runSecretsAudit({ env: fixture.env });
    expectModelsFinding(report, {
      code: "PLAINTEXT_FOUND",
      jsonPath: `providers.${providerId}.apiKey`,
    });
  });

  it.each([
    {
      name: "alias then canonical",
      providers: {
        OpenAI: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-completions",
          apiKey: { source: "env", provider: "default", id: "LOSING_ENV" },
          models: [{ id: "gpt-5", name: "gpt-5" }],
        },
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-completions",
          apiKey: { source: "env", provider: "default", id: "WINNING_ENV" },
          models: [{ id: "gpt-5", name: "gpt-5" }],
        },
      },
    },
    {
      name: "canonical then alias",
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-completions",
          apiKey: { source: "env", provider: "default", id: "WINNING_ENV" },
          models: [{ id: "gpt-5", name: "gpt-5" }],
        },
        OpenAI: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-completions",
          apiKey: { source: "env", provider: "default", id: "LOSING_ENV" },
          models: [{ id: "gpt-5", name: "gpt-5" }],
        },
      },
    },
  ])(
    "does not treat a losing provider alias env marker as writer-owned ($name)",
    async ({ providers }) => {
      await writeJsonFile(fixture.configPath, {
        models: { providers },
      });
      await writeJsonFile(fixture.modelsPath, {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-completions",
            apiKey: "LOSING_ENV",
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
        },
      });

      const report = await runSecretsAudit({ env: fixture.env });
      expectModelsFinding(report, {
        code: "PLAINTEXT_FOUND",
        jsonPath: "providers.openai.apiKey",
      });
    },
  );

  it.each([
    {
      name: "alias then canonical",
      providers: {
        OpenAI: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-completions",
          apiKey: { source: "env", provider: "default", id: "LOSING_ENV" },
          models: [{ id: "gpt-5", name: "gpt-5" }],
        },
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-completions",
          apiKey: { source: "env", provider: "default", id: "WINNING_ENV" },
          models: [{ id: "gpt-5", name: "gpt-5" }],
        },
      },
    },
    {
      name: "canonical then alias",
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-completions",
          apiKey: { source: "env", provider: "default", id: "WINNING_ENV" },
          models: [{ id: "gpt-5", name: "gpt-5" }],
        },
        OpenAI: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-completions",
          apiKey: { source: "env", provider: "default", id: "LOSING_ENV" },
          models: [{ id: "gpt-5", name: "gpt-5" }],
        },
      },
    },
  ])("still accepts the writer-winning canonical env marker ($name)", async ({ providers }) => {
    await writeJsonFile(fixture.configPath, {
      models: { providers },
    });
    await writeJsonFile(fixture.modelsPath, {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-completions",
          apiKey: "WINNING_ENV",
          models: [{ id: "gpt-5", name: "gpt-5" }],
        },
      },
    });

    const report = await runSecretsAudit({ env: fixture.env });
    expectModelsFinding(report, {
      code: "PLAINTEXT_FOUND",
      jsonPath: "providers.openai.apiKey",
      present: false,
    });
  });

  it("still owns an alias-only provider env marker after writer canonicalization", async () => {
    await writeJsonFile(fixture.configPath, {
      models: {
        providers: {
          OpenAI: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-completions",
            apiKey: { source: "env", provider: "default", id: OPENAI_API_KEY_MARKER },
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
        },
      },
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

    const report = await runSecretsAudit({ env: fixture.env });
    expectModelsFinding(report, {
      code: "PLAINTEXT_FOUND",
      jsonPath: "providers.openai.apiKey",
      present: false,
    });
  });

  it("does not let talk.realtime.providers env SecretRef exempt models.json plaintext", async () => {
    const providerId = "shared-provider";
    const envId = "SHARED_REALTIME_AND_MODEL_KEY"; // pragma: allowlist secret
    await writeJsonFile(fixture.configPath, {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-completions",
            apiKey: { source: "env", provider: "default", id: OPENAI_API_KEY_MARKER },
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
        },
      },
      talk: {
        realtime: {
          providers: {
            [providerId]: {
              apiKey: { source: "env", provider: "default", id: envId },
            },
          },
        },
      },
    });
    await writeJsonFile(fixture.modelsPath, {
      providers: {
        [providerId]: {
          baseUrl: "https://model.example/v1",
          api: "openai-completions",
          apiKey: envId,
          models: [{ id: "m1", name: "m1" }],
        },
      },
    });

    const report = await runSecretsAudit({ env: fixture.env });
    expectModelsFinding(report, {
      code: "PLAINTEXT_FOUND",
      jsonPath: `providers.${providerId}.apiKey`,
    });
  });
});
