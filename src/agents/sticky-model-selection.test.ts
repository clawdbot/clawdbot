import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  cfg: {} as OpenClawConfig,
  info: vi.fn(),
  isNixMode: false,
  mutateConfigFileWithRetry: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  mutateConfigFileWithRetry: mocks.mutateConfigFileWithRetry,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: mocks.info, warn: mocks.warn }),
}));

vi.mock("../config/paths.js", () => ({
  resolveIsNixMode: () => mocks.isNixMode,
}));

import { persistStickyModelSelectionBestEffort } from "./sticky-model-selection.js";

beforeEach(() => {
  mocks.info.mockReset();
  mocks.warn.mockReset();
  mocks.isNixMode = false;
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

    persistStickyModelSelectionBestEffort({ agentId, model: " openai/gpt-5.6-sol " });
    await vi.waitFor(() =>
      expect(mocks.info).toHaveBeenCalledWith(
        `persisted sticky model selection agentId=${agentId} model=openai/gpt-5.6-sol target=${target}`,
      ),
    );

    const persistedPrimary =
      target === "defaults"
        ? mocks.cfg.agents?.defaults?.model
        : mocks.cfg.agents?.list?.find((entry) => entry.id === agentId)?.model;
    expect(persistedPrimary).toMatchObject({
      primary: "openai/gpt-5.6-sol",
      fallbacks: ["openai/gpt-5.6-luna"],
    });
  });

  it("rejects an empty model before starting a config mutation", async () => {
    persistStickyModelSelectionBestEffort({ agentId: "main", model: "   " });

    await vi.waitFor(() =>
      expect(mocks.warn).toHaveBeenCalledWith(
        "failed sticky model persistence agentId=main model=    reason=Sticky model selection must be non-empty.",
      ),
    );
    expect(mocks.mutateConfigFileWithRetry).not.toHaveBeenCalled();
  });

  it("warns and absorbs asynchronous config write failures", async () => {
    mocks.mutateConfigFileWithRetry.mockRejectedValueOnce(new Error("config is read-only"));

    expect(
      persistStickyModelSelectionBestEffort({ agentId: "main", model: "openai/gpt-5.6-sol" }),
    ).toBeUndefined();

    await vi.waitFor(() =>
      expect(mocks.warn).toHaveBeenCalledWith(
        "failed sticky model persistence agentId=main model=openai/gpt-5.6-sol reason=config is read-only",
      ),
    );
  });

  it("skips immutable Nix config and warns only once per process", () => {
    mocks.isNixMode = true;

    persistStickyModelSelectionBestEffort({ agentId: "main", model: "openai/gpt-5.6-sol" });
    persistStickyModelSelectionBestEffort({ agentId: "work", model: "openai/gpt-5.6-luna" });

    expect(mocks.mutateConfigFileWithRetry).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledOnce();
    expect(mocks.warn).toHaveBeenCalledWith(
      "skipped sticky model persistence agentId=main model=openai/gpt-5.6-sol reason=config is immutable in OPENCLAW_NIX_MODE",
    );
  });
});
