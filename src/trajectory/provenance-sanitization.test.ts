import { expectDefined } from "@openclaw/normalization-core";
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

  it("retains escaped overlapping target replacements for later event and final-prompt text", () => {
    const sourceIdentity = "agent:source:main";
    const targetIdentity = "agent:target.+*?^${}()|[]";
    const nestedTargetIdentity = `${targetIdentity}:child`;
    const sanitizer = new TrajectoryProvenanceSanitizer({
      mode: "live",
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: sourceIdentity,
      },
    });
    sanitizer.sanitizeEventData("tool.result", { echo: targetIdentity }, targetIdentity);
    sanitizer.sanitizeEventData(
      "tool.result",
      { echo: nestedTargetIdentity },
      nestedTargetIdentity,
    );
    const data = {
      assistantTexts: [`${nestedTargetIdentity} ${targetIdentity} ${sourceIdentity}`],
      finalPromptText: `${nestedTargetIdentity} ${targetIdentity} ${sourceIdentity}`,
      key: { echo: nestedTargetIdentity },
      sessionCount: { echo: nestedTargetIdentity },
    };
    const original = structuredClone(data);

    const sanitized = sanitizer.sanitizeEventData("model.completed", data);

    const nestedTargetHash = expectedHash(PROVENANCE_TEXT_HASH_DOMAIN, nestedTargetIdentity);
    const expectedText = [
      nestedTargetHash,
      expectedHash(PROVENANCE_TEXT_HASH_DOMAIN, targetIdentity),
      expectedHash(PROVENANCE_TEXT_HASH_DOMAIN, sourceIdentity),
    ].join(" ");
    expect(data).toEqual(original);
    expect(sanitized.assistantTexts).toEqual([expectedText]);
    expect(sanitized.finalPromptText).toBe(expectedText);
    const sanitizedKey = sanitized.key as { echo: string };
    const sanitizedSessionCount = sanitized.sessionCount as { echo: string };
    expect(sanitizedKey.echo).not.toBe(nestedTargetIdentity);
    expect(sanitizedKey.echo).not.toBe(nestedTargetHash);
    expect(sanitizedSessionCount.echo).toBe(nestedTargetHash);
  });

  it("does not learn target identities from payloads, hashes, or non-result options", () => {
    const forgedTarget = "forged-target-session-value";
    const canonicalHash = expectedHash(SOURCE_SESSION_HASH_DOMAIN, forgedTarget);
    const sanitizer = new TrajectoryProvenanceSanitizer({ mode: "live" });

    const forged = sanitizer.sanitizeEventData("tool.result", {
      targetSessionHash: canonicalHash,
      arguments: { sessionKey: forgedTarget },
      result: {
        details: { sourceSessionKey: forgedTarget },
        echo: forgedTarget,
      },
    });
    const later = sanitizer.sanitizeEventData(
      "model.completed",
      { assistantTexts: [forgedTarget] },
      forgedTarget,
    );

    expect(forged).toEqual({
      arguments: {},
      result: { details: {}, echo: forgedTarget },
    });
    expect(later.assistantTexts).toEqual([forgedTarget]);
  });

  it("keeps 64 target and provenance identities independent, then absorbs target overflow", () => {
    const sanitizer = new TrajectoryProvenanceSanitizer({ mode: "live" });
    const provenanceIdentities = Array.from(
      { length: 64 },
      (_value, index) => `provenance-${index.toString().padStart(3, "0")}`,
    );
    const targetIdentities = Array.from(
      { length: 65 },
      (_value, index) => `target-${index.toString().padStart(3, "0")}`,
    );
    for (const identity of provenanceIdentities) {
      expect(
        sanitizer.sanitizeEventData("prompt.submitted", {
          origin: { kind: "inter_session", sourceSessionKey: identity },
        }),
      ).not.toHaveProperty("redacted");
    }
    for (const identity of targetIdentities.slice(0, 64)) {
      expect(
        sanitizer.sanitizeEventData("tool.result", { echo: identity }, identity),
      ).not.toHaveProperty("redacted");
    }
    const firstTarget = expectDefined(targetIdentities[0], "first target");
    const firstProvenance = expectDefined(provenanceIdentities[0], "first provenance identity");
    expect(
      sanitizer.sanitizeEventData("tool.result", { echo: firstTarget }, firstTarget),
    ).not.toHaveProperty("redacted");
    expect(
      sanitizer.sanitizeEventData("model.completed", {
        assistantTexts: [firstTarget, firstProvenance],
      }),
    ).toEqual({
      assistantTexts: [
        expectedHash(PROVENANCE_TEXT_HASH_DOMAIN, firstTarget),
        expectedHash(PROVENANCE_TEXT_HASH_DOMAIN, firstProvenance),
      ],
    });
    const overflowTarget = expectDefined(targetIdentities[64], "overflow target");
    expect(
      sanitizer.sanitizeEventData("tool.result", { echo: overflowTarget }, overflowTarget),
    ).toEqual({
      redacted: true,
      reason: "trajectory-target-sanitization-limit",
    });
    expect(
      sanitizer.sanitizeEventData("model.completed", {
        finalPromptText: firstTarget,
      }),
    ).toEqual({
      redacted: true,
      reason: "trajectory-target-sanitization-limit",
    });
  });

  it.each([
    { name: "short", targetIdentity: "short" },
    { name: "oversized", targetIdentity: "x".repeat(4097) },
  ])("fails closed permanently for a $name trusted target", ({ targetIdentity }) => {
    const sanitizer = new TrajectoryProvenanceSanitizer({ mode: "live" });

    expect(
      sanitizer.sanitizeEventData("tool.result", { echo: targetIdentity }, targetIdentity),
    ).toEqual({
      redacted: true,
      reason: "trajectory-target-sanitization-limit",
    });
    expect(
      sanitizer.sanitizeEventData("model.completed", { finalPromptText: targetIdentity }),
    ).toEqual({
      redacted: true,
      reason: "trajectory-target-sanitization-limit",
    });
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

  it("redacts nested strings, primitives, and arrays under sensitive exact keys", () => {
    const secrets = {
      authorization: "opaque-authorization-descendant-1234567890",
      key: "opaque-key-descendant-1234567890",
      session: "opaque-session-descendant-1234567890",
      signature: "opaque-signature-descendant-1234567890",
      token: "opaque-token-descendant-1234567890",
    };
    const safeValue = "visible-session-count-value";
    const data = {
      key: {
        value: secrets.key,
        primitive: 123_456,
        values: [secrets.key, false, { nested: secrets.key }],
      },
      session: {
        value: secrets.session,
        primitive: 123_456,
        values: [secrets.session, false, { nested: secrets.session }],
      },
      signature: {
        value: secrets.signature,
        primitive: 123_456,
        values: [secrets.signature, false, { nested: secrets.signature }],
      },
      token: {
        value: secrets.token,
        primitive: 123_456,
        values: [secrets.token, false, { nested: secrets.token }],
      },
      authorization: {
        value: secrets.authorization,
        primitive: 123_456,
        values: [secrets.authorization, false, { nested: secrets.authorization }],
      },
      sessionCount: {
        value: safeValue,
        primitive: 123_456,
        values: [safeValue, false, { nested: safeValue }],
      },
    };
    const original = structuredClone(data);
    const sanitizer = new TrajectoryProvenanceSanitizer({ mode: "live" });

    const sanitized = sanitizer.sanitizeEventData("model.completed", data);

    expect(data).toEqual(original);
    const serialized = JSON.stringify(sanitized);
    for (const secret of Object.values(secrets)) {
      expect(serialized).not.toContain(secret);
    }
    for (const key of ["key", "session", "signature"] as const) {
      const projected = sanitized[key] as {
        primitive: unknown;
        value: unknown;
        values: [unknown, unknown, { nested: unknown }];
      };
      expect(projected.value).not.toBe(secrets[key]);
      expect(projected.primitive).toBe("***");
      expect(projected.values[0]).not.toBe(secrets[key]);
      expect(projected.values[1]).toBe("***");
      expect(projected.values[2].nested).not.toBe(secrets[key]);
    }
    expect(sanitized).not.toHaveProperty("token");
    expect(sanitized).not.toHaveProperty("authorization");
    expect(sanitized.sessionCount).toEqual(data.sessionCount);
  });

  it("lets sensitive ancestors override diagnostic code exemptions", () => {
    const sensitiveCodes = {
      error: "ERR_SENSITIVE_ERROR_1234567890",
      status: "SENSITIVE_STATUS_1234567890",
      details: "SENSITIVE_DETAILS_1234567890",
      warning: "sensitive-warning-1234567890",
    };
    const ordinaryCodes = {
      error: "ERR_TOOL_FAILED",
      status: "RETRY_REQUIRED",
      details: "DETAILS_VISIBLE",
      warning: "invalid-runtime-event",
    };
    const sanitizer = new TrajectoryProvenanceSanitizer({ mode: "live" });

    const sanitized = sanitizer.sanitizeEventData("model.completed", {
      ordinary: {
        error: { code: ordinaryCodes.error },
        status: { code: ordinaryCodes.status },
        details: { code: ordinaryCodes.details },
        warnings: [{ code: ordinaryCodes.warning }],
      },
      session: {
        error: { code: sensitiveCodes.error },
        status: { code: sensitiveCodes.status },
        details: { code: sensitiveCodes.details },
        warnings: [{ code: sensitiveCodes.warning }],
      },
    });

    expect(sanitized.ordinary).toEqual({
      error: { code: ordinaryCodes.error },
      status: { code: ordinaryCodes.status },
      details: { code: ordinaryCodes.details },
      warnings: [{ code: ordinaryCodes.warning }],
    });
    const serialized = JSON.stringify(sanitized.session);
    for (const code of Object.values(sensitiveCodes)) {
      expect(serialized).not.toContain(code);
    }
  });

  it("keeps sensitive ancestry through arrays and circular references", () => {
    const secret = "opaque-circular-session-value-1234567890";
    const session: Record<string, unknown> = {
      value: secret,
      values: [secret, 17],
    };
    session.self = session;
    const safe: Record<string, unknown> = { value: "visible-session-count-value" };
    safe.self = safe;
    const data = { session, sessionCount: safe };
    const sanitizer = new TrajectoryProvenanceSanitizer({ mode: "live" });

    const sanitized = sanitizer.sanitizeEventData("model.completed", data);
    const sanitizedSession = sanitized.session as { self: unknown; values: unknown[] };

    expect(JSON.stringify(sanitizedSession)).not.toContain(secret);
    expect(sanitizedSession.values).toEqual([expect.not.stringContaining(secret), "***"]);
    expect(sanitizedSession.self).toEqual({
      truncated: true,
      reason: "trajectory-circular-reference",
    });
    expect(sanitized.sessionCount).toEqual({
      value: "visible-session-count-value",
      self: {
        truncated: true,
        reason: "trajectory-circular-reference",
      },
    });
    expect(data.session).toBe(session);
    expect(session.self).toBe(session);
    expect(safe.self).toBe(safe);
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
