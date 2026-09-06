import { describe, expect, it } from "vitest";
import {
  transcriptGetFixture,
  transcriptListFixture,
  transcriptStatusFixture,
} from "../../../src/transcripts/library.test-support.js";
import { lazyCompile } from "./protocol-validator.js";
import {
  TranscriptsGetResultSchema,
  TranscriptsListResultSchema,
  TranscriptsStatusResultSchema,
} from "./schema/transcripts.js";
import {
  validateTranscriptsExportParams,
  validateTranscriptsGetParams,
  validateTranscriptsListParams,
  validateTranscriptsStatusParams,
} from "./validator-registry.js";

describe("transcript UI wire contracts", () => {
  it("accepts closed startup diagnostics without raw errors or unbounded extra rows", () => {
    const validate = lazyCompile(TranscriptsStatusResultSchema);
    const row = { source: { providerId: "fixture" }, state: "not-active", activeSelectors: [] };
    const response = (startDiagnostic: unknown) => ({
      ...transcriptStatusFixture,
      configuredSources: [{ ...row, startDiagnostic }],
    });
    for (const code of [
      "starting",
      "retrying",
      "id-conflict",
      "admitted-start-failed",
      "start-failed",
      "ended",
    ]) {
      expect(validate(response(code))).toBe(true);
    }
    expect(validate(response("raw provider error"))).toBe(false);
    expect(
      validate({
        ...transcriptStatusFixture,
        configuredSources: [{ ...row, startDiagnostic: "start-failed", error: "private" }],
      }),
    ).toBe(false);
    expect(
      validate({
        ...transcriptStatusFixture,
        configuredSources: Array.from({ length: 101 }, () => ({
          ...row,
          startDiagnostic: "starting",
        })),
      }),
    ).toBe(false);
  });
  it("validates shared UI fixture responses against the canonical wire schemas", () => {
    expect(lazyCompile(TranscriptsListResultSchema)(transcriptListFixture)).toBe(true);
    expect(lazyCompile(TranscriptsGetResultSchema)(transcriptGetFixture)).toBe(true);
    expect(lazyCompile(TranscriptsStatusResultSchema)(transcriptStatusFixture)).toBe(true);
    const validateGet = lazyCompile(TranscriptsGetResultSchema);
    const utterances = Array.from({ length: 2000 }, (_, sequence) => ({
      sequence,
      text: "speech",
    }));
    expect(validateGet({ ...transcriptGetFixture, utterances })).toBe(true);
    expect(
      validateGet({
        ...transcriptGetFixture,
        utterances: [...utterances, { sequence: 2000, text: "outside the recent window" }],
      }),
    ).toBe(false);
  });

  it("keeps pagination and search bounded and rejects mutation arguments", () => {
    expect(validateTranscriptsListParams({})).toBe(true);
    expect(
      validateTranscriptsListParams({
        limit: 100,
        query: "x".repeat(256),
        startedAfter: "2026-08-20T00:00:00Z",
      }),
    ).toBe(true);
    expect(validateTranscriptsListParams({ limit: 200 })).toBe(true);
    for (const limit of [0, 201, -1, 1.5, "50"]) {
      expect(validateTranscriptsListParams({ limit })).toBe(false);
    }
    expect(validateTranscriptsListParams({ query: "x".repeat(257) })).toBe(false);
    expect(validateTranscriptsGetParams({ selector: "opaque/full-value", limit: 100 })).toBe(true);
    expect(
      validateTranscriptsGetParams({ selector: "opaque", includeUtterances: true, limit: 101 }),
    ).toBe(false);
    expect(validateTranscriptsGetParams({ selector: "opaque", agentId: "forged" })).toBe(false);
    expect(validateTranscriptsExportParams({ selector: "opaque", format: "jsonl" })).toBe(true);
    expect(validateTranscriptsExportParams({ selector: "opaque", format: "markdown" })).toBe(true);
    expect(validateTranscriptsExportParams({ selector: "opaque", format: "audio" })).toBe(false);
    expect(validateTranscriptsStatusParams({})).toBe(true);
    expect(validateTranscriptsStatusParams({ enabled: true, autoStart: [] })).toBe(false);
  });

  it("keeps auto-start descriptors optional, closed, and limited to existing locator fields", () => {
    const validate = lazyCompile(TranscriptsStatusResultSchema);
    const response = (autoStart: unknown) => ({
      ...transcriptStatusFixture,
      providers: [{ ...transcriptStatusFixture.providers[0], autoStart }],
    });
    expect(
      validate(
        response({
          accountId: "optional",
          guildId: "required",
          channelId: "required",
          meetingUrl: "optional",
        }),
      ),
    ).toBe(true);
    expect(validate(response({}))).toBe(true);
    for (const descriptor of [
      { fileId: "required" },
      { sessionId: "optional" },
      { accountId: true },
      { channelId: "unknown" },
    ]) {
      expect(validate(response(descriptor))).toBe(false);
    }
  });
});
