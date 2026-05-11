import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, describe, expect, it } from "vitest";
import { HERMES_REASON_DEFAULT_MODEL_CONFIGURED } from "./items.js";
import { buildHermesMigrationProvider } from "./provider.js";
import {
  cleanupTempRoots,
  makeConfigRuntime,
  makeContext,
  makeTempRoot,
  writeFile,
} from "./test/provider-helpers.js";

const HERMES_REASON_BLOCKED_BY_APPLY_CONFLICT = "blocked by earlier apply conflict";

const openaiProviderPatchValue = {
  openai: {
    baseUrl: "",
    apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    api: "openai-completions",
    models: [
      {
        id: "gpt-5.4",
        name: "gpt-5.4",
        api: "openai-responses",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
        metadataSource: "models-add",
      },
    ],
  },
};

function defaultModelItem(status: "migrated" | "conflict") {
  return {
    id: "config:default-model",
    kind: "config",
    action: "update",
    target: "agents.defaults.model",
    status,
    ...(status === "conflict" ? { reason: HERMES_REASON_DEFAULT_MODEL_CONFIGURED } : {}),
    details: { model: "openai/gpt-5.4" },
  };
}

function modelProvidersItem(status: "migrated" | "skipped") {
  return {
    id: "config:model-providers",
    kind: "config",
    action: "merge",
    source: undefined,
    target: "models.providers",
    status,
    ...(status === "skipped" ? { reason: HERMES_REASON_BLOCKED_BY_APPLY_CONFLICT } : {}),
    message: "Import Hermes provider and custom endpoint config.",
    details: {
      path: ["models", "providers"],
      value: openaiProviderPatchValue,
    },
  };
}

describe("Hermes migration model apply", () => {
  afterEach(async () => {
    await cleanupTempRoots();
  });

  it("updates only the primary model when applying over object-form model config", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    await writeFile(
      path.join(source, "config.yaml"),
      "model:\n  provider: openai\n  model: gpt-5.4\n",
    );
    const existingConfig = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          model: {
            primary: "anthropic/claude-sonnet-4.6",
            fallbacks: ["openrouter/anthropic/claude-opus-4.6"],
            timeoutMs: 120_000,
          },
        },
      },
    } as OpenClawConfig;
    let writtenConfig: OpenClawConfig | undefined;
    const provider = buildHermesMigrationProvider({
      runtime: makeConfigRuntime(existingConfig, (next) => {
        writtenConfig = next;
      }),
    });

    const result = await provider.apply(
      makeContext({
        source,
        stateDir,
        workspaceDir,
        overwrite: true,
        model: existingConfig.agents?.defaults?.model,
        reportDir,
      }),
    );

    expect(result.items).toEqual([defaultModelItem("migrated"), modelProvidersItem("migrated")]);
    expect(writtenConfig?.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.4",
      fallbacks: ["openrouter/anthropic/claude-opus-4.6"],
      timeoutMs: 120_000,
    });
  });

  it("updates the default-agent model override when applying with overwrite", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    await writeFile(
      path.join(source, "config.yaml"),
      "model:\n  provider: openai\n  model: gpt-5.4\n",
    );
    const existingConfig = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          model: {
            primary: "google/gemini-3-pro",
            fallbacks: ["openai/gpt-5.4"],
          },
        },
        list: [
          {
            id: "main",
            default: true,
            model: {
              primary: "anthropic/claude-sonnet-4.6",
              fallbacks: ["openrouter/anthropic/claude-opus-4.6"],
            },
          },
        ],
      },
    } as OpenClawConfig;
    let writtenConfig: OpenClawConfig | undefined;
    const provider = buildHermesMigrationProvider({
      runtime: makeConfigRuntime(existingConfig, (next) => {
        writtenConfig = next;
      }),
    });

    const result = await provider.apply(
      makeContext({
        source,
        stateDir,
        workspaceDir,
        config: existingConfig,
        overwrite: true,
        reportDir,
      }),
    );

    expect(result.items).toEqual([defaultModelItem("migrated"), modelProvidersItem("migrated")]);
    expect(writtenConfig?.agents?.list?.[0]?.model).toEqual({
      primary: "openai/gpt-5.4",
      fallbacks: ["openrouter/anthropic/claude-opus-4.6"],
    });
    expect(writtenConfig?.agents?.defaults?.model).toEqual(existingConfig.agents?.defaults?.model);
  });

  it("reports late-created default models as conflicts without overwriting", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    await writeFile(
      path.join(source, "config.yaml"),
      "model:\n  provider: openai\n  model: gpt-5.4\n",
    );
    const lateConfig = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          model: "anthropic/claude-sonnet-4.6",
        },
      },
    } as OpenClawConfig;
    const provider = buildHermesMigrationProvider({
      runtime: makeConfigRuntime(lateConfig),
    });
    const ctx = makeContext({ source, stateDir, workspaceDir, reportDir });
    const plan = await provider.plan(ctx);

    const result = await provider.apply(ctx, plan);

    expect(result.items).toEqual([defaultModelItem("conflict"), modelProvidersItem("skipped")]);
    expect(result.summary.conflicts).toBe(1);
    expect(lateConfig.agents?.defaults?.model).toBe("anthropic/claude-sonnet-4.6");
  });
});
