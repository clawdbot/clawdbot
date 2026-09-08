import { describe, expect, it } from "vitest";
import {
  SESSION_CREATE_IDEMPOTENCY_RETENTION_MS,
  SESSION_CREATE_RETRY_WINDOW_MS,
  validateSessionsCreateParams,
} from "../index.js";

describe("sessions.create schema", () => {
  it.each([
    { url: "https://github.com/openclaw/openclaw.git" },
    { url: "https://github.com/openclaw/openclaw.git", ref: "release/next" },
  ])("accepts a repository source without a Gateway checkout: %j", (repository) => {
    expect(validateSessionsCreateParams({ agentId: "main", repository })).toBe(true);
  });

  it.each([
    { url: "" },
    { url: "x".repeat(2049) },
    { url: "https://github.com/openclaw/openclaw.git", ref: "" },
    { url: "https://github.com/openclaw/openclaw.git", ref: "x".repeat(1025) },
    { url: "https://github.com/openclaw/openclaw.git", path: "/gateway/repo" },
  ])("rejects malformed repository source %#", (repository) => {
    expect(validateSessionsCreateParams({ agentId: "main", repository })).toBe(false);
  });
  it("retains successful creates beyond the client's bounded retry window", () => {
    expect(SESSION_CREATE_RETRY_WINDOW_MS).toBe(4 * 60_000);
    expect(SESSION_CREATE_IDEMPOTENCY_RETENTION_MS).toBeGreaterThan(SESSION_CREATE_RETRY_WINDOW_MS);
  });

  it.each(["read-only", "guarded", "workspace", "full"])(
    "accepts the closed permission mode %s",
    (permissionMode) => {
      expect(validateSessionsCreateParams({ agentId: "main", permissionMode })).toBe(true);
    },
  );

  it("rejects unknown permission modes", () => {
    expect(validateSessionsCreateParams({ agentId: "main", permissionMode: "unrestricted" })).toBe(
      false,
    );
  });

  it("accepts additive create-time visibility values", () => {
    for (const visibility of ["shared", "read-only", "suggest", "draft"]) {
      expect(validateSessionsCreateParams({ agentId: "main", visibility })).toBe(true);
    }
  });

  it("rejects unknown visibility values", () => {
    expect(validateSessionsCreateParams({ agentId: "main", visibility: "private" })).toBe(false);
  });

  it("accepts a nonempty creation idempotency key", () => {
    expect(validateSessionsCreateParams({ agentId: "main", idempotencyKey: "start-once" })).toBe(
      true,
    );
    expect(validateSessionsCreateParams({ agentId: "main", idempotencyKey: "" })).toBe(false);
  });

  it("accepts initial session tool overrides", () => {
    expect(
      validateSessionsCreateParams({
        agentId: "main",
        toolOverrides: {
          mcpServers: { github: false },
          skills: { release: true },
          webSearch: false,
        },
      }),
    ).toBe(true);
  });

  it.each([null, { webSearch: "yes" }, { skills: { release: "yes" } }, { unknown: true }])(
    "rejects malformed initial tool overrides %#",
    (toolOverrides) => {
      expect(validateSessionsCreateParams({ agentId: "main", toolOverrides })).toBe(false);
    },
  );
});
