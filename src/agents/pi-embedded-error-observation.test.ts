import { afterEach, describe, expect, it, vi } from "vitest";
import * as loggingConfigModule from "../logging/config.js";
import {
  buildApiErrorObservationFields,
  buildTextObservationFields,
  sanitizeForConsole,
} from "./pi-embedded-error-observation.js";

const OBSERVATION_BEARER_TOKEN = "sk-redact-test-token";
const OBSERVATION_COOKIE_VALUE = "session-cookie-token";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildApiErrorObservationFields", () => {
  it("redacts request ids and exposes stable hashes instead of raw payloads", () => {
    const observed = buildApiErrorObservationFields(
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_overload"}',
    );

    expect(observed).toMatchObject({
      rawErrorPreview: expect.stringContaining('"request_id":"sha256:'),
      rawErrorHash: expect.stringMatching(/^sha256:/),
      rawErrorFingerprint: expect.stringMatching(/^sha256:/),
      providerRuntimeFailureKind: "timeout",
      providerErrorType: "overloaded_error",
      providerErrorMessagePreview: "Overloaded",
      requestIdHash: expect.stringMatching(/^sha256:/),
    });
    expect(observed.rawErrorPreview).not.toContain("req_overload");
  });

  it("forces token redaction for observation previews", () => {
    const observed = buildApiErrorObservationFields(
      `Authorization: Bearer ${OBSERVATION_BEARER_TOKEN}`,
    );

    expect(observed.rawErrorPreview).not.toContain(OBSERVATION_BEARER_TOKEN);
    expect(observed.rawErrorPreview).toContain(OBSERVATION_BEARER_TOKEN.slice(0, 6));
    expect(observed.rawErrorHash).toMatch(/^sha256:/);
  });

  it("redacts observation-only header and cookie formats", () => {
    const observed = buildApiErrorObservationFields(
      `x-api-key: ${OBSERVATION_BEARER_TOKEN} Cookie: session=${OBSERVATION_COOKIE_VALUE}`,
    );

    expect(observed.rawErrorPreview).not.toContain(OBSERVATION_COOKIE_VALUE);
    expect(observed.rawErrorPreview).toContain("x-api-key: ***");
    expect(observed.rawErrorPreview).toContain("Cookie: session=");
  });

  it("does not let cookie redaction consume unrelated fields on the same line", () => {
    const observed = buildApiErrorObservationFields(
      `Cookie: session=${OBSERVATION_COOKIE_VALUE} status=503 request_id=req_cookie`,
    );

    expect(observed.rawErrorPreview).toContain("Cookie: session=");
    expect(observed.rawErrorPreview).toContain("status=503");
    expect(observed.rawErrorPreview).toContain("request_id=sha256:");
  });

  it("builds sanitized generic text observation fields", () => {
    const observed = buildTextObservationFields(
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_prev"}',
    );

    expect(observed).toMatchObject({
      textPreview: expect.stringContaining('"request_id":"sha256:'),
      textHash: expect.stringMatching(/^sha256:/),
      textFingerprint: expect.stringMatching(/^sha256:/),
      providerRuntimeFailureKind: "timeout",
      providerErrorType: "overloaded_error",
      providerErrorMessagePreview: "Overloaded",
      requestIdHash: expect.stringMatching(/^sha256:/),
    });
    expect(observed.textPreview).not.toContain("req_prev");
  });

  it("redacts request ids in formatted plain-text errors", () => {
    const observed = buildApiErrorObservationFields(
      "LLM error overloaded_error: Overloaded (request_id: req_plaintext_123)",
    );

    expect(observed).toMatchObject({
      rawErrorPreview: expect.stringContaining("request_id: sha256:"),
      rawErrorFingerprint: expect.stringMatching(/^sha256:/),
      requestIdHash: expect.stringMatching(/^sha256:/),
    });
    expect(observed.rawErrorPreview).not.toContain("req_plaintext_123");
  });

  it("keeps fingerprints stable across request ids for equivalent errors", () => {
    const first = buildApiErrorObservationFields(
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_001"}',
    );
    const second = buildApiErrorObservationFields(
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_002"}',
    );

    expect(first.rawErrorFingerprint).toBe(second.rawErrorFingerprint);
    expect(first.rawErrorHash).not.toBe(second.rawErrorHash);
  });

  it("truncates oversized raw and provider previews", () => {
    const longMessage = "X".repeat(260);
    const observed = buildApiErrorObservationFields(
      `{"type":"error","error":{"type":"server_error","message":"${longMessage}"},"request_id":"req_long"}`,
    );

    expect(observed.rawErrorPreview).toBeDefined();
    expect(observed.providerErrorMessagePreview).toBeDefined();
    expect(observed.rawErrorPreview?.length).toBeLessThanOrEqual(401);
    expect(observed.providerErrorMessagePreview?.length).toBeLessThanOrEqual(201);
    expect(observed.providerErrorMessagePreview?.endsWith("…")).toBe(true);
  });

  it("caps oversized raw inputs before hashing and fingerprinting", () => {
    const oversized = "X".repeat(70_000);
    const bounded = "X".repeat(64_000);

    expect(buildApiErrorObservationFields(oversized)).toMatchObject({
      rawErrorHash: buildApiErrorObservationFields(bounded).rawErrorHash,
      rawErrorFingerprint: buildApiErrorObservationFields(bounded).rawErrorFingerprint,
    });
  });

  it("returns empty observation fields for empty input", () => {
    expect(buildApiErrorObservationFields(undefined)).toEqual({});
    expect(buildApiErrorObservationFields("")).toEqual({});
    expect(buildApiErrorObservationFields("   ")).toEqual({});
  });

  it("re-reads configured redact patterns on each call", () => {
    const readLoggingConfig = vi.spyOn(loggingConfigModule, "readLoggingConfig");
    readLoggingConfig.mockReturnValueOnce(undefined);
    readLoggingConfig.mockReturnValueOnce({
      redactPatterns: [String.raw`\bcustom-secret-[A-Za-z0-9]+\b`],
    });

    const first = buildApiErrorObservationFields("custom-secret-abc123");
    const second = buildApiErrorObservationFields("custom-secret-abc123");

    expect(first.rawErrorPreview).toContain("custom-secret-abc123");
    expect(second.rawErrorPreview).not.toContain("custom-secret-abc123");
    expect(second.rawErrorPreview).toContain("custom");
  });

  it("fails closed when observation sanitization throws", () => {
    vi.spyOn(loggingConfigModule, "readLoggingConfig").mockImplementation(() => {
      throw new Error("boom");
    });

    expect(buildApiErrorObservationFields("request_id=req_123")).toEqual({});
    expect(buildTextObservationFields("request_id=req_123")).toEqual({
      textPreview: undefined,
      textHash: undefined,
      textFingerprint: undefined,
      httpCode: undefined,
      providerRuntimeFailureKind: undefined,
      providerErrorType: undefined,
      providerErrorMessagePreview: undefined,
      requestIdHash: undefined,
    });
  });

  it("ignores non-string configured redact patterns", () => {
    vi.spyOn(loggingConfigModule, "readLoggingConfig").mockReturnValue({
      redactPatterns: [
        123 as never,
        { bad: true } as never,
        String.raw`\bcustom-secret-[A-Za-z0-9]+\b`,
      ],
    });

    const observed = buildApiErrorObservationFields("custom-secret-abc123");

    expect(observed.rawErrorPreview).not.toContain("custom-secret-abc123");
    expect(observed.rawErrorPreview).toContain("custom");
  });

  it("keeps provider-less missing-scope auth payloads out of the codex-specific scope lane", () => {
    const observed = buildApiErrorObservationFields(
      '401 {"type":"error","error":{"type":"permission_error","message":"Missing scopes: api.responses.write"}}',
    );

    expect(observed).toMatchObject({
      httpCode: "401",
      providerRuntimeFailureKind: "unclassified",
    });
  });
});

describe("sanitizeForConsole", () => {
  it("strips control characters from console-facing values", () => {
    expect(sanitizeForConsole("run-1\nprovider\tmodel\rtest")).toBe("run-1 provider model test");
  });
});
