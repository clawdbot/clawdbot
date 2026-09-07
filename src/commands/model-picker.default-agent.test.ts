// Model picker tests read the target agent without rewriting global defaults.
import { describe, expect, it, vi } from "vitest";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { WizardPrompter } from "../wizard/prompts.js";

vi.mock("./model-picker.runtime.js", () => ({
  modelPickerRuntime: { resolvePluginProviders: () => [] },
}));

import { promptDefaultModel } from "./model-picker.js";

const cases: Array<{ name: string; model?: AgentModelConfig; expected: string }> = [
  {
    name: "fallback-only agent inherits its primary",
    model: { fallbacks: ["anthropic/backup-model"] },
    expected: "openai/global-model",
  },
  {
    name: "explicit agent primary wins",
    model: "anthropic/ops-model",
    expected: "anthropic/ops-model",
  },
  { name: "agent without an override uses the global primary", expected: "openai/global-model" },
];

describe.each(cases)("promptDefaultModel: $name", ({ model, expected }) => {
  it.each(["__keep__", "__manual__"])("shows the effective primary for %s", async (choice) => {
    const config = {
      agents: {
        defaults: { model: "openai/global-model" },
        entries: { ops: { default: true, ...(model !== undefined ? { model } : {}) } },
      },
    } satisfies OpenClawConfig;
    const before = structuredClone(config);
    const text = vi.fn(async (params: { initialValue?: string }) => {
      expect(params.initialValue).toBe(expected);
      return expected;
    });
    const prompter: WizardPrompter = {
      intro: async () => {},
      outro: async () => {},
      note: async () => {},
      select: async ({ options }) => {
        if (choice === "__keep__") {
          expect(options.find((option) => option.value === "__keep__")?.label).toContain(expected);
        }
        const selected = options.find((option) => option.value === choice);
        if (!selected) {
          throw new Error(`Missing picker option: ${choice}`);
        }
        return selected.value;
      },
      multiselect: async ({ initialValues }) => initialValues ?? [],
      text,
      confirm: async ({ initialValue }) => initialValue ?? false,
      progress: () => ({ stop() {}, update() {} }),
    };

    const result = await promptDefaultModel({
      config,
      prompter,
      agentId: "ops",
      agentDir: "/tmp/ops-agent",
      workspaceDir: "/tmp/ops-workspace",
      loadCatalog: false,
    });

    expect(result).toEqual(choice === "__keep__" ? {} : { model: expected });
    expect(text).toHaveBeenCalledTimes(choice === "__manual__" ? 1 : 0);
    expect(config).toEqual(before);
  });
});
