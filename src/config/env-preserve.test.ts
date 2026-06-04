// Covers preserved environment-variable config normalization.
import { describe, it, expect } from "vitest";
import { restoreEnvVarRefs } from "./env-preserve.js";

describe("restoreEnvVarRefs", () => {
  const env = {
    ANTHROPIC_API_KEY: "sk-ant-api03-real-key",
    OPENAI_API_KEY: "sk-openai-real-key",
    MY_TOKEN: "tok-12345",
  } as unknown as NodeJS.ProcessEnv;

  it("restores a simple ${VAR} reference when value matches", () => {
    const incoming = { apiKey: "sk-ant-api03-real-key" };
    const parsed = { apiKey: "${ANTHROPIC_API_KEY}" };
    const result = restoreEnvVarRefs(incoming, parsed, env);
    expect(result).toEqual({ apiKey: "${ANTHROPIC_API_KEY}" });
  });

  it("keeps new value when caller intentionally changed it", () => {
    const incoming = { apiKey: "sk-ant-new-different-key" };
    const parsed = { apiKey: "${ANTHROPIC_API_KEY}" };
    const result = restoreEnvVarRefs(incoming, parsed, env);
    expect(result).toEqual({ apiKey: "sk-ant-new-different-key" });
  });

  it("handles nested objects", () => {
    const incoming = {
      models: {
        providers: {
          anthropic: { apiKey: "sk-ant-api03-real-key" },
          openai: { apiKey: "sk-openai-real-key" },
        },
      },
    };
    const parsed = {
      models: {
        providers: {
          anthropic: { apiKey: "${ANTHROPIC_API_KEY}" },
          openai: { apiKey: "${OPENAI_API_KEY}" },
        },
      },
    };
    const result = restoreEnvVarRefs(incoming, parsed, env);
    expect(result).toEqual({
      models: {
        providers: {
          anthropic: { apiKey: "${ANTHROPIC_API_KEY}" },
          openai: { apiKey: "${OPENAI_API_KEY}" },
        },
      },
    });
  });

  it("preserves new keys not in parsed", () => {
    const incoming = { apiKey: "sk-ant-api03-real-key", newField: "hello" };
    const parsed = { apiKey: "${ANTHROPIC_API_KEY}" };
    const result = restoreEnvVarRefs(incoming, parsed, env);
    expect(result).toEqual({ apiKey: "${ANTHROPIC_API_KEY}", newField: "hello" });
  });

  it("handles non-env-var strings (no restoration needed)", () => {
    const incoming = { name: "my-config" };
    const parsed = { name: "my-config" };
    const result = restoreEnvVarRefs(incoming, parsed, env);
    expect(result).toEqual({ name: "my-config" });
  });

  it("handles arrays", () => {
    const incoming = ["sk-ant-api03-real-key", "literal"];
    const parsed = ["${ANTHROPIC_API_KEY}", "literal"];
    const result = restoreEnvVarRefs(incoming, parsed, env);
    expect(result).toEqual(["${ANTHROPIC_API_KEY}", "literal"]);
  });

  it("handles null/undefined parsed gracefully", () => {
    const incoming = { apiKey: "sk-ant-api03-real-key" };
    expect(restoreEnvVarRefs(incoming, null, env)).toEqual(incoming);
    expect(restoreEnvVarRefs(incoming, undefined, env)).toEqual(incoming);
  });

  it("handles missing env var (cannot verify match)", () => {
    const envMissing = {} as unknown as NodeJS.ProcessEnv;
    const incoming = { apiKey: "some-value" };
    const parsed = { apiKey: "${MISSING_VAR}" };
    // Can't resolve the template, so keep incoming as-is
    const result = restoreEnvVarRefs(incoming, parsed, envMissing);
    expect(result).toEqual({ apiKey: "some-value" });
  });

  it("handles composite template strings like prefix-${VAR}-suffix", () => {
    const incoming = { url: "https://tok-12345.example.com" };
    const parsed = { url: "https://${MY_TOKEN}.example.com" };
    const result = restoreEnvVarRefs(incoming, parsed, env);
    expect(result).toEqual({ url: "https://${MY_TOKEN}.example.com" });
  });

  it("handles type mismatches between incoming and parsed", () => {
    // Caller changed type from string to number
    const incoming = { port: 8080 };
    const parsed = { port: "8080" };
    const result = restoreEnvVarRefs(incoming, parsed, env);
    expect(result).toEqual({ port: 8080 });
  });

  it("does not restore when parsed value has no env var pattern", () => {
    const incoming = { apiKey: "sk-ant-api03-real-key" };
    const parsed = { apiKey: "sk-ant-api03-real-key" };
    const result = restoreEnvVarRefs(incoming, parsed, env);
    expect(result).toEqual({ apiKey: "sk-ant-api03-real-key" });
  });

  // Edge case: env mutation between read and write (Greptile comment #1)
  // Scenario: config.env sets FOO=bar, which gets applied to process.env during loadConfig.
  // Later writeConfigFile runs — the env has changed since the original read.
  it("does not incorrectly restore when env var value changed between read and write", () => {
    // At read time, MY_VAR was "original-value" and resolved ${MY_VAR} → "original-value"
    // Then config.env or external mutation changed MY_VAR to "mutated-value"
    // Caller is writing back "original-value" (the value they got from the read)
    const mutatedEnv = { MY_VAR: "mutated-value" } as unknown as NodeJS.ProcessEnv;
    const incoming = { key: "original-value" };
    const parsed = { key: "${MY_VAR}" };

    const result = restoreEnvVarRefs(incoming, parsed, mutatedEnv);
    // Should NOT restore ${MY_VAR} because resolving it now gives "mutated-value",
    // which doesn't match "original-value" — the caller's value should be kept
    expect(result).toEqual({ key: "original-value" });
  });

  it("correctly restores when env var value hasn't changed", () => {
    const stableEnv = { MY_VAR: "stable-value" } as unknown as NodeJS.ProcessEnv;
    const incoming = { key: "stable-value" };
    const parsed = { key: "${MY_VAR}" };

    const result = restoreEnvVarRefs(incoming, parsed, stableEnv);
    // Env value matches incoming — safe to restore
    expect(result).toEqual({ key: "${MY_VAR}" });
  });

  it("does not restore when env snapshot differs from live env (TOCTOU fix)", () => {
    // With env snapshots: at read time MY_VAR was "old-value", so incoming is "old-value".
    // Caller changed it to "new-value". Live env also changed to "new-value".
    // But using the READ-TIME snapshot ("old-value"), we correctly see mismatch and keep incoming.
    const readTimeEnv = { MY_VAR: "old-value" } as unknown as NodeJS.ProcessEnv;
    const incoming = { key: "new-value" }; // caller intentionally changed this
    const parsed = { key: "${MY_VAR}" };

    const result = restoreEnvVarRefs(incoming, parsed, readTimeEnv);
    // Using read-time snapshot: ${MY_VAR} resolves to "old-value", doesn't match "new-value"
    // → correctly keeps caller's new value
    expect(result).toEqual({ key: "new-value" });
  });

  // Edge case: $${VAR} escape sequence (Greptile comment #2)
  it("handles $${VAR} escape sequence (literal ${VAR} in output)", () => {
    // In the config file: $${ANTHROPIC_API_KEY}
    // substituteString resolves this to literal "${ANTHROPIC_API_KEY}"
    // So incoming would be "${ANTHROPIC_API_KEY}" (the literal text)
    const incoming = { note: "${ANTHROPIC_API_KEY}" };
    const parsed = { note: "$${ANTHROPIC_API_KEY}" };

    const result = restoreEnvVarRefs(incoming, parsed, env);
    // Should restore the $${} escape, not try to resolve ${} inside it
    expect(result).toEqual({ note: "$${ANTHROPIC_API_KEY}" });
  });

  it("does not confuse $${VAR} escape with ${VAR} substitution", () => {
    // Config has both: an escaped ref and a real ref
    const incoming = {
      literal: "${MY_TOKEN}", // from $${MY_TOKEN} → literal "${MY_TOKEN}"
      resolved: "tok-12345", // from ${MY_TOKEN} → "tok-12345"
    };
    const parsed = {
      literal: "$${MY_TOKEN}", // escape sequence
      resolved: "${MY_TOKEN}", // real env var ref
    };

    const result = restoreEnvVarRefs(incoming, parsed, env);
    expect(result).toEqual({
      literal: "$${MY_TOKEN}", // should restore escape
      resolved: "${MY_TOKEN}", // should restore ref
    });
  });
});
