import { describe, expect, it } from "vitest";
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectImplicitFallbackClobberWarnings,
  formatConfigPath,
  resolveConfigPathTarget,
  stripUnknownConfigKeys,
} from "./doctor-config-analysis.js";

describe("doctor config analysis helpers", () => {
  it("formats config paths predictably", () => {
    expect(formatConfigPath([])).toBe("<root>");
    expect(formatConfigPath(["channels", "slack", "accounts", 0, "token"])).toBe(
      "channels.slack.accounts[0].token",
    );
  });

  it("resolves nested config targets without throwing", () => {
    const target = resolveConfigPathTarget(
      { channels: { slack: { accounts: [{ token: "x" }] } } },
      ["channels", "slack", "accounts", 0],
    );
    expect(target).toEqual({ token: "x" });
    expect(resolveConfigPathTarget({ channels: null }, ["channels", "slack"])).toBeNull();
  });

  it("strips unknown config keys while keeping known values", () => {
    const result = stripUnknownConfigKeys({
      hooks: {},
      unexpected: true,
    } as never);
    expect(result.removed).toContain("unexpected");
    expect((result.config as Record<string, unknown>).unexpected).toBeUndefined();
    expect((result.config as Record<string, unknown>).hooks).toStrictEqual({});
  });
});

describe("collectImplicitFallbackClobberWarnings", () => {
  function buildConfig(overrides: { defaults?: unknown; list?: unknown[] }): OpenClawConfig {
    return {
      agents: {
        defaults: { model: overrides.defaults },
        list: overrides.list,
      },
    } as unknown as OpenClawConfig;
  }

  it("returns empty when defaults has no fallbacks", () => {
    const cfg = buildConfig({
      defaults: { primary: "openai/gpt-5.5" },
      list: [{ id: "ops", model: "openai/gpt-5.3" }],
    });
    expect(collectImplicitFallbackClobberWarnings(cfg)).toEqual([]);
  });

  it("returns empty when defaults fallbacks is an empty array", () => {
    const cfg = buildConfig({
      defaults: { primary: "openai/gpt-5.5", fallbacks: [] },
      list: [{ id: "ops", model: "openai/gpt-5.3" }],
    });
    expect(collectImplicitFallbackClobberWarnings(cfg)).toEqual([]);
  });

  it("returns empty when all agents use fallbacks: [] explicitly", () => {
    const cfg = buildConfig({
      defaults: { primary: "openai/gpt-5.5", fallbacks: ["openai/gpt-5.4"] },
      list: [
        { id: "ops", model: { primary: "openai/gpt-5.3", fallbacks: [] } },
        { id: "researcher", model: { primary: "openai/gpt-5.4", fallbacks: [] } },
      ],
    });
    expect(collectImplicitFallbackClobberWarnings(cfg)).toEqual([]);
  });

  it('returns empty when all agents use fallbacks: ["x"] explicitly', () => {
    const cfg = buildConfig({
      defaults: { primary: "openai/gpt-5.5", fallbacks: ["openai/gpt-5.4"] },
      list: [
        { id: "ops", model: { primary: "openai/gpt-5.3", fallbacks: ["openai/gpt-5.2"] } },
        { id: "researcher", model: { primary: "openai/gpt-5.4", fallbacks: ["openai/gpt-5.2"] } },
      ],
    });
    expect(collectImplicitFallbackClobberWarnings(cfg)).toEqual([]);
  });

  it("returns empty when no per-agent model is configured", () => {
    const cfg = buildConfig({
      defaults: { primary: "openai/gpt-5.5", fallbacks: ["openai/gpt-5.4"] },
      list: [{ id: "ops" }, { id: "researcher" }],
    });
    expect(collectImplicitFallbackClobberWarnings(cfg)).toEqual([]);
  });

  it("returns empty when agents.list is malformed", () => {
    const cfg = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.5", fallbacks: ["openai/gpt-5.4"] } },
        list: { ops: { id: "ops", model: "openai/gpt-5.3" } },
      },
    } as unknown as OpenClawConfig;

    expect(collectImplicitFallbackClobberWarnings(cfg)).toEqual([]);
  });

  it("warns for string-form model when defaults fallbacks is non-empty", () => {
    const cfg = buildConfig({
      defaults: { primary: "openai/gpt-5.5", fallbacks: ["openai/gpt-5.4", "openai/gpt-5.3"] },
      list: [{ id: "ops", model: "openai/gpt-5.3" }],
    });
    const warnings = collectImplicitFallbackClobberWarnings(cfg);
    expect(warnings).toStrictEqual([
      [
        '- agents.list[0].model (id=ops) is "openai/gpt-5.3", a bare string with no fallbacks. At runtime this clobbers agents.defaults.model.fallbacks (openai/gpt-5.4, openai/gpt-5.3), leaving the agent with no fallbacks.',
        '  Fix: add "fallbacks": [...] to inherit or override, or "fallbacks": [] to explicitly disable.',
      ].join("\n"),
    ]);
  });

  it("matches runtime fallback resolution for warned string and partial-object shapes", () => {
    expect(
      resolveAgentModelFallbackValues({
        primary: "openai/gpt-5.5",
        fallbacks: ["openai/gpt-5.4"],
      }),
    ).toEqual(["openai/gpt-5.4"]);
    expect(resolveAgentModelFallbackValues("openai/gpt-5.3" as never)).toEqual([]);
    expect(resolveAgentModelFallbackValues({ primary: "openai/gpt-5.3" })).toEqual([]);
  });

  it("does not warn for blank string-form model", () => {
    const cfg = buildConfig({
      defaults: { primary: "openai/gpt-5.5", fallbacks: ["openai/gpt-5.4"] },
      list: [
        { id: "blank", model: "" },
        { id: "whitespace", model: "   " },
      ],
    });
    expect(collectImplicitFallbackClobberWarnings(cfg)).toEqual([]);
  });

  it('warns for object form { primary: "X" } with no fallbacks key', () => {
    const cfg = buildConfig({
      defaults: { primary: "openai/gpt-5.5", fallbacks: ["openai/gpt-5.4"] },
      list: [{ id: "researcher", model: { primary: "openai/gpt-5.4" } }],
    });
    const warnings = collectImplicitFallbackClobberWarnings(cfg);
    expect(warnings).toStrictEqual([
      [
        '- agents.list[0].model (id=researcher) is { primary: "openai/gpt-5.4" }, a object with no explicit "fallbacks" key. At runtime this clobbers agents.defaults.model.fallbacks (openai/gpt-5.4), leaving the agent with no fallbacks.',
        '  Fix: add "fallbacks": [...] to inherit or override, or "fallbacks": [] to explicitly disable.',
      ].join("\n"),
    ]);
  });

  it("does not warn for object form with blank primary", () => {
    const cfg = buildConfig({
      defaults: { primary: "openai/gpt-5.5", fallbacks: ["openai/gpt-5.4"] },
      list: [
        { id: "blank", model: { primary: "" } },
        { id: "whitespace", model: { primary: "   " } },
      ],
    });
    expect(collectImplicitFallbackClobberWarnings(cfg)).toEqual([]);
  });

  it("does not warn for object form with non-string primary", () => {
    const cfg = buildConfig({
      defaults: { primary: "openai/gpt-5.5", fallbacks: ["openai/gpt-5.4"] },
      list: [{ id: "bad", model: { primary: 123 } }],
    });
    expect(collectImplicitFallbackClobberWarnings(cfg)).toEqual([]);
  });

  it("does not warn for { primary, fallbacks: [] } (explicit empty)", () => {
    const cfg = buildConfig({
      defaults: { primary: "openai/gpt-5.5", fallbacks: ["openai/gpt-5.4"] },
      list: [{ id: "secondary", model: { primary: "openai/gpt-5.5", fallbacks: [] } }],
    });
    expect(collectImplicitFallbackClobberWarnings(cfg)).toEqual([]);
  });

  it('does not warn for { primary, fallbacks: ["y"] } (explicit list)', () => {
    const cfg = buildConfig({
      defaults: { primary: "openai/gpt-5.5", fallbacks: ["openai/gpt-5.4"] },
      list: [
        {
          id: "primary",
          model: { primary: "openai/gpt-5.5", fallbacks: ["openai/gpt-5.3"] },
        },
      ],
    });
    expect(collectImplicitFallbackClobberWarnings(cfg)).toEqual([]);
  });

  it("does not warn when an explicit fallbacks key has an invalid shape", () => {
    const cfg = buildConfig({
      defaults: { primary: "openai/gpt-5.5", fallbacks: ["openai/gpt-5.4"] },
      list: [
        { id: "nullish", model: { primary: "openai/gpt-5.5", fallbacks: null } },
        { id: "string", model: { primary: "openai/gpt-5.4", fallbacks: "openai/gpt-5.3" } },
      ],
    });
    expect(collectImplicitFallbackClobberWarnings(cfg)).toEqual([]);
  });

  it("warns for each offending agent independently", () => {
    const cfg = buildConfig({
      defaults: { primary: "openai/gpt-5.5", fallbacks: ["openai/gpt-5.4"] },
      list: [
        { id: "ops", model: "openai/gpt-5.3" },
        { id: "researcher", model: { primary: "openai/gpt-5.4" } },
      ],
    });
    const warnings = collectImplicitFallbackClobberWarnings(cfg);
    expect(warnings).toStrictEqual([
      [
        '- agents.list[0].model (id=ops) is "openai/gpt-5.3", a bare string with no fallbacks. At runtime this clobbers agents.defaults.model.fallbacks (openai/gpt-5.4), leaving the agent with no fallbacks.',
        '  Fix: add "fallbacks": [...] to inherit or override, or "fallbacks": [] to explicitly disable.',
      ].join("\n"),
      [
        '- agents.list[1].model (id=researcher) is { primary: "openai/gpt-5.4" }, a object with no explicit "fallbacks" key. At runtime this clobbers agents.defaults.model.fallbacks (openai/gpt-5.4), leaving the agent with no fallbacks.',
        '  Fix: add "fallbacks": [...] to inherit or override, or "fallbacks": [] to explicitly disable.',
      ].join("\n"),
    ]);
  });
});
