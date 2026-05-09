import fs from "node:fs";
import { type JsonSchemaObject, validateJsonSchemaValue } from "openclaw/plugin-sdk/config-schema";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf-8"),
) as { configSchema: JsonSchemaObject };

describe("active-memory manifest config schema", () => {
  it("accepts modelFallback for CLI and config.patch flows", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "active-memory.manifest.model-fallback",
      value: {
        enabled: true,
        agents: ["main"],
        modelFallback: "google/gemini-3-flash",
        modelFallbackPolicy: "resolved-only",
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts custom toolsAllow entries", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "active-memory.manifest.tools-allow",
      value: {
        enabled: true,
        agents: ["main"],
        toolsAllow: ["lcm_grep", "lcm_describe", "lcm_expand_query"],
      },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects wildcard and group toolsAllow entries", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "active-memory.manifest.tools-allow.reserved",
      value: {
        enabled: true,
        agents: ["main"],
        toolsAllow: ["*", "group:plugins"],
      },
    });

    expect(result.ok).toBe(false);
  });

  it("accepts timeoutMs values at the runtime ceiling", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "active-memory.manifest.timeout-ceiling",
      value: {
        enabled: true,
        agents: ["main"],
        timeoutMs: 120_000,
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts setupGraceTimeoutMs values at the runtime ceiling", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "active-memory.manifest.setup-grace-timeout-ceiling",
      value: {
        enabled: true,
        agents: ["main"],
        setupGraceTimeoutMs: 30_000,
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts explicit in allowedChatTypes", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "active-memory.manifest.allowed-chat-types.explicit",
      value: {
        enabled: true,
        agents: ["main"],
        allowedChatTypes: ["direct", "explicit"],
      },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects timeoutMs values above the runtime ceiling", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "active-memory.manifest.timeout-above-ceiling",
      value: {
        enabled: true,
        agents: ["main"],
        timeoutMs: 120_001,
      },
    });

    expect(result.ok).toBe(false);
  });

  it("rejects setupGraceTimeoutMs values above the runtime ceiling", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "active-memory.manifest.setup-grace-timeout-above-ceiling",
      value: {
        enabled: true,
        agents: ["main"],
        setupGraceTimeoutMs: 30_001,
      },
    });

    expect(result.ok).toBe(false);
  });

  it("rejects unknown allowedChatTypes values", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "active-memory.manifest.allowed-chat-types.invalid",
      value: {
        enabled: true,
        agents: ["main"],
        allowedChatTypes: ["direct", "portal"],
      },
    });

    expect(result.ok).toBe(false);
  });
});
