// Verifies fast-mode precedence across session, agent, and model defaults.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { formatFastModeAutoLabel } from "../shared/fast-mode.js";
import {
  formatFastModeAutoProgressText,
  formatFastModeCommandOptions,
  formatFastModeCurrentStatus,
  formatFastModeStatusValue,
  resolveFastModeForElapsed,
  resolveFastModeState,
} from "./fast-mode.js";

describe("resolveFastModeState", () => {
  it("prefers session overrides", () => {
    const state = resolveFastModeState({
      cfg: {} as OpenClawConfig,
      provider: "openai",
      model: "gpt-4o",
      sessionEntry: { fastMode: true },
    });

    expect(state.enabled).toBe(true);
    expect(state.mode).toBe(true);
    expect(state.source).toBe("session");
  });

  it("keeps auto as the persisted mode and starts enabled", () => {
    const state = resolveFastModeState({
      cfg: {} as OpenClawConfig,
      provider: "openai",
      model: "gpt-5.5",
      sessionEntry: { fastMode: "auto" },
    });

    expect(state.mode).toBe("auto");
    expect(state.enabled).toBe(true);
  });

  it("uses agent fastModeDefault when present", () => {
    const cfg = {
      agents: {
        list: [{ id: "alpha", fastModeDefault: true }],
      },
    } as OpenClawConfig;

    const state = resolveFastModeState({
      cfg,
      provider: "openai",
      model: "gpt-4o",
      agentId: "alpha",
    });

    expect(state.enabled).toBe(true);
    expect(state.source).toBe("agent");
  });

  it("falls back to model config when agent default is absent", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-4o": { params: { fastMode: true } },
          },
        },
      },
    } as OpenClawConfig;

    const state = resolveFastModeState({
      cfg,
      provider: "openai",
      model: "gpt-4o",
    });

    expect(state.enabled).toBe(true);
    expect(state.source).toBe("config");
  });

  it("uses OpenAI model config for the Codex app-server runtime provider", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { params: { fastMode: "auto", fastAutoOnSeconds: 30 } },
          },
        },
      },
    } as OpenClawConfig;

    const state = resolveFastModeState({
      cfg,
      provider: "openai-codex",
      model: "gpt-5.5",
    });

    expect(state.mode).toBe("auto");
    expect(state.enabled).toBe(true);
    expect(state.source).toBe("config");
    expect(state.fastAutoOnSeconds).toBe(30);
  });

  it("prefers exact Codex app-server model config over the OpenAI alias", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { params: { fastMode: true, fastAutoOnSeconds: 30 } },
            "openai-codex/gpt-5.5": { params: { fastMode: false, fastAutoOnSeconds: 45 } },
          },
        },
      },
    } as OpenClawConfig;

    const state = resolveFastModeState({
      cfg,
      provider: "openai-codex",
      model: "gpt-5.5",
    });

    expect(state.enabled).toBe(false);
    expect(state.mode).toBe(false);
    expect(state.source).toBe("config");
    expect(state.fastAutoOnSeconds).toBe(45);
  });

  it("formats auto mode with the default threshold", () => {
    expect(formatFastModeAutoLabel()).toBe("auto (60 sec)");
    expect(formatFastModeStatusValue({ mode: "auto" })).toBe("auto (60 sec)");
    expect(formatFastModeAutoLabel({ fastAutoOnSeconds: 30 })).toBe("auto (30 sec)");
    expect(formatFastModeStatusValue({ mode: "auto", fastAutoOnSeconds: 30 })).toBe(
      "auto (30 sec)",
    );
    expect(formatFastModeStatusValue({ mode: true })).toBe("on");
    expect(formatFastModeCommandOptions({ fastAutoOnSeconds: 30 })).toBe(
      "on, off, auto (30 sec), default, status",
    );
    expect(
      formatFastModeCurrentStatus({
        mode: "auto",
        source: "config",
        fastAutoOnSeconds: 30,
      }),
    ).toBe("Current fast mode: auto (30 sec) (default: model).");
  });

  it("uses model fastAutoOnSeconds for auto cutoff across session overrides", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { params: { fastMode: "auto", fastAutoOnSeconds: 30 } },
          },
        },
      },
    } as OpenClawConfig;

    const state = resolveFastModeState({
      cfg,
      provider: "openai",
      model: "gpt-5.5",
      sessionEntry: { fastMode: "auto" },
    });

    expect(state.mode).toBe("auto");
    expect(state.source).toBe("session");
    expect(state.fastAutoOnSeconds).toBe(30);
  });

  it.each([
    ["fastSeconds", { fastSeconds: 15 }],
    ["fast_seconds", { fast_seconds: 15 }],
  ])("uses model %s alias for auto cutoff", (_label, params) => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { params: { fastMode: "auto", ...params } },
          },
        },
      },
    } as OpenClawConfig;

    const state = resolveFastModeState({
      cfg,
      provider: "openai",
      model: "gpt-5.5",
    });

    expect(state.mode).toBe("auto");
    expect(state.source).toBe("config");
    expect(state.fastAutoOnSeconds).toBe(15);
  });

  it("uses model config when the runtime passes a provider-qualified model ref", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { params: { fastMode: true } },
          },
        },
      },
    } as OpenClawConfig;

    const state = resolveFastModeState({
      cfg,
      provider: "openai",
      model: "openai/gpt-5.5",
    });

    expect(state.enabled).toBe(true);
    expect(state.source).toBe("config");
  });

  it("uses canonical provider/model config for slash-containing model ids", () => {
    // OpenRouter-style models can contain slashes, so matching must build the
    // canonical provider/model key instead of splitting on the first slash.
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openrouter/anthropic/claude-sonnet-4-6": { params: { fastMode: true } },
          },
        },
      },
    } as OpenClawConfig;

    const state = resolveFastModeState({
      cfg,
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4-6",
    });

    expect(state.enabled).toBe(true);
    expect(state.source).toBe("config");
  });

  it("does not use another provider's slash-containing model config", () => {
    // Provider qualification prevents a model-id substring from borrowing
    // another provider's fast-mode setting.
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": { params: { fastMode: true } },
          },
        },
      },
    } as OpenClawConfig;

    const state = resolveFastModeState({
      cfg,
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4-6",
    });

    expect(state.enabled).toBe(false);
    expect(state.source).toBe("default");
  });

  it("defaults to off when unset", () => {
    const state = resolveFastModeState({
      cfg: {} as OpenClawConfig,
      provider: "openai",
      model: "gpt-4o",
    });

    expect(state.enabled).toBe(false);
    expect(state.source).toBe("default");
  });
});

describe("resolveFastModeForElapsed", () => {
  it("keeps auto on through the exact threshold", () => {
    expect(
      resolveFastModeForElapsed({
        mode: "auto",
        startedAtMs: 1_000,
        nowMs: 61_000,
      }),
    ).toMatchObject({
      mode: "auto",
      enabled: true,
      elapsedSeconds: 60,
    });
  });

  it("turns auto off after the threshold", () => {
    expect(
      resolveFastModeForElapsed({
        mode: "auto",
        startedAtMs: 1_000,
        nowMs: 76_000,
      }),
    ).toMatchObject({
      mode: "auto",
      enabled: false,
      elapsedSeconds: 75,
    });
  });

  it("uses configured auto seconds as the elapsed threshold", () => {
    expect(
      resolveFastModeForElapsed({
        mode: "auto",
        fastAutoOnSeconds: 30,
        startedAtMs: 1_000,
        nowMs: 31_000,
      }),
    ).toMatchObject({
      mode: "auto",
      enabled: true,
      elapsedSeconds: 30,
      fastAutoOnSeconds: 30,
    });
    expect(
      resolveFastModeForElapsed({
        mode: "auto",
        fastAutoOnSeconds: 30,
        startedAtMs: 1_000,
        nowMs: 31_001,
      }),
    ).toMatchObject({
      mode: "auto",
      enabled: false,
      elapsedSeconds: 30,
      fastAutoOnSeconds: 30,
    });
  });

  it("does not round elapsed auto-off seconds upward", () => {
    expect(
      resolveFastModeForElapsed({
        mode: "auto",
        startedAtMs: 1_000,
        nowMs: 61_001,
      }),
    ).toMatchObject({
      mode: "auto",
      enabled: false,
      elapsedSeconds: 60,
    });
  });

  it("formats auto transition progress", () => {
    expect(
      formatFastModeAutoProgressText({
        enabled: false,
        elapsedSeconds: 75,
        fastAutoOnSeconds: 30,
      }),
    ).toBe("💨Fast: auto-off(75s>=30s)");
    expect(
      formatFastModeAutoProgressText({
        enabled: true,
        elapsedSeconds: 0,
      }),
    ).toBe("💨Fast: auto-on");
  });
});
