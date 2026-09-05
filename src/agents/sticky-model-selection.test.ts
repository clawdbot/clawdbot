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

import {
  persistStickyModelSelectionBestEffort,
  resolveStickyModelSelectionPolicy,
} from "./sticky-model-selection.js";

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

describe("resolveStickyModelSelectionPolicy", () => {
  const cfg = {
    agents: {
      defaults: { model: "anthropic/claude-opus-4-6" },
      list: [
        { id: "main", default: true },
        { id: "work", model: "anthropic/claude-sonnet-4-6" },
        { id: "inheriting" },
      ],
    },
  } satisfies OpenClawConfig;

  it.each([
    { scope: undefined, agentId: "main", target: "global" },
    { scope: undefined, agentId: "work", target: "agent" },
    { scope: undefined, agentId: "inheriting", target: "global" },
    { scope: "session", agentId: "main", target: "session" },
    { scope: "session", agentId: "work", target: "session" },
    { scope: "agent", agentId: "main", target: "agent" },
    { scope: "agent", agentId: "work", target: "agent" },
    { scope: "global", agentId: "main", target: "global" },
    { scope: "global", agentId: "work", target: "global" },
  ] as const)("resolves scope=$scope for $agentId to $target", ({ scope, agentId, target }) => {
    expect(
      resolveStickyModelSelectionPolicy({
        agentId,
        canPersistConfig: true,
        cfg,
        ...(scope ? { scope } : {}),
      }),
    ).toEqual({ scope: scope ?? "effective", target });
  });

  it.each([undefined, "session", "agent", "global"] as const)(
    "discloses session-only selection without config-write authority for scope=%s",
    (scope) => {
      expect(
        resolveStickyModelSelectionPolicy({
          agentId: "work",
          canPersistConfig: false,
          cfg,
          ...(scope ? { scope } : {}),
        }).target,
      ).toBe("session");
    },
  );
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
        },
      } satisfies OpenClawConfig,
      target: "defaults" as const,
      requestedTarget: undefined,
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
      requestedTarget: undefined,
    },
    {
      name: "agent entry when agent scope is explicit",
      agentId: "main",
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: ["openai/gpt-5.6-luna"],
            },
          },
          entries: { main: {} },
        },
      } satisfies OpenClawConfig,
      target: "agent" as const,
      requestedTarget: "agent" as const,
    },
    {
      name: "shared default when global scope is explicit",
      agentId: "work",
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: ["openai/gpt-5.6-luna"],
            },
          },
          list: [
            {
              id: "work",
              model: {
                primary: "anthropic/claude-sonnet-4-6",
                fallbacks: ["google/gemini-3-pro"],
              },
            },
          ],
        },
      } satisfies OpenClawConfig,
      target: "defaults" as const,
      requestedTarget: "defaults" as const,
    },
  ])("writes the $name", async ({ agentId, cfg, target, requestedTarget }) => {
    mocks.cfg = structuredClone(cfg);

    expect(
      persistStickyModelSelectionBestEffort({
        agentId,
        model: " openai/gpt-5.6-sol ",
        ...(requestedTarget ? { target: requestedTarget } : {}),
      }),
    ).toBe("requested");
    await vi.waitFor(() =>
      expect(mocks.info).toHaveBeenCalledWith(
        `persisted sticky model selection agentId=${agentId} model=openai/gpt-5.6-sol target=${target}`,
      ),
    );

    const persistedPrimary =
      target === "defaults"
        ? mocks.cfg.agents?.defaults?.model
        : (mocks.cfg.agents?.entries?.[agentId]?.model ??
          mocks.cfg.agents?.list?.find((entry) => entry.id === agentId)?.model);
    if (requestedTarget === "agent" && agentId === "main") {
      expect(persistedPrimary).toBe("openai/gpt-5.6-sol");
      return;
    }
    expect(persistedPrimary).toMatchObject({
      primary: "openai/gpt-5.6-sol",
      fallbacks: ["openai/gpt-5.6-luna"],
    });
  });

  it("rejects an empty model before starting a config mutation", async () => {
    expect(persistStickyModelSelectionBestEffort({ agentId: "main", model: "   " })).toBe(
      "requested",
    );

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
    ).toBe("requested");

    await vi.waitFor(() =>
      expect(mocks.warn).toHaveBeenCalledWith(
        "failed sticky model persistence agentId=main model=openai/gpt-5.6-sol reason=config is read-only",
      ),
    );
  });

  it("skips immutable Nix config and warns only once per process", () => {
    mocks.isNixMode = true;

    expect(
      persistStickyModelSelectionBestEffort({
        agentId: "main",
        model: "openai/gpt-5.6-sol",
      }),
    ).toBe("skipped-immutable");
    expect(
      persistStickyModelSelectionBestEffort({
        agentId: "work",
        model: "openai/gpt-5.6-luna",
      }),
    ).toBe("skipped-immutable");

    expect(mocks.mutateConfigFileWithRetry).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledOnce();
    expect(mocks.warn).toHaveBeenCalledWith(
      "skipped sticky model persistence agentId=main model=openai/gpt-5.6-sol reason=config is immutable in OPENCLAW_NIX_MODE",
    );
  });
});
