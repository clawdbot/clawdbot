/* @vitest-environment jsdom */
// Plain-HTTP origins have no crypto.subtle; device identity must still mint,
// fingerprint, and sign with the pure-JS paths so pairing works everywhere.
import { hashes, verifyAsync } from "@noble/ed25519";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { loadOrCreateDeviceIdentity, signDevicePayload } from "./index.ts";

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

describe("device identity on an insecure context", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    // Real insecure contexts keep getRandomValues; only crypto.subtle is gated.
    vi.stubGlobal("crypto", {
      getRandomValues: (array: Uint8Array) => {
        for (let i = 0; i < array.length; i += 1) {
          array[i] = (i * 37 + 11) % 256;
        }
        return array;
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mints, persists, and signs a device identity without crypto.subtle", async () => {
    expect(globalThis.crypto.subtle).toBeUndefined();

    const identity = await loadOrCreateDeviceIdentity();
    expect(identity.deviceId).toMatch(/^[0-9a-f]{64}$/);

    // The identity round-trips from storage with a stable id.
    const reloaded = await loadOrCreateDeviceIdentity();
    expect(reloaded.deviceId).toBe(identity.deviceId);

    const payload = "insecure-context-payload";
    const signature = await signDevicePayload(identity.privateKey, payload);
    await expect(
      verifyAsync(
        base64UrlDecode(signature),
        new TextEncoder().encode(payload),
        base64UrlDecode(identity.publicKey),
      ),
    ).resolves.toBe(true);
  });

  it("resolves the SHA-512 provider without crypto.subtle", async () => {
    expect(typeof hashes.sha512Async).toBe("function");
    const digest = await hashes.sha512Async?.(new Uint8Array([1, 2, 3]));
    expect(digest).toHaveLength(64);
  });
});
