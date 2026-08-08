import { describe, expect, it } from "vitest";
import { sha256Hex } from "../infra/crypto-digest.js";
import { TrajectoryProvenanceSanitizer } from "./provenance-sanitization.js";

const SOURCE_SESSION_HASH_DOMAIN = "openclaw:trajectory:source-session-key:v1";
const ORIGIN_SESSION_HASH_DOMAIN = "openclaw:trajectory:origin-session-id:v1";

function expectedHash(domain: string, value: string): string {
  return `sha256:v1:${sha256Hex(JSON.stringify([domain, value]))}`;
}

describe("TrajectoryProvenanceSanitizer", () => {
  it("projects owned provenance in place without mutating inputs", () => {
    const sourceSessionKey = "agent:sender:main";
    const originSessionId = "origin-session";
    const hashShapedRawId = expectedHash(SOURCE_SESSION_HASH_DOMAIN, "canonical");
    const data = {
      origin: {
        kind: "inter_session",
        sourceSessionKey,
        originSessionId,
        sourceSessionHash: "forged",
        sourceChannel: "telegram",
        extra: "drop-me",
      },
      messagesSnapshot: [
        {
          role: "user",
          content: [{ type: "text", text: sourceSessionKey }],
          provenance: {
            kind: "external_user",
            sourceSessionKey: hashShapedRawId,
          },
        },
        {
          role: "assistant",
          provenance: {
            kind: "inter_session",
            sourceSessionKey: "assistant-routing",
          },
        },
      ],
    };
    const original = structuredClone(data);
    const sanitizer = new TrajectoryProvenanceSanitizer({ mode: "live" });

    const projected = sanitizer.sanitizeEventData("prompt.submitted", data);

    expect(data).toEqual(original);
    expect(projected.origin).toEqual({
      kind: "inter_session",
      sourceSessionHash: expectedHash(SOURCE_SESSION_HASH_DOMAIN, sourceSessionKey),
      originSessionHash: expectedHash(ORIGIN_SESSION_HASH_DOMAIN, originSessionId),
      sourceChannel: "telegram",
    });
    expect(projected.messagesSnapshot).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: sourceSessionKey }],
        provenance: {
          kind: "external_user",
          sourceSessionHash: expectedHash(SOURCE_SESSION_HASH_DOMAIN, hashShapedRawId),
        },
      },
      {
        role: "assistant",
        provenance: {
          kind: "inter_session",
        },
      },
    ]);
  });

  it("projects transcript provenance and redacts arbitrary routing-shaped fields", () => {
    const sourceSessionKey = "agent:sender:main";
    const sanitizer = new TrajectoryProvenanceSanitizer({ mode: "export" });

    const projected = sanitizer.sanitizeExportSnapshot({
      runtimeEvents: [
        {
          type: "transcript.entry",
          data: {
            message: {
              role: "user",
              content: sourceSessionKey,
              provenance: {
                kind: "inter_session",
                sourceSessionKey,
              },
            },
          },
        },
      ],
      branchEntries: [
        {
          type: "message",
          message: {
            role: "user",
            content: sourceSessionKey,
            provenance: {
              kind: "inter_session",
              sourceSessionKey,
            },
          },
        },
      ],
      header: {
        sourceSessionKey,
        nested: {
          target_session_key: "target",
          originSessionHash: "forged",
        },
      },
    });

    const expectedProvenance = {
      kind: "inter_session",
      sourceSessionHash: expectedHash(SOURCE_SESSION_HASH_DOMAIN, sourceSessionKey),
    };
    expect(projected.runtimeEvents[0]?.data?.message).toEqual({
      role: "user",
      content: sourceSessionKey,
      provenance: expectedProvenance,
    });
    expect(projected.branchEntries[0]?.message).toEqual({
      role: "user",
      content: sourceSessionKey,
      provenance: expectedProvenance,
    });
    expect(projected.header).toEqual({ nested: {} });
  });

  it("does not learn identities across records or rewrite ordinary text", () => {
    const sourceSessionKey = "agent:sender:main";
    const sanitizer = new TrajectoryProvenanceSanitizer({ mode: "live" });

    const provenance = sanitizer.sanitizeEventData("prompt.submitted", {
      origin: {
        kind: "inter_session",
        sourceSessionKey,
      },
    });
    const later = sanitizer.sanitizeEventData("model.completed", {
      assistantTexts: [`echo ${sourceSessionKey}`],
      finalPromptText: sourceSessionKey,
    });

    expect(provenance.origin).toEqual({
      kind: "inter_session",
      sourceSessionHash: expectedHash(SOURCE_SESSION_HASH_DOMAIN, sourceSessionKey),
    });
    expect(later).toEqual({
      assistantTexts: [`echo ${sourceSessionKey}`],
      finalPromptText: sourceSessionKey,
    });
  });

  it("accepts short identities and handles independent records without shared state", () => {
    const sanitizer = new TrajectoryProvenanceSanitizer({ mode: "live" });
    const short = sanitizer.sanitizeEventData("prompt.submitted", {
      origin: {
        kind: "inter_session",
        sourceSessionKey: "main",
        originSessionId: "global",
      },
    });

    expect(short.origin).toEqual({
      kind: "inter_session",
      sourceSessionHash: expectedHash(SOURCE_SESSION_HASH_DOMAIN, "main"),
      originSessionHash: expectedHash(ORIGIN_SESSION_HASH_DOMAIN, "global"),
    });

    for (let index = 0; index < 65; index += 1) {
      const identity = `identity-${index}`;
      expect(
        sanitizer.sanitizeEventData("prompt.submitted", {
          origin: { kind: "inter_session", sourceSessionKey: identity },
        }).origin,
      ).toEqual({
        kind: "inter_session",
        sourceSessionHash: expectedHash(SOURCE_SESSION_HASH_DOMAIN, identity),
      });
    }
  });

  it("omits oversized identities without poisoning later records", () => {
    const sanitizer = new TrajectoryProvenanceSanitizer({ mode: "live" });
    const oversized = sanitizer.sanitizeEventData("prompt.submitted", {
      origin: {
        kind: "inter_session",
        sourceSessionKey: "x".repeat(4097),
        originSessionId: "y".repeat(4097),
      },
    });
    const later = sanitizer.sanitizeEventData("prompt.submitted", {
      origin: { kind: "inter_session", sourceSessionKey: "main" },
    });

    expect(oversized.origin).toEqual({ kind: "inter_session" });
    expect(later.origin).toEqual({
      kind: "inter_session",
      sourceSessionHash: expectedHash(SOURCE_SESSION_HASH_DOMAIN, "main"),
    });
  });

  it("preserves validated canonical hashes only during export when raw ids are absent", () => {
    const canonicalSource = expectedHash(SOURCE_SESSION_HASH_DOMAIN, "source");
    const canonicalOrigin = expectedHash(ORIGIN_SESSION_HASH_DOMAIN, "origin");
    const exportSanitizer = new TrajectoryProvenanceSanitizer({ mode: "export" });
    const liveSanitizer = new TrajectoryProvenanceSanitizer({ mode: "live" });
    const value = {
      type: "prompt.submitted",
      data: {
        origin: {
          kind: "inter_session",
          sourceSessionHash: canonicalSource,
          originSessionHash: canonicalOrigin,
        },
      },
    };

    expect(
      exportSanitizer.sanitizeExportSnapshot({
        runtimeEvents: [value],
        branchEntries: [],
        header: {},
      }).runtimeEvents[0]?.data?.origin,
    ).toEqual({
      kind: "inter_session",
      sourceSessionHash: canonicalSource,
      originSessionHash: canonicalOrigin,
    });
    expect(liveSanitizer.sanitizeEventData("prompt.submitted", value.data).origin).toEqual({
      kind: "inter_session",
    });
  });

  it("redacts nested descendants of sensitive fields", () => {
    const secret = "opaque-session-descendant-1234567890";
    const session: Record<string, unknown> = {
      value: secret,
      primitive: 123_456,
      values: [secret, false, { nested: secret }],
    };
    session.self = session;
    const sanitizer = new TrajectoryProvenanceSanitizer({ mode: "live" });

    const projected = sanitizer.sanitizeEventData("model.completed", {
      session,
      sessionCount: {
        value: "visible",
        primitive: 123_456,
      },
    });

    expect(JSON.stringify(projected.session)).not.toContain(secret);
    expect(projected.session).toEqual({
      value: expect.not.stringContaining(secret),
      primitive: "***",
      values: [expect.not.stringContaining(secret), "***", { nested: expect.any(String) }],
      self: {
        truncated: true,
        reason: "trajectory-circular-reference",
      },
    });
    expect(projected.sessionCount).toEqual({
      value: "visible",
      primitive: 123_456,
    });
  });

  it("redacts authorization codes while preserving diagnostic codes", () => {
    const sanitizer = new TrajectoryProvenanceSanitizer({ mode: "live" });

    expect(
      sanitizer.sanitizeEventData("tool.call", {
        arguments: {
          oauth: { code: "opaque-oauth-code-1234567890" },
          providerNumeric: { code: 123_456 },
          nested: [{ providerAuth: { code: "opaque-array-code-1234567890" } }],
          error: { code: "ERR_TOOL_FAILED" },
          status: { code: "RETRY_REQUIRED" },
        },
      }),
    ).toEqual({
      arguments: {
        oauth: { code: "opaque…7890" },
        providerNumeric: { code: "***" },
        nested: [{ providerAuth: { code: "opaque…7890" } }],
        error: { code: "ERR_TOOL_FAILED" },
        status: { code: "RETRY_REQUIRED" },
      },
    });
  });

  it("bounds oversized values and final prompts", () => {
    const sanitizer = new TrajectoryProvenanceSanitizer({ mode: "live" });
    const projected = sanitizer.sanitizeEventData("model.completed", {
      finalPromptText: "x".repeat(8_000),
      values: Array.from({ length: 70 }, (_, index) => index),
    });

    expect(Buffer.byteLength(String(projected.finalPromptText), "utf8")).toBe(4 * 1024);
    expect(projected.finalPromptTextOriginalLength).toBe(8_000);
    expect(projected.values).toHaveLength(65);
    expect((projected.values as unknown[]).at(-1)).toEqual({
      truncated: true,
      reason: "trajectory-array-size-limit",
      originalLength: 70,
      limitItems: 64,
    });
  });

  it("applies export transforms after structural provenance projection", () => {
    const sanitizer = new TrajectoryProvenanceSanitizer({ mode: "export" });
    const projected = sanitizer.sanitizeExportValue(
      {
        visible: "workspace/root",
        nested: { value: "workspace/root" },
      },
      {
        transformKey: (key) => key.toUpperCase(),
        transformString: (value) => value.replaceAll("workspace/root", "<workspace>"),
      },
    );

    expect(projected).toEqual({
      VISIBLE: "<workspace>",
      NESTED: { VALUE: "<workspace>" },
    });
  });
});
