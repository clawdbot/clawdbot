// PDF tool helper tests cover page ranges, PDF input normalization, provider
// capability checks, and assistant text coercion.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../config/plugin-auto-enable.test-helpers.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { freezePluginMetadataValue } from "../../plugins/plugin-metadata-snapshot.js";
import {
  coercePdfAssistantText,
  coercePdfModelConfig,
  parsePageRange,
  providerSupportsNativePdf,
  resolvePdfInputs,
  resolvePdfToolMaxTokens,
} from "./pdf-tool.helpers.js";

const ANTHROPIC_PDF_MODEL = "anthropic/claude-opus-4-7";
const pdfManifestRegistry = makeRegistry([{ id: "pdf-metadata", channels: [] }]);
pdfManifestRegistry.plugins[0]!.contracts = {
  mediaUnderstandingProviders: ["anthropic", "google", "openai"],
};
pdfManifestRegistry.plugins[0]!.mediaUnderstandingProviderMetadata = {
  anthropic: { capabilities: ["image"], nativeDocumentInputs: ["pdf"] },
  google: { capabilities: ["image"], nativeDocumentInputs: ["pdf"] },
  openai: { capabilities: ["image"], nativeDocumentInputs: [] },
};
const pdfMetadata = freezePluginMetadataValue(
  createPluginMetadataSnapshot({ manifestRegistry: pdfManifestRegistry }),
);

describe("parsePageRange", () => {
  it("parses a single page number", () => {
    expect(parsePageRange("3", 20)).toEqual([3]);
  });

  it("parses a page range", () => {
    expect(parsePageRange("1-5", 20)).toEqual([1, 2, 3, 4, 5]);
  });

  it("parses comma-separated pages and ranges", () => {
    expect(parsePageRange("1,3,5-7", 20)).toEqual([1, 3, 5, 6, 7]);
  });

  it("clamps to maxPages", () => {
    expect(parsePageRange("1-100", 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("throws when no requested pages are within maxPages", () => {
    expect(() => parsePageRange("999", 20)).toThrow('No PDF pages matched requested range "999"');
  });

  it("deduplicates and sorts", () => {
    expect(parsePageRange("5,3,1,3,5", 20)).toEqual([1, 3, 5]);
  });

  it("throws on invalid page number", () => {
    expect(() => parsePageRange("abc", 20)).toThrow("Invalid page number");
  });

  it("throws on fractional page numbers", () => {
    expect(() => parsePageRange("1.5", 20)).toThrow('Invalid page number: "1.5"');
    expect(() => parsePageRange("1,2.5", 20)).toThrow('Invalid page number: "2.5"');
  });

  it("throws on unsafe integer page numbers and ranges", () => {
    const unsafePage = String(Number.MAX_SAFE_INTEGER + 1);
    const maxPages = 20;
    expect(() => parsePageRange(unsafePage, maxPages)).toThrow(
      `Invalid page number: "${unsafePage}"`,
    );
    expect(() => parsePageRange(`1-${unsafePage}`, maxPages)).toThrow(
      `Invalid page range: "${unsafePage}"`,
    );
  });

  it("throws on invalid range (start > end)", () => {
    expect(() => parsePageRange("5-3", 20)).toThrow("Invalid page range");
  });

  it("throws on zero page number", () => {
    expect(() => parsePageRange("0", 20)).toThrow("Invalid page number");
  });

  it("throws on negative page number", () => {
    expect(() => parsePageRange("-1", 20)).toThrow("Invalid page number");
  });

  it("handles empty parts gracefully", () => {
    expect(parsePageRange("1,,3", 20)).toEqual([1, 3]);
  });
});

describe("providerSupportsNativePdf", () => {
  it.each([
    ["anthropic", true],
    ["google", true],
    ["openai", false],
    ["minimax", false],
    ["Anthropic", true],
    ["GOOGLE", true],
  ] as const)("resolves %s support as %s from the current metadata scope", (provider, expected) => {
    withPluginMetadataSnapshotScope(pdfMetadata, () => {
      expect(providerSupportsNativePdf(provider)).toBe(expected);
    });
  });
});

describe("pdf-tool.helpers", () => {
  it("resolvePdfInputs requires at least one pdf reference", () => {
    expect(() => resolvePdfInputs({ prompt: "test" })).toThrow("pdf required");
  });

  it("resolvePdfInputs deduplicates pdf and pdfs entries", () => {
    // `pdf` and `pdfs` are both public inputs; normalize them to one ordered
    // list before any filesystem or provider work begins.
    expect(
      resolvePdfInputs({
        pdf: " /tmp/nonexistent.pdf ",
        pdfs: ["/tmp/nonexistent.pdf", "  ", "/tmp/other.pdf"],
      }),
    ).toEqual(["/tmp/nonexistent.pdf", "/tmp/other.pdf"]);
  });

  it("resolvePdfToolMaxTokens respects model limit", () => {
    expect(resolvePdfToolMaxTokens(2048, 4096)).toBe(2048);
    expect(resolvePdfToolMaxTokens(8192, 4096)).toBe(4096);
    expect(resolvePdfToolMaxTokens(undefined, 4096)).toBe(4096);
  });

  it("coercePdfModelConfig reads primary and fallbacks", () => {
    const cfg = {
      agents: {
        defaults: {
          pdfModel: {
            primary: ANTHROPIC_PDF_MODEL,
            fallbacks: ["google/gemini-2.5-pro"],
          },
        },
      },
    } as OpenClawConfig;
    expect(coercePdfModelConfig(cfg)).toEqual({
      primary: ANTHROPIC_PDF_MODEL,
      fallbacks: ["google/gemini-2.5-pro"],
    });
  });

  it("coercePdfAssistantText returns trimmed text", () => {
    expect(
      coercePdfAssistantText({
        provider: "anthropic",
        model: "claude-opus-4-7",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "  summary  " }],
        } as never,
      }),
    ).toBe("summary");
  });

  it("coercePdfAssistantText throws clear error for failed model output", () => {
    expect(() =>
      coercePdfAssistantText({
        provider: "google",
        model: "gemini-2.5-pro",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "bad request",
          content: [],
        } as never,
      }),
    ).toThrow("PDF model failed (google/gemini-2.5-pro): bad request");
  });
});
