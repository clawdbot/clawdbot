import { describe, expect, it } from "vitest";

import type { MoltbotConfig } from "../config/config.js";
import {
  applyOpenAICodexModelDefault,
  OPENAI_CODEX_DEFAULT_MODEL,
} from "./openai-codex-model-default.js";

describe("applyOpenAICodexModelDefault", () => {
  it("sets openai-codex default when model is unset", () => {
    const cfg: MoltbotConfig = { agents: { defaults: {} } };
    const applied = applyOpenAICodexModelDefault(cfg);
    expect(applied.changed).toBe(true);
    expect(applied.next.agents?.defaults?.model).toEqual({
      primary: OPENAI_CODEX_DEFAULT_MODEL,
    });
  });

  it("sets openai-codex default when model is openai/*", () => {
    const cfg: MoltbotConfig = {
      agents: { defaults: { model: "openai/gpt-5.2" } },
    };
    const applied = applyOpenAICodexModelDefault(cfg);
    expect(applied.changed).toBe(true);
    expect(applied.next.agents?.defaults?.model).toEqual({
      primary: OPENAI_CODEX_DEFAULT_MODEL,
    });
  });

  it("does not override openai-codex/*", () => {
    const cfg: MoltbotConfig = {
      agents: { defaults: { model: "openai-codex/gpt-5.2" } },
    };
    const applied = applyOpenAICodexModelDefault(cfg);
    expect(applied.changed).toBe(false);
    expect(applied.next).toEqual(cfg);
  });

  it("does not override non-openai models", () => {
    const cfg: MoltbotConfig = {
      agents: { defaults: { model: "anthropic/claude-opus-4-5" } },
    };
    const applied = applyOpenAICodexModelDefault(cfg);
    expect(applied.changed).toBe(false);
    expect(applied.next).toEqual(cfg);
  });
});
