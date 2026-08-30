import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import { createNamespacedModelConfig } from "../test-utils/model-namespace-fixture.js";
import {
  resolveImageFallbackCandidates,
  resolveModelCandidateChain,
} from "./model-fallback-candidates.js";
import { runWithModelFallback } from "./model-fallback-runner.js";
import type { normalizeProviderModelIdWithRuntime } from "./provider-model-normalization.runtime.js";

const normalizeModel = vi.hoisted(() => vi.fn<typeof normalizeProviderModelIdWithRuntime>());

vi.mock("./provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: normalizeModel,
}));

beforeEach(() => {
  normalizeModel.mockReset().mockReturnValue(undefined);
});

it.each(["text", "image", "runner", "default"] as const)(
  "keeps captured model context through %s fallback normalization",
  async (surface) => {
    const modelSelection = {
      primary: "fixture/current",
      fallbacks: ["fixture/backup"],
    };
    const cfg = {
      agents: { defaults: { model: modelSelection, imageModel: modelSelection } },
    } satisfies OpenClawConfig;
    const workspaceDir = "/tmp/captured-fallback-workspace";
    const snapshot = createPluginMetadataSnapshot({
      config: cfg,
      workspaceDir,
      manifestRegistry: {
        diagnostics: [],
        plugins: [
          {
            id: "fixture-normalizer",
            channels: [],
            providers: ["fixture"],
            cliBackends: [],
            skills: [],
            hooks: [],
            origin: "workspace",
            rootDir: workspaceDir,
            source: `${workspaceDir}/index.js`,
            manifestPath: `${workspaceDir}/openclaw.plugin.json`,
            modelIdNormalization: {
              providers: {
                fixture: {
                  aliases: {
                    current: "fixture/captured-primary",
                    backup: "fixture/captured-backup",
                  },
                },
              },
            },
          },
        ],
      },
    });
    const context = {
      cfg,
      config: cfg,
      workspaceDir,
      pluginMetadataSnapshot: snapshot,
      manifestPlugins: snapshot.plugins,
    };
    normalizeModel.mockImplementation((params) =>
      params.config === cfg &&
      params.workspaceDir === workspaceDir &&
      params.pluginMetadataSnapshot === snapshot
        ? params.context.modelId
        : "ambient-model",
    );
    const candidates =
      surface === "runner"
        ? [
            (
              await runWithModelFallback({
                ...context,
                provider: "fixture",
                model: "current",
                skipAuthProfileRuntime: true,
                run: async (provider, modelId) => ({ provider, model: modelId }),
              })
            ).result,
          ]
        : surface === "image"
          ? resolveImageFallbackCandidates({ ...context, defaultProvider: "fixture" })
          : resolveModelCandidateChain({
              ...context,
              provider: surface === "default" ? "" : "fixture",
              model: surface === "default" ? "" : "current",
            });

    expect(candidates.map(({ provider, model }) => ({ provider, model }))).toEqual([
      { provider: "fixture", model: "fixture/captured-primary" },
      ...(surface === "runner" ? [] : [{ provider: "fixture", model: "fixture/captured-backup" }]),
    ]);
    expect(normalizeModel).toHaveBeenCalled();
    for (const [params] of normalizeModel.mock.calls) {
      expect({
        config: params.config,
        workspaceDir: params.workspaceDir,
        snapshot: params.pluginMetadataSnapshot,
      }).toEqual({ config: cfg, workspaceDir, snapshot });
    }
  },
);

it.each(["text", "image"] as const)(
  "retains distinct configured model namespaces in %s fallbacks",
  (surface) => {
    const selection = { primary: "custom/model", fallbacks: ["custom/custom/model"] };
    const cfg: OpenClawConfig = {
      ...createNamespacedModelConfig(),
      agents: { defaults: { model: selection, imageModel: selection } },
    };
    const params = { cfg, manifestPlugins: [] };
    const candidates =
      surface === "image"
        ? resolveImageFallbackCandidates({ ...params, defaultProvider: "custom" })
        : resolveModelCandidateChain({ ...params, provider: "custom", model: "model" });

    expect(candidates.map(({ provider, model }) => ({ provider, model }))).toEqual([
      { provider: "custom", model: "model" },
      { provider: "custom", model: "custom/model" },
    ]);
  },
);

describe("resolveImageFallbackCandidates", () => {
  it("records unresolved configured entries without changing the resolved chain", async () => {
    const warnLogs = createWarnLogCapture("openclaw-image-fallback-candidates-test");
    const cfg = {
      agents: {
        defaults: {
          imageModel: {
            primary: "openai/",
            fallbacks: ["anthropic/claude-sonnet-4-6", "/vision"],
          },
        },
      },
    } as OpenClawConfig;

    try {
      expect(
        resolveImageFallbackCandidates({
          cfg,
          defaultProvider: "openai",
        }),
      ).toEqual([
        {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          routeOrigin: "configured-fallback",
          routeResolution: "resolved",
        },
      ]);
      expect(
        await warnLogs.findText(
          'Unresolved image model "openai/"; skipped configured-primary candidate.',
        ),
      ).toBeDefined();
      expect(
        await warnLogs.findText(
          'Unresolved image model "/vision"; skipped configured-fallback candidate.',
        ),
      ).toBeDefined();
    } finally {
      warnLogs.cleanup();
    }
  });

  it("does not warn for resolved configured entries", async () => {
    const warnLogs = createWarnLogCapture("openclaw-image-fallback-candidates-test");
    const cfg = {
      agents: {
        defaults: {
          imageModel: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
      },
    } as OpenClawConfig;

    try {
      expect(
        resolveImageFallbackCandidates({
          cfg,
          defaultProvider: "openai",
        }),
      ).toHaveLength(2);
      expect(await warnLogs.findText("Unresolved image model")).toBeUndefined();
    } finally {
      warnLogs.cleanup();
    }
  });
});
