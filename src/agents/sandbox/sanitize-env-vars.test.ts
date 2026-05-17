import { describe, expect, it } from "vitest";
import { sanitizeEnvVars, sanitizeExplicitSandboxEnvVars } from "./sanitize-env-vars.js";

describe("sanitizeEnvVars", () => {
  it("keeps normal env vars and blocks obvious credentials", () => {
    const result = sanitizeEnvVars({
      NODE_ENV: "test",
      OPENAI_API_KEY: "sk-live-xxx", // pragma: allowlist secret
      FOO: "bar",
      GITHUB_TOKEN: "gh-token", // pragma: allowlist secret
    });

    expect(result.allowed).toEqual({
      NODE_ENV: "test",
      FOO: "bar",
    });
    expect(result.blocked).toStrictEqual(["OPENAI_API_KEY", "GITHUB_TOKEN"]);
  });

  it("blocks credentials even when suffix pattern matches", () => {
    const result = sanitizeEnvVars({
      MY_TOKEN: "abc",
      MY_SECRET: "def",
      USER: "alice",
    });

    expect(result.allowed).toEqual({ USER: "alice" });
    expect(result.blocked).toStrictEqual(["MY_TOKEN", "MY_SECRET"]);
  });

  it("adds warnings for suspicious values", () => {
    const base64Like =
      "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYQ==";
    const result = sanitizeEnvVars({
      USER: "alice",
      SAFE_TEXT: base64Like,
      NULL: "a\0b",
    });

    expect(result.allowed).toEqual({ USER: "alice", SAFE_TEXT: base64Like });
    expect(result.blocked).toContain("NULL");
    expect(result.warnings).toContain("SAFE_TEXT: Value looks like base64-encoded credential data");
  });

  it("supports strict mode with explicit allowlist", () => {
    const result = sanitizeEnvVars(
      {
        NODE_ENV: "test",
        FOO: "bar",
      },
      { strictMode: true },
    );

    expect(result.allowed).toEqual({ NODE_ENV: "test" });
    expect(result.blocked).toEqual(["FOO"]);
  });

  it("skips undefined values when sanitizing process-style env maps", () => {
    const result = sanitizeEnvVars({
      NODE_ENV: "test",
      OPTIONAL_SECRET: undefined,
      OPENAI_API_KEY: undefined,
    });

    expect(result.allowed).toEqual({ NODE_ENV: "test" });
    expect(result.blocked).toStrictEqual([]);
  });

  it("allows explicit configured sandbox env names that look like credentials", () => {
    const result = sanitizeExplicitSandboxEnvVars({
      GEMINI_API_KEY: "dummy-gemini-api-key",
      GOOGLE_CLIENT_SECRET: "dummy-google-client-secret",
      HIMALAYA_PASSWORD: "dummy-himalaya-password",
      RESEND_API_KEY: "dummy-resend-api-key",
    });

    expect(result.allowed).toEqual({
      GEMINI_API_KEY: "dummy-gemini-api-key",
      GOOGLE_CLIENT_SECRET: "dummy-google-client-secret",
      HIMALAYA_PASSWORD: "dummy-himalaya-password",
      RESEND_API_KEY: "dummy-resend-api-key",
    });
    expect(result.blocked).toStrictEqual([]);
  });

  it("still blocks invalid explicit configured sandbox env values", () => {
    const result = sanitizeExplicitSandboxEnvVars({
      SAFE_SECRET: "ok",
      NULL_SECRET: "a\0b",
    });

    expect(result.allowed).toEqual({ SAFE_SECRET: "ok" });
    expect(result.blocked).toStrictEqual(["NULL_SECRET"]);
  });
});
