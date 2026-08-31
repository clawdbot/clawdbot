// Model picker tests read the configured target agent without rewriting global defaults.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { WizardPrompter } from "../wizard/prompts.js";

vi.mock("./model-picker.runtime.js", () => ({
  modelPickerRuntime: { resolvePluginProviders: () => [] },
}));

import { promptDefaultModel } from "./model-picker.js";

describe("promptDefaultModel default-agent ownership", () => {
  it("offers the resolved agent override as the current model", async () => {
    const config = {
      agents: {
        defaults: { model: "openai/global-model" },
        entries: {
          ops: {
            default: true,
            model: "anthropic/ops-model",
          },
        },
      },
    } satisfies OpenClawConfig;
    const select = vi.fn(async (params: { options: Array<{ value: string; label: string }> }) => {
      const keep = params.options[0];
      expect(keep?.label).toContain("anthropic/ops-model");
      return keep?.value;
    });
    const prompter = {
      select,
      progress: vi.fn(() => ({ stop: vi.fn(), update: vi.fn() })),
    } as unknown as WizardPrompter;

    await expect(
      promptDefaultModel({
        config,
        prompter,
        agentId: "ops",
        agentDir: "/tmp/ops-agent",
        workspaceDir: "/tmp/ops-workspace",
        loadCatalog: false,
      }),
    ).resolves.toEqual({});
    expect(select).toHaveBeenCalledOnce();
  });
});
