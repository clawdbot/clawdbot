import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  readAllowFromFileWithExists,
  readAllowFromFileSyncWithExists,
  resolveAllowFromAccountId,
  resolveAllowFromFilePath,
  safeChannelKey,
} from "./allow-from-store-file.js";
import type { PairingChannel } from "./pairing-store.types.js";

function expectInvalidPairingKey(params: {
  run: () => unknown;
  message: string;
  leaked?: string;
}): void {
  try {
    params.run();
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toBe(params.message);
    if (params.leaked) {
      expect(message).not.toContain(params.leaked);
    }
    return;
  }
  throw new Error("expected invalid pairing key error");
}

function fsError(message: string, code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

describe("allow-from store file keys", () => {
  it("formats invalid channel diagnostics without stringifying unsafe values", () => {
    const circular: Record<string, unknown> = { label: "private-channel-value" };
    circular.self = circular;

    expectInvalidPairingKey({
      run: () => safeChannelKey(circular as unknown as PairingChannel),
      message: "invalid pairing channel: expected non-empty string; got object",
      leaked: "private-channel-value",
    });
  });

  it("formats invalid account diagnostics without stringifying unsafe values", () => {
    expectInvalidPairingKey({
      run: () => resolveAllowFromFilePath("telegram", process.env, 10n as unknown as string),
      message: "invalid pairing account id: expected non-empty string; got bigint",
      leaked: "10",
    });

    expectInvalidPairingKey({
      run: () => resolveAllowFromAccountId(10n as unknown as string),
      message: "invalid pairing account id: expected non-empty string; got bigint",
      leaked: "10",
    });
  });

  it("reports sanitized-empty filename keys without exposing the raw key", () => {
    expectInvalidPairingKey({
      run: () => safeChannelKey(".." as PairingChannel),
      message: "invalid pairing channel: sanitized filename key is empty; got string length 2",
      leaked: "..",
    });

    expectInvalidPairingKey({
      run: () => resolveAllowFromFilePath("telegram", process.env, "/" as string),
      message: "invalid pairing account id: sanitized filename key is empty; got string length 1",
      leaked: "/",
    });
  });
});

describe("allow-from store file reads", () => {
  it("rethrows unexpected async read errors after a successful stat", async () => {
    const error = fsError("permission denied", "EACCES");
    const statSpy = vi.spyOn(fs.promises, "stat").mockResolvedValue({
      mtimeMs: 1,
      size: 2,
    } as fs.Stats);
    const readSpy = vi.spyOn(fs.promises, "readFile").mockRejectedValue(error);

    try {
      await expect(
        readAllowFromFileWithExists({
          cacheNamespace: "test-async-read-error",
          filePath: "/tmp/openclaw-allowFrom.json",
          normalizeStore: () => [],
        }),
      ).rejects.toBe(error);
    } finally {
      readSpy.mockRestore();
      statSpy.mockRestore();
    }
  });

  it("rethrows unexpected sync read errors after a successful stat", () => {
    const error = fsError("permission denied", "EACCES");
    const statSpy = vi.spyOn(fs, "statSync").mockReturnValue({
      mtimeMs: 1,
      size: 2,
    } as fs.Stats);
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw error;
    });

    try {
      expect(() =>
        readAllowFromFileSyncWithExists({
          cacheNamespace: "test-sync-read-error",
          filePath: "/tmp/openclaw-allowFrom.json",
          normalizeStore: () => [],
        }),
      ).toThrow(error);
    } finally {
      readSpy.mockRestore();
      statSpy.mockRestore();
    }
  });

  it("rethrows unexpected sync stat errors", () => {
    const error = fsError("permission denied", "EACCES");
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation(() => {
      throw error;
    });

    try {
      expect(() =>
        readAllowFromFileSyncWithExists({
          cacheNamespace: "test",
          filePath: "/tmp/openclaw-allowFrom.json",
          normalizeStore: () => [],
        }),
      ).toThrow(error);
    } finally {
      statSpy.mockRestore();
    }
  });
});
