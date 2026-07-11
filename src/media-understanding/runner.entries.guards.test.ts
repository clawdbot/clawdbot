// Runner entry guard tests cover malformed decision data formatting without
// depending on provider execution.
import { describe, expect, it } from "vitest";
import {
  buildModelDecision,
  formatDecisionSummary,
  formatMissingProviderHint,
} from "./runner.entries.js";
import type { MediaUnderstandingDecision } from "./types.js";

describe("media-understanding formatDecisionSummary guards", () => {
  it("formats skipped summary when decision.attachments is undefined", () => {
    expect(
      formatDecisionSummary({
        capability: "image",
        outcome: "skipped",
        attachments: undefined as unknown as MediaUnderstandingDecision["attachments"],
      }),
    ).toBe("image: skipped");
  });

  it("counts malformed attachment attempts as unchosen", () => {
    expect(
      formatDecisionSummary({
        capability: "video",
        outcome: "skipped",
        attachments: [{ attachmentIndex: 0, attempts: { bad: true } }],
      } as unknown as MediaUnderstandingDecision),
    ).toBe("video: skipped (0/1)");
  });

  it("ignores non-string provider/model/reason fields", () => {
    expect(
      formatDecisionSummary({
        capability: "audio",
        outcome: "failed",
        attachments: [
          {
            attachmentIndex: 0,
            chosen: {
              outcome: "failed",
              provider: { bad: true },
              model: 42,
            },
            attempts: [{ reason: { malformed: true } }],
          },
        ],
      } as unknown as MediaUnderstandingDecision),
    ).toBe("audio: failed (0/1)");
  });
});

describe("media-understanding CLI backend decisions", () => {
  it.each([
    {
      command: "sherpa-onnx-offline",
      args: ["--provider=cuda", "{{MediaPath}}"],
      requestedBackend: "cuda",
    },
    {
      command: "sherpa-onnx-offline",
      args: ["{{MediaPath}}"],
      requestedBackend: "cpu",
    },
    {
      command: "whisper-cli",
      args: ["--no-gpu", "{{MediaPath}}"],
      requestedBackend: "cpu",
    },
    {
      command: "whisper-cli",
      args: ["--device", "GPU0", "{{MediaPath}}"],
      requestedBackend: "device:GPU0",
    },
  ])(
    "reports $command backend request as $requestedBackend",
    ({ command, args, requestedBackend }) => {
      expect(
        buildModelDecision({
          entry: { type: "cli", command, args },
          entryType: "cli",
          outcome: "success",
        }),
      ).toMatchObject({ provider: command, model: command, requestedBackend });
    },
  );
});

describe("media-understanding formatMissingProviderHint", () => {
  it("returns the catalog hint for a provider with mediaUnderstandingProviders contract (groq)", () => {
    const hint = formatMissingProviderHint("groq");
    expect(hint).toContain("openclaw plugins install @openclaw/groq-provider");
    expect(hint).toContain("openclaw plugins registry --refresh");
    expect(hint).toContain("stop and start the gateway service");
    expect(hint).toContain("openclaw doctor --fix");
    expect(hint).toContain("official external plugin");
  });

  it("returns empty string for a provider with only generic providers[] entry but no mediaUnderstandingProviders contract (amazon-bedrock)", () => {
    const hint = formatMissingProviderHint("amazon-bedrock");
    expect(hint).toBe("");
  });

  it("returns empty string for a non-cataloged id (no convention fallback)", () => {
    const hint = formatMissingProviderHint("mystery-provider");
    expect(hint).toBe("");
  });

  it("returns empty string for an empty/whitespace id", () => {
    expect(formatMissingProviderHint("")).toBe("");
    expect(formatMissingProviderHint("   ")).toBe("");
  });

  it("returns empty string for an id that does not look like a plugin id", () => {
    expect(formatMissingProviderHint("bad/id")).toBe("");
    expect(formatMissingProviderHint("a")).toBe("");
    expect(formatMissingProviderHint("some/long/path")).toBe("");
  });

  it("preserves the legacy prefix when hint is appended (catalog-known id)", () => {
    const hint = formatMissingProviderHint("groq");
    const composed = `Media provider not available: groq${hint}`;
    expect(composed).toMatch(/^Media provider not available: groq .*openclaw plugins install/);
    expect(composed).toMatch(/official external plugin/);
    expect(composed).toMatch(/stop and start the gateway service/);
  });

  it("preserves the legacy message verbatim when the id is not cataloged", () => {
    const hint = formatMissingProviderHint("mystery-provider");
    expect(`Media provider not available: mystery-provider${hint}`).toBe(
      "Media provider not available: mystery-provider",
    );
  });

  it("returns empty string for a channel-only id (feishu)", () => {
    expect(formatMissingProviderHint("feishu")).toBe("");
  });

  it("returns empty string for a catalog provider without mediaUnderstandingProviders contract (amazon-bedrock legacy prefix)", () => {
    const hint = formatMissingProviderHint("amazon-bedrock");
    expect(`Media provider not available: amazon-bedrock${hint}`).toBe(
      "Media provider not available: amazon-bedrock",
    );
  });
});
