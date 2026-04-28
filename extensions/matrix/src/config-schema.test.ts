import { describe, expect, it } from "vitest";
import { MatrixConfigSchema } from "./config-schema.js";

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
    expect(result.data.groups?.["!room:example.org"]?.account).toBe("axis");
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
    expect(result.data.rooms?.["!room:example.org"]?.account).toBe("axis");
  });

  it("accepts quiet Matrix streaming mode", () => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      streaming: "quiet",
    });
    expect(result.success).toBe(true);
  });

  it("accepts Matrix streaming preview tool progress config", () => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      streaming: {
        mode: "partial",
        preview: {
          toolProgress: false,
        },
      },
    });
    expect(result.success).toBe(true);
  });
});
