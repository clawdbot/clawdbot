import { describe, expect, it, vi } from "vitest";
import {
  resolveNpmIntegrityDrift,
  resolveNpmIntegrityDriftWithDefaultMessage,
} from "./npm-integrity.js";

describe("resolveNpmIntegrityDrift", () => {
  it.each([
    {
      expectedIntegrity: undefined,
      resolution: { integrity: "sha512-same", resolvedAt: "2026-01-01T00:00:00.000Z" },
    },
    {
      expectedIntegrity: "sha512-same",
      resolution: { resolvedAt: "2026-01-01T00:00:00.000Z" },
    },
    {
      expectedIntegrity: "sha512-same",
      resolution: { integrity: "sha512-same", resolvedAt: "2026-01-01T00:00:00.000Z" },
    },
  ])(
    "returns proceed=true when integrity is missing or unchanged: $expectedIntegrity",
    async ({ expectedIntegrity, resolution }) => {
      const createPayload = vi.fn(() => "unused");
      await expect(
        resolveNpmIntegrityDrift({
          spec: "@openclaw/test@1.0.0",
          expectedIntegrity,
          resolution,
          createPayload,
        }),
      ).resolves.toEqual({ proceed: true });
      expect(createPayload).not.toHaveBeenCalled();
    },
  );

  it("uses callback on integrity drift", async () => {
    const onIntegrityDrift = vi.fn(async () => false);
    const result = await resolveNpmIntegrityDrift({
      spec: "@openclaw/test@1.0.0",
      expectedIntegrity: "sha512-old",
      resolution: {
        integrity: "sha512-new",
        resolvedAt: "2026-01-01T00:00:00.000Z",
      },
      createPayload: ({ expectedIntegrity, actualIntegrity }) => ({
        expectedIntegrity,
        actualIntegrity,
      }),
      onIntegrityDrift,
    });

    expect(onIntegrityDrift).toHaveBeenCalledWith({
      expectedIntegrity: "sha512-old",
      actualIntegrity: "sha512-new",
    });
    expect(result.proceed).toBe(false);
    expect(result.integrityDrift).toEqual({
      expectedIntegrity: "sha512-old",
      actualIntegrity: "sha512-new",
    });
  });

  it("returns payload when the drift callback allows continuing", async () => {
    const result = await resolveNpmIntegrityDrift({
      spec: "@openclaw/test@1.0.0",
      expectedIntegrity: "sha512-old",
      resolution: {
        integrity: "sha512-new",
        resolvedAt: "2026-01-01T00:00:00.000Z",
      },
      createPayload: ({ spec, actualIntegrity }) => ({ spec, actualIntegrity }),
      onIntegrityDrift: async () => true,
    });

    expect(result).toEqual({
      integrityDrift: {
        expectedIntegrity: "sha512-old",
        actualIntegrity: "sha512-new",
      },
      payload: {
        spec: "@openclaw/test@1.0.0",
        actualIntegrity: "sha512-new",
      },
      proceed: true,
    });
  });

  it("warns and aborts by default when no callback is provided", async () => {
    const warn = vi.fn();
    const result = await resolveNpmIntegrityDrift({
      spec: "@openclaw/test@1.0.0",
      expectedIntegrity: "sha512-old",
      resolution: {
        integrity: "sha512-new",
        resolvedAt: "2026-01-01T00:00:00.000Z",
      },
      createPayload: ({ spec }) => ({ spec }),
      warn,
    });

    expect(warn).toHaveBeenCalledWith({ spec: "@openclaw/test@1.0.0" });
    expect(result.proceed).toBe(false);
  });

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
