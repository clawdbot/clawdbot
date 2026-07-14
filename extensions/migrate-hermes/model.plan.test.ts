// Migrate Hermes tests cover model.plan plugin behavior.
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, describe, expect, it } from "vitest";
import { HERMES_REASON_DEFAULT_MODEL_CONFIGURED } from "./items.js";
import { buildHermesMigrationProvider } from "./provider.js";
import { cleanupTempRoots, makeContext, makeTempRoot, writeFile } from "./test/provider-helpers.js";

function expectedHermesModelPlanItems(params: {
  modelStatus: "planned" | "conflict";
  modelReason?: string;
}) {
  return [
    {
      id: "config:default-model",
      kind: "config",
      action: "update",
      target: "agents.defaults.model",
      status: params.modelStatus,
      ...(params.modelReason ? { reason: params.modelReason } : {}),
      details: {
        model: "openai/gpt-5.4",
      },
    },
  ];
}

describe("Hermes migration model planning", () => {
  afterEach(async () => {
    await cleanupTempRoots();
  });

  it("preserves the provider for top-level string model refs", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    await writeFile(path.join(source, "config.yaml"), "provider: openai\nmodel: gpt-5.4\n");

    const provider = buildHermesMigrationProvider();
    const plan = await provider.plan(makeContext({ source, stateDir, workspaceDir }));

    expect(plan.items).toEqual(expectedHermesModelPlanItems({ modelStatus: "planned" }));
  });

  it("preserves provider routing for vendor-qualified models and normalizes aliases", async () => {
    const root = await makeTempRoot();
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const provider = buildHermesMigrationProvider();
    const cases = [
      ["openrouter", "anthropic/claude-opus-4.7", "openrouter/anthropic/claude-opus-4.7"],
      ["custom:local", "vendor/model", "local/vendor/model"],
      ["openai-codex", "gpt-5.6", "openai/gpt-5.6"],
      ["azure-foundry", "gpt-5.4", "microsoft-foundry/gpt-5.4"],
      ["bedrock", "anthropic.claude-opus-4-6-v1", "amazon-bedrock/anthropic.claude-opus-4-6-v1"],
      ["copilot", "gpt-5.4", "github-copilot/gpt-5.4"],
      ["gemini", "gemini-3.1-pro", "google/gemini-3.1-pro"],
      ["glm", "glm-5.2", "zai/glm-5.2"],
      ["kimi-for-coding", "kimi-k2.5", "moonshot/kimi-k2.5"],
      ["kimi-coding", "kimi-k2.5", "moonshot/kimi-k2.5"],
      ["kimi", "kimi-for-coding/kimi-k2.5", "moonshot/kimi-k2.5"],
      ["moonshot", "kimi-k2.5", "moonshot/kimi-k2.5"],
      ["alibaba", "qwen3.5-plus", "qwen/qwen3.5-plus"],
      ["dashscope", "qwen3.6-plus", "qwen/qwen3.6-plus"],
      ["alibaba-coding-plan", "qwen3-coder-next", "qwen/qwen3-coder-next"],
      ["xai-oauth", "grok-4.1-fast", "xai/grok-4.1-fast"],
      ["minimax-oauth", "MiniMax-M2.7", "minimax-portal/MiniMax-M2.7"],
      ["minimax-cn", "MiniMax-M2.7", "minimax/MiniMax-M2.7"],
      ["opencode-zen", "gpt-5.4", "opencode/gpt-5.4"],
      ["auto", "anthropic/claude-opus-4.6", "anthropic/claude-opus-4.6"],
      ["qwen-cli", "qwen3.5-plus", "qwen-oauth/qwen3.5-plus"],
      ["vertex", "gemini-3.1-pro", "google-vertex/gemini-3.1-pro"],
      ["custom:My Local LLM", "local-model", "my-local-llm/local-model"],
    ] as const;
    for (const [hermesProvider, model, expected] of cases) {
      const source = path.join(root, hermesProvider.replaceAll(":", "-"));
      await writeFile(
        path.join(source, "config.yaml"),
        `model:\n  provider: ${hermesProvider}\n  default: ${model}\n`,
      );
      const plan = await provider.plan(makeContext({ source, stateDir, workspaceDir }));
      expect(plan.items[0]?.details?.model).toBe(expected);
      expect(plan.items.some((item) => item.id.startsWith("config:model-provider:"))).toBe(
        ["alibaba", "dashscope", "minimax-cn"].includes(hermesProvider),
      );
      if (hermesProvider === "qwen-cli") {
        expect(
          plan.items.some(
            (item) => item.kind === "manual" && item.message?.includes("Qwen OAuth") === true,
          ),
        ).toBe(true);
      }
    }
  });

  it.each([
    ["sk-kimi-placeholder", "kimi/kimi-k2.5"],
    ["legacy-moonshot-placeholder", "moonshot/kimi-k2.5"],
  ])("routes kimi-coding from the effective key contract", async (apiKey, expectedModel) => {
    const root = await makeTempRoot();
    const source = path.join(root, expectedModel.split("/")[0]!);
    await writeFile(
      path.join(source, "config.yaml"),
      "model:\n  provider: kimi-coding\n  default: kimi-k2.5\n",
    );
    await writeFile(path.join(source, ".env"), `KIMI_API_KEY=${apiKey}\n`);

    const plan = await buildHermesMigrationProvider().plan(
      makeContext({
        source,
        stateDir: path.join(root, "state"),
        workspaceDir: path.join(root, "workspace"),
      }),
    );
    expect(plan.items[0]?.details?.model).toBe(expectedModel);
  });

  it("routes a model-scoped custom endpoint without an explicit provider", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    await writeFile(
      path.join(source, "config.yaml"),
      "model:\n  default: vendor/current-model\n  base_url: https://models.example/v1\n",
    );

    const plan = await buildHermesMigrationProvider().plan(
      makeContext({
        source,
        stateDir: path.join(root, "state"),
        workspaceDir: path.join(root, "workspace"),
      }),
    );

    expect(plan.items.find((item) => item.id === "config:default-model")?.details?.model).toBe(
      "custom/vendor/current-model",
    );
  });

  it("treats existing object-form default model primaries as conflicts", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    await writeFile(
      path.join(source, "config.yaml"),
      "model:\n  provider: openai\n  model: gpt-5.4\n",
    );

    const provider = buildHermesMigrationProvider();
    const plan = await provider.plan(
      makeContext({
        source,
        stateDir,
        workspaceDir,
        model: {
          primary: "anthropic/claude-sonnet-4.6",
          fallbacks: ["openai/gpt-5.4"],
        },
      }),
    );

    expect(plan.items).toEqual(
      expectedHermesModelPlanItems({
        modelStatus: "conflict",
        modelReason: HERMES_REASON_DEFAULT_MODEL_CONFIGURED,
      }),
    );
  });

  it("treats default-agent model overrides as conflicts", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    await writeFile(
      path.join(source, "config.yaml"),
      "model:\n  provider: openai\n  model: gpt-5.4\n",
    );
    const config = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          model: "openai/gpt-5.4",
        },
        list: [
          {
            id: "main",
            default: true,
            model: "anthropic/claude-sonnet-4.6",
          },
        ],
      },
    } as OpenClawConfig;

    const provider = buildHermesMigrationProvider();
    const plan = await provider.plan(makeContext({ source, stateDir, workspaceDir, config }));

    expect(plan.items).toEqual(
      expectedHermesModelPlanItems({
        modelStatus: "conflict",
        modelReason: HERMES_REASON_DEFAULT_MODEL_CONFIGURED,
      }),
    );
  });
});
