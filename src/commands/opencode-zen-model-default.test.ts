import { describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "../config/config.js";
import {
  applyOpencodeZenModelDefault,
  OPENCODE_ZEN_DEFAULT_MODEL,
} from "./opencode-zen-model-default.js";

describe("applyOpencodeZenModelDefault", () => {
  it("sets opencode default when model is unset", () => {
    const cfg: ClawdbotConfig = { agents: { defaults: {} } };
    const applied = applyOpencodeZenModelDefault(cfg);
    expect(applied.changed).toBe(true);
    expect(applied.next.agents?.defaults?.model).toEqual({
      primary: OPENCODE_ZEN_DEFAULT_MODEL,
    });
  });

  it("overrides existing model", () => {
    const cfg = {
      agents: { defaults: { model: "anthropic/claude-opus-4-5" } },
    } as ClawdbotConfig;
    const applied = applyOpencodeZenModelDefault(cfg);
    expect(applied.changed).toBe(true);
    expect(applied.next.agents?.defaults?.model).toEqual({
      primary: OPENCODE_ZEN_DEFAULT_MODEL,
    });
  });

  it("no-ops when already opencode-zen default", () => {
    const cfg = {
      agents: { defaults: { model: OPENCODE_ZEN_DEFAULT_MODEL } },
    } as ClawdbotConfig;
    const applied = applyOpencodeZenModelDefault(cfg);
    expect(applied.changed).toBe(false);
    expect(applied.next).toEqual(cfg);
  });

  it("no-ops when already legacy opencode-zen default", () => {
    const cfg = {
      agents: { defaults: { model: "opencode-zen/claude-opus-4-5" } },
    } as ClawdbotConfig;
    const applied = applyOpencodeZenModelDefault(cfg);
    expect(applied.changed).toBe(false);
    expect(applied.next).toEqual(cfg);
  });

  it("preserves fallbacks when setting primary", () => {
    const cfg: ClawdbotConfig = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-5",
            fallbacks: ["google/gemini-3-pro"],
          },
        },
      },
    };
    const applied = applyOpencodeZenModelDefault(cfg);
    expect(applied.changed).toBe(true);
    expect(applied.next.agents?.defaults?.model).toEqual({
      primary: OPENCODE_ZEN_DEFAULT_MODEL,
      fallbacks: ["google/gemini-3-pro"],
    });
  });
});
