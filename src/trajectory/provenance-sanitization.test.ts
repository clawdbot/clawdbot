import { describe, expect, it } from "vitest";
import { sha256Hex } from "../infra/crypto-digest.js";
import { TrajectoryProvenanceSanitizer } from "./provenance-sanitization.js";

const SOURCE_SESSION_HASH_DOMAIN = "openclaw:trajectory:source-session-key:v1";
const ORIGIN_SESSION_HASH_DOMAIN = "openclaw:trajectory:origin-session-id:v1";
const PROVENANCE_TEXT_HASH_DOMAIN = "openclaw:trajectory:provenance-text:v1";

function expectedHash(domain: string, value: string): string {
  return `sha256:v1:${sha256Hex(JSON.stringify([domain, value]))}`;
}

describe("TrajectoryProvenanceSanitizer", () => {
  it("scrubs overlapping identities without learning from arbitrary provenance-shaped data", () => {
    const sourceSessionKey = "agent:sender";
    const originSessionId = "agent:sender:main";
    const sourceTextHash = expectedHash(PROVENANCE_TEXT_HASH_DOMAIN, sourceSessionKey);
    const originTextHash = expectedHash(PROVENANCE_TEXT_HASH_DOMAIN, originSessionId);
    const spoofedHash = `sha256:v1:${"f".repeat(64)}`;
    const data = {
      [originSessionId]: "raw-key-first",
      [originTextHash]: "preexisting-hash-key",
      assistantTexts: [`before ${originSessionId} after ${sourceSessionKey}`],
      messagesSnapshot: [
        {
          role: "user",
          content: [{ type: "text", text: originSessionId }],
          provenance: {
            kind: "inter_session",
            sourceSessionKey: originSessionId,
            originSessionId: sourceSessionKey,
            sourceSessionHash: spoofedHash,
            extra: "drop-me",
          },
        },
        {
          role: "assistant",
          content: [{ type: "text", text: `assistant echo ${originSessionId}` }],
        },
      ],
      arbitrary: {
        origin: {
          kind: "inter_session",
          sourceSessionKey: "not-learned-origin",
        },
        provenance: {
          kind: "inter_session",
          sourceSessionKey: "not-learned-provenance",
        },
        echo: "not-learned-origin not-learned-provenance",
      },
    };
    const original = structuredClone(data);
    const sanitizer = new TrajectoryProvenanceSanitizer({
      mode: "live",
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey,
        originSessionId,
      },
    });

    const sanitized = sanitizer.sanitizeEventData("model.completed", data);

    expect(data).toEqual(original);
    expect(sanitized[originTextHash]).toBe("raw-key-first");
    expect(sanitized[`${originTextHash}#2`]).toBe("preexisting-hash-key");
    expect(sanitized.messagesSnapshot).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: originTextHash }],
        provenance: {
          kind: "inter_session",
          sourceSessionHash: expectedHash(SOURCE_SESSION_HASH_DOMAIN, originSessionId),
          originSessionHash: expectedHash(ORIGIN_SESSION_HASH_DOMAIN, sourceSessionKey),
        },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: `assistant echo ${originTextHash}` }],
      },
    ]);
    expect(sanitized.arbitrary).toEqual({
      origin: { kind: "inter_session" },
      provenance: { kind: "inter_session" },
      echo: "not-learned-origin not-learned-provenance",
    });
    const serialized = JSON.stringify(sanitized);
    expect(serialized).toContain(sourceTextHash);
    expect(serialized).toContain(originTextHash);
    expect(serialized).not.toContain(originSessionId);
    expect(serialized).not.toContain(sourceSessionKey);
    expect(serialized).not.toContain(spoofedHash);
    expect(serialized).not.toContain("drop-me");
  });

  it("pre-scans export provenance and keeps raw identifiers authoritative over hashes", () => {
    const rawSessionKey = "agent:sender:main";
    const canonicalRaw = expectedHash(SOURCE_SESSION_HASH_DOMAIN, "already-canonical");
    const preservedHash = expectedHash(SOURCE_SESSION_HASH_DOMAIN, "preserved");
    const spoofedHash = `sha256:v1:${"e".repeat(64)}`;
    const runtimeEvents = [
      {
        type: "model.completed",
        data: {
          assistantTexts: [`earlier echo ${rawSessionKey}`],
        },
      },
      {
        type: "prompt.submitted",
        data: {
          prompt: "later provenance",
          origin: {
            kind: "inter_session",
            sourceSessionKey: rawSessionKey,
            sourceSessionHash: spoofedHash,
          },
        },
      },
      {
        type: "prompt.submitted",
        data: {
          prompt: "canonical raw",
          origin: {
            kind: "inter_session",
            sourceSessionKey: canonicalRaw,
            sourceSessionHash: spoofedHash,
          },
        },
      },
      {
        type: "prompt.submitted",
        data: {
          prompt: "hash only",
          origin: {
            kind: "external_user",
            sourceSessionHash: preservedHash,
          },
        },
      },
    ];
    const branchEntries = [
      {
        type: "message",
        message: {
          role: "user",
          content: rawSessionKey,
          provenance: {
            kind: "inter_session",
            sourceSessionKey: rawSessionKey,
          },
        },
      },
    ];
    const originalRuntime = structuredClone(runtimeEvents);
    const originalBranch = structuredClone(branchEntries);
    const sanitizer = new TrajectoryProvenanceSanitizer({ mode: "export" });

    const sanitized = sanitizer.sanitizeExportSnapshot({
      runtimeEvents,
      branchEntries,
      header: { type: "session", note: rawSessionKey },
    });

    expect(runtimeEvents).toEqual(originalRuntime);
    expect(branchEntries).toEqual(originalBranch);
    expect(sanitized.runtimeEvents[0]?.data?.assistantTexts).toEqual([
      `earlier echo ${expectedHash(PROVENANCE_TEXT_HASH_DOMAIN, rawSessionKey)}`,
    ]);
    expect(sanitized.runtimeEvents[1]?.data?.origin).toEqual({
      kind: "inter_session",
      sourceSessionHash: expectedHash(SOURCE_SESSION_HASH_DOMAIN, rawSessionKey),
    });
    expect(sanitized.runtimeEvents[2]?.data?.origin).toEqual({
      kind: "inter_session",
      sourceSessionHash: expectedHash(SOURCE_SESSION_HASH_DOMAIN, canonicalRaw),
    });
    expect(sanitized.runtimeEvents[3]?.data?.origin).toEqual({
      kind: "external_user",
      sourceSessionHash: preservedHash,
    });
    expect(JSON.stringify(sanitized)).not.toContain(rawSessionKey);
    expect(JSON.stringify(sanitized)).not.toContain(spoofedHash);
  });

  it("fails closed on short, oversized, and excess identity state", () => {
    const shortIdentity = "short";
    const shortSanitizer = new TrajectoryProvenanceSanitizer({ mode: "live" });
    const shortResult = shortSanitizer.sanitizeEventData("prompt.submitted", {
      prompt: `echo ${shortIdentity}`,
      origin: {
        kind: "inter_session",
        sourceSessionKey: shortIdentity,
      },
    });
    expect(shortResult).toEqual({
      redacted: true,
      reason: "trajectory-provenance-sanitization-limit",
    });

    const oversizedIdentity = "x".repeat(4097);
    const oversizedSanitizer = new TrajectoryProvenanceSanitizer({
      mode: "live",
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: oversizedIdentity,
      },
    });
    expect(
      oversizedSanitizer.sanitizeEventData("context.compiled", {
        prompt: oversizedIdentity,
      }),
    ).toEqual({
      redacted: true,
      reason: "trajectory-provenance-sanitization-limit",
    });

    const countSanitizer = new TrajectoryProvenanceSanitizer({ mode: "live" });
    for (let index = 0; index < 64; index += 1) {
      expect(
        countSanitizer.sanitizeEventData("prompt.submitted", {
          origin: {
            kind: "inter_session",
            sourceSessionKey: `identity-${index.toString().padStart(3, "0")}`,
          },
        }),
      ).not.toHaveProperty("redacted");
    }
    expect(
      countSanitizer.sanitizeEventData("prompt.submitted", {
        origin: {
          kind: "inter_session",
          sourceSessionKey: "identity-overflow",
        },
      }),
    ).toEqual({
      redacted: true,
      reason: "trajectory-provenance-sanitization-limit",
    });
  });

  it("keeps provenance-free payload bytes equivalent while cloning them", () => {
    const data = {
      prompt: "ordinary prompt",
      messagesSnapshot: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [{ type: "text", text: "world" }] },
      ],
    };
    const sanitizer = new TrajectoryProvenanceSanitizer({ mode: "live" });

    const sanitized = sanitizer.sanitizeEventData("model.completed", data);

    expect(JSON.stringify(sanitized)).toBe(JSON.stringify(data));
    expect(sanitized).not.toBe(data);
    expect(sanitized.messagesSnapshot).not.toBe(data.messagesSnapshot);
  });

  it("redacts authorization codes with full paths while preserving diagnostic codes", () => {
    const sanitizer = new TrajectoryProvenanceSanitizer({ mode: "live" });

    expect(
      sanitizer.sanitizeEventData("tool.call", {
        arguments: {
          oauth: { code: "opaque-oauth-code-1234567890" },
          provider: { code: "opaque-provider-code-1234567890" },
          providerPattern: { code: "opaque Bearer token-shaped-secret-1234567890" },
          providerNumeric: { code: 123_456 },
          nested: [{ providerAuth: { code: "opaque-array-code-1234567890" } }],
          error: { code: "ERR_TOOL_FAILED" },
          errorNumeric: { error: { code: 500 } },
          status: { code: "RETRY_REQUIRED" },
          statusNumeric: { status: { code: 429 } },
          manifest: { warnings: [{ code: "invalid-runtime-event" }] },
        },
      }),
    ).toEqual({
      arguments: {
        oauth: { code: "opaque…7890" },
        provider: { code: "opaque…7890" },
        providerPattern: { code: "opaque…7890" },
        providerNumeric: { code: "***" },
        nested: [{ providerAuth: { code: "opaque…7890" } }],
        error: { code: "ERR_TOOL_FAILED" },
        errorNumeric: { error: { code: 500 } },
        status: { code: "RETRY_REQUIRED" },
        statusNumeric: { status: { code: 429 } },
        manifest: { warnings: [{ code: "invalid-runtime-event" }] },
      },
    });
  });
});
