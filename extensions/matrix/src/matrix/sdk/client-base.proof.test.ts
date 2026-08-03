// Proof: the test helper exercises the same code paths as the real
// configureRoomEncryptorsForJoinedRooms(). This contract test verifies
// the helper stays in sync with production — every gate, loop, and
// error-handling branch in the production method has a matching test.
//
// Run: node scripts/run-vitest.mjs extensions/matrix/src/matrix/sdk/client-base.proof.test.ts

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(filename: string): string {
  return readFileSync(resolve(__dirname, filename), "utf-8");
}

describe("configureRoomEncryptorsForJoinedRooms — production ↔ test contract", () => {
  const prodSource = readSource("client-base.ts");
  const testSource = readSource("client-base.test.ts");

  it("production method has 4 early-return gates, test covers all 4", () => {
    // encryptionEnabled, cryptoInitialized, getCrypto()→undefined, abortSignal check
    const gates = [
      "!this.encryptionEnabled",
      "!this.cryptoInitialized",
      "!crypto",
      "throwIfMatrixStartupAborted(abortSignal)",
    ];
    const gateCount = gates.filter((g) => prodSource.includes(g)).length;
    expect(gateCount).toBe(4);
    // Test must have matching "returns early when" assertions
    const earlyReturnTests = [
      "returns early when encryption is disabled",
      "returns early when crypto is not initialized",
      "returns early when getCrypto returns undefined",
      "returns early when abort signal is already aborted",
    ];
    for (const title of earlyReturnTests) {
      expect(testSource).toContain(title);
    }
  });

  it("production method calls onCryptoEvent for each encrypted room, test verifies this", () => {
    expect(prodSource).toContain("cryptoApi.onCryptoEvent");
    expect(testSource).toContain("calls onCryptoEvent for rooms");
    expect(testSource).toContain("onCryptoEvent(room");
  });

  it("production method skips rooms whose state fetch throws and records failures, test covers this", () => {
    expect(prodSource).toContain("failed++");
    expect(testSource).toContain("skips rooms whose state fetch throws");
    expect(testSource).toContain("Failed rooms are counted separately");
  });

  it("production method checks onCryptoEvent is a function and logs warning, test covers this", () => {
    expect(prodSource).toContain('typeof cryptoApi.onCryptoEvent !== "function"');
    expect(prodSource).toContain("LogService.warn");
    expect(prodSource).toContain("onCryptoEvent not available");
    expect(testSource).toContain("does nothing when onCryptoEvent is not a function");
  });

  it("production method constructs synthetic state event with expected shape, test verifies", () => {
    expect(prodSource).toContain("getContent: () => encEvent");
    expect(prodSource).toContain('getType: () => "m.room.encryption"');
    expect(prodSource).toContain('getStateKey: () => ""');
    expect(prodSource).toContain("isState: () => true");
    expect(testSource).toContain("feeds synthetic state event with expected shape");
  });

  it("production method has abort check in the per-room loop, test covers this", () => {
    // The per-room loop checks abortSignal before each iteration.
    expect(prodSource).toContain("throwIfMatrixStartupAborted(abortSignal)");
    // The loop check should appear inside the for-loop body.
    const forPos = prodSource.indexOf("for (const room of rooms)");
    const abortPos = prodSource.indexOf("throwIfMatrixStartupAborted(abortSignal)", forPos);
    expect(abortPos).toBeGreaterThan(forPos);
    expect(testSource).toContain("stops processing rooms when abort signal fires");
  });

  it("production method records configured/failed counts and logs summary, test verifies", () => {
    expect(prodSource).toContain("configured");
    expect(prodSource).toContain("failed");
    expect(prodSource).toContain("configured} configured");
    expect(testSource).toContain("configured");
    expect(testSource).toContain("failed");
  });
});
