// Tests npm integrity parsing and drift detection.
import { describe, expect, it, vi } from "vitest";
import { resolveNpmIntegrityDriftWithDefaultMessage } from "./npm-integrity.js";

describe("resolveNpmIntegrityDrift", () => {
  it("formats default warning and abort error messages", async () => {
    const warn = vi.fn();
    const warningResult = await resolveNpmIntegrityDriftWithDefaultMessage({
      spec: "@openclaw/test@1.0.0",
      expectedIntegrity: "sha512-old",
      resolution: {
        integrity: "sha512-new",
        resolvedSpec: "@openclaw/test@1.0.0",
        resolvedAt: "2026-01-01T00:00:00.000Z",
      },
      warn,
    });
    expect(warningResult.error).toBe(
      "aborted: npm package integrity drift detected for @openclaw/test@1.0.0",
    );
    expect(warn).toHaveBeenCalledWith(
      "Integrity drift detected for @openclaw/test@1.0.0: expected sha512-old, got sha512-new",
    );

    const abortResult = await resolveNpmIntegrityDriftWithDefaultMessage({
      spec: "@openclaw/test@1.0.0",
      expectedIntegrity: "sha512-old",
      resolution: {
        integrity: "sha512-new",
        resolvedSpec: "@openclaw/test@1.0.0",
        resolvedAt: "2026-01-01T00:00:00.000Z",
      },
      onIntegrityDrift: async () => false,
    });
    expect(abortResult.error).toBe(
      "aborted: npm package integrity drift detected for @openclaw/test@1.0.0",
    );
  });

  it("falls back to the original spec when resolvedSpec is missing", async () => {
    const warn = vi.fn();

    const result = await resolveNpmIntegrityDriftWithDefaultMessage({
      spec: "@openclaw/test@1.0.0",
      expectedIntegrity: "sha512-old",
      resolution: {
        integrity: "sha512-new",
        resolvedAt: "2026-01-01T00:00:00.000Z",
      },
      warn,
    });

    expect(result.error).toBe(
      "aborted: npm package integrity drift detected for @openclaw/test@1.0.0",
    );
    expect(warn).toHaveBeenCalledWith(
      "Integrity drift detected for @openclaw/test@1.0.0: expected sha512-old, got sha512-new",
    );
  });
});
