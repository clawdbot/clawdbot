// Matrix tests cover config schema plugin behavior.
import { describe, expect, it } from "vitest";
import { MatrixChannelConfigSchema } from "./config-schema.js";

const MatrixConfigSchema = MatrixChannelConfigSchema.runtime;
if (!MatrixConfigSchema) {
  throw new Error("expected Matrix runtime config schema");
}

describe("MatrixConfigSchema SecretInput", () => {
  it("accepts SecretRef accessToken at top-level", () => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: { source: "env", provider: "default", id: "MATRIX_ACCESS_TOKEN" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts SecretRef password at top-level", () => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      password: { source: "env", provider: "default", id: "MATRIX_PASSWORD" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts dm threadReplies overrides", () => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      dm: {
        policy: "pairing",
        threadReplies: "off",
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts dm sessionScope overrides", () => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      dm: {
        policy: "pairing",
        sessionScope: "per-room",
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts the Matrix name matching compatibility flag", () => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      dangerouslyAllowNameMatching: true,
    });
    expect(result.success).toBe(true);
  });

  it("accepts room-level account assignments", () => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      groups: {
        "!room:example.org": {
          enabled: true,
          account: "axis",
        },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("expected schema parse to succeed");
    }
    expect(result.data).toMatchObject({
      groups: { "!room:example.org": { account: "axis" } },
    });
  });

  it("accepts legacy room-level account assignments", () => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      rooms: {
        "!room:example.org": {
          enabled: true,
          account: "axis",
        },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("expected schema parse to succeed");
    }
    expect(result.data).toMatchObject({
      rooms: { "!room:example.org": { account: "axis" } },
    });
  });

  it.each(["groups", "rooms"] as const)("rejects unknown %s entry fields", (scope) => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      [scope]: {
        "!room:example.org": {
          enabled: true,
          unknownSetting: true,
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts nested quiet Matrix streaming mode with delivery controls", () => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      streaming: {
        mode: "quiet",
        chunkMode: "newline",
        block: { enabled: true, coalesce: { idleMs: 100 } },
      },
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ["scalar streaming mode", { streaming: "quiet" }],
    ["boolean streaming", { streaming: true }],
  ])("rejects legacy %s spelling", (_name, overrides) => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      ...overrides,
    });
    expect(result.success).toBe(false);
  });

  it("accepts Matrix streaming preview tool progress config", () => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      streaming: {
        mode: "progress",
        progress: {
          label: "Shelling",
          maxLines: 4,
          toolProgress: false,
          commandText: "status",
        },
        preview: {
          toolProgress: true,
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ["boolean streaming", { streaming: true }],
    ["mode string streaming", { streaming: "progress" }],
    ["streamMode", { streamMode: "progress" }],
    ["chunkMode", { chunkMode: "newline" }],
    ["blockStreaming", { blockStreaming: true }],
    ["blockStreamingCoalesce", { blockStreamingCoalesce: { idleMs: 5 } }],
    ["draftChunk", { draftChunk: { minChars: 10 } }],
  ])("rejects retired account streaming input (%s) with a doctor pointer", (_name, input) => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      accounts: { work: input },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // The channel-config wrapper reshapes failures into { issues }.
      expect(JSON.stringify(result.issues)).toContain("doctor --fix");
    }
  });

  it("keeps schema-open account entries with nested streaming objects", () => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      accounts: { work: { streaming: { mode: "progress" }, customField: 1 } },
    });
    expect(result.success).toBe(true);
  });
});
