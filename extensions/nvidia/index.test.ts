import fs from "node:fs";
import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

type NvidiaManifest = {
  providerAuthChoices?: Array<{ choiceId?: string; method?: string; provider?: string }>;
};

function readManifest(): NvidiaManifest {
  return JSON.parse(
    fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
  ) as NvidiaManifest;
}

async function registerNvidiaProvider() {
  return registerSingleProviderPlugin(plugin);
}

describe("nvidia provider hooks", () => {
  it("registers the nvidia provider with correct metadata", async () => {
    const provider = await registerNvidiaProvider();

    expect(provider.id).toBe("nvidia");
    expect(provider.label).toBe("NVIDIA");
    expect(provider.docsPath).toBe("/providers/nvidia");
    expect(provider.envVars).toEqual(["NVIDIA_API_KEY"]);
  });

  it("registers API-key auth choice metadata", async () => {
    const provider = await registerNvidiaProvider();

    expect(provider.auth?.map((method) => method.id)).toEqual(["api-key"]);

    const choice = resolveProviderPluginChoice({
      providers: [provider],
      choice: "nvidia-api-key",
    });
    expect(choice?.provider.id).toBe("nvidia");
    expect(choice?.method.id).toBe("api-key");
    expect(readManifest().providerAuthChoices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "nvidia",
          method: "api-key",
          choiceId: "nvidia-api-key",
        }),
      ]),
    );
  });

  it("keeps nvidia auth setup metadata aligned", async () => {
    const provider = await registerNvidiaProvider();

    expect(
      provider.auth.map((method) => ({
        id: method.id,
        label: method.label,
        hint: method.hint,
        choiceId: method.wizard?.choiceId,
        groupId: method.wizard?.groupId,
        groupLabel: method.wizard?.groupLabel,
        groupHint: method.wizard?.groupHint,
      })),
    ).toEqual([
      {
        id: "api-key",
        label: "NVIDIA API key",
        hint: "Direct API key",
        choiceId: "nvidia-api-key",
        groupId: "nvidia",
        groupLabel: "NVIDIA",
        groupHint: "Direct API key",
      },
    ]);
  });

  it("keeps nvidia wizard setup metadata aligned", async () => {
    const provider = await registerNvidiaProvider();

    expect(provider.wizard?.setup).toMatchObject({
      choiceId: "nvidia-api-key",
      choiceLabel: "NVIDIA API key",
      groupId: "nvidia",
      groupLabel: "NVIDIA",
      groupHint: "Direct API key",
      methodId: "api-key",
    });
  });

  it("keeps nvidia model picker metadata aligned", async () => {
    const provider = await registerNvidiaProvider();

    expect(provider.wizard?.modelPicker).toMatchObject({
      label: "NVIDIA (custom)",
      hint: "Use NVIDIA-hosted open models",
      methodId: "api-key",
    });
  });

  it("does not override replay policy for standard openai-compatible transport", async () => {
    const provider = await registerNvidiaProvider();

    // NVIDIA uses standard OpenAI-compatible API without custom replay logic
    expect(provider.buildReplayPolicy).toBeUndefined();
  });

  it("does not override stream wrapper for standard models", async () => {
    const provider = await registerNvidiaProvider();

    // NVIDIA uses standard streaming without custom wrappers
    expect(provider.wrapStreamFn).toBeUndefined();
  });

  it("surfaces the bundled NVIDIA models via augmentModelCatalog", async () => {
    const provider = await registerNvidiaProvider();

    const entries = await provider.augmentModelCatalog?.({
      env: process.env,
      entries: [],
    });

    expect(entries?.map((entry) => entry.id)).toEqual([
      "nvidia/nemotron-3-super-120b-a12b",
      "moonshotai/kimi-k2.5",
      "minimaxai/minimax-m2.5",
      "z-ai/glm5",
    ]);
    expect(entries?.every((entry) => entry.provider === "nvidia")).toBe(true);
  });

  it("opts into literal provider-prefix preservation", async () => {
    const provider = await registerNvidiaProvider();

    // NVIDIA's ids like nvidia/nemotron-... sit alongside moonshotai/...,
    // minimaxai/..., z-ai/... in the same catalog, so the leading nvidia/
    // is a vendor namespace rather than a redundant provider prefix. The
    // flag keeps the canonical ref as nvidia/nvidia/nemotron-... instead
    // of letting the default string-based dedupe collapse it.
    expect(provider.preserveLiteralProviderPrefix).toBe(true);
  });

  it("registers nvidia provider through the plugin api", () => {
    const registeredProviders: string[] = [];

    plugin.register({
      registerProvider(provider: { id: string }) {
        registeredProviders.push(provider.id);
      },
    } as any);

    expect(registeredProviders).toContain("nvidia");
  });
});
