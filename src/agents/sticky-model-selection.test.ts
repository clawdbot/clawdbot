import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  cfg: {} as OpenClawConfig,
  info: vi.fn(),
  mutateConfigFileWithRetry: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  mutateConfigFileWithRetry: mocks.mutateConfigFileWithRetry,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: mocks.info }),
}));

import { persistStickyModelSelection } from "./sticky-model-selection.js";

beforeEach(() => {
  mocks.info.mockReset();
  mocks.mutateConfigFileWithRetry.mockReset().mockImplementation(async ({ mutate }) => {
    const draft = structuredClone(mocks.cfg);
    const result = await mutate(draft, {});
    mocks.cfg = draft;
    return { nextConfig: draft, result };
  });
});

describe("persistStickyModelSelection", () => {
  it.each([
    {
      name: "shared default for an inheriting agent",
      agentId: "main",
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: ["openai/gpt-5.6-luna"],
            },
          },
          list: [{ id: "main", default: true }],
        },
      } satisfies OpenClawConfig,
      target: "defaults" as const,
    },
    {
      name: "agent entry for an explicit agent model",
      agentId: "work",
      cfg: {
        agents: {
          defaults: { model: "anthropic/claude-opus-4-6" },
          list: [
            { id: "main", default: true },
            {
              id: "work",
              model: {
                primary: "anthropic/claude-sonnet-4-6",
                fallbacks: ["openai/gpt-5.6-luna"],
              },
            },
          ],
        },
      } satisfies OpenClawConfig,
      target: "agent" as const,
    },
  ])("writes the $name", async ({ agentId, cfg, target }) => {
    mocks.cfg = structuredClone(cfg);

    await expect(
      persistStickyModelSelection({ agentId, model: " openai/gpt-5.6-sol " }),
    ).resolves.toBe(target);

    const persistedPrimary =
      target === "defaults"
        ? mocks.cfg.agents?.defaults?.model
        : mocks.cfg.agents?.list?.find((entry) => entry.id === agentId)?.model;
    expect(persistedPrimary).toMatchObject({
      primary: "openai/gpt-5.6-sol",
      fallbacks: ["openai/gpt-5.6-luna"],
    });
    expect(mocks.info).toHaveBeenCalledWith(
      `persisted sticky model selection agentId=${agentId} model=openai/gpt-5.6-sol target=${target}`,
    );
  });

  it("rejects an empty model before starting a config mutation", async () => {
    await expect(persistStickyModelSelection({ agentId: "main", model: "   " })).rejects.toThrow(
      "Sticky model selection must be non-empty.",
    );
    expect(mocks.mutateConfigFileWithRetry).not.toHaveBeenCalled();
  });
});
