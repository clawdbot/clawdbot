// Openshell tests cover backend plugin behavior.
import { afterEach, describe, expect, it } from "vitest";
import { buildOpenShellSandboxName, buildOpenShellSshExecEnv } from "./backend.js";

describe("openshell backend env", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it("filters blocked secrets from ssh exec env", () => {
    process.env.OPENAI_API_KEY = "sk-test-secret";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-secret";
    process.env.LANG = "en_US.UTF-8";
    process.env.NODE_ENV = "test";

    const env = buildOpenShellSshExecEnv();

    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.NODE_ENV).toBe("test");
  });
});

describe("openshell sandbox names", () => {
  it("generates deterministic OpenShell-compatible names from session scope keys", () => {
    const scopeKey = "agent:somalley_alice:dashboard-8";
    const name = buildOpenShellSandboxName(scopeKey);

    expect(name).toMatch(/^oc-[a-f0-9]{16}$/u);
    expect(name).toHaveLength(19);
    expect(buildOpenShellSandboxName(scopeKey)).toBe(name);
    expect(buildOpenShellSandboxName("agent:other")).not.toBe(name);
    expect(buildOpenShellSandboxName("   ")).toBe(buildOpenShellSandboxName("session"));
  });
});
