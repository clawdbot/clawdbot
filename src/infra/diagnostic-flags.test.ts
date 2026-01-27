import { describe, expect, it } from "vitest";

import type { MoltbotConfig } from "../config/config.js";
import { isDiagnosticFlagEnabled, resolveDiagnosticFlags } from "./diagnostic-flags.js";

describe("diagnostic flags", () => {
  it("merges config + env flags", () => {
    const cfg = {
      diagnostics: { flags: ["telegram.http", "cache.*"] },
    } as MoltbotConfig;
    const env = {
      CLAWDBOT_DIAGNOSTICS: "foo,bar",
    } as NodeJS.ProcessEnv;

    const flags = resolveDiagnosticFlags(cfg, env);
    expect(flags).toEqual(expect.arrayContaining(["telegram.http", "cache.*", "foo", "bar"]));
    expect(isDiagnosticFlagEnabled("telegram.http", cfg, env)).toBe(true);
    expect(isDiagnosticFlagEnabled("cache.hit", cfg, env)).toBe(true);
    expect(isDiagnosticFlagEnabled("foo", cfg, env)).toBe(true);
  });

  it("treats env true as wildcard", () => {
    const env = { CLAWDBOT_DIAGNOSTICS: "1" } as NodeJS.ProcessEnv;
    expect(isDiagnosticFlagEnabled("anything.here", undefined, env)).toBe(true);
  });

  it("treats env false as disabled", () => {
    const env = { CLAWDBOT_DIAGNOSTICS: "0" } as NodeJS.ProcessEnv;
    expect(isDiagnosticFlagEnabled("telegram.http", undefined, env)).toBe(false);
  });
});
