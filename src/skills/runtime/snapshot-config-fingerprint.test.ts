import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  fingerprintSkillSnapshotConfig,
  resetSkillSnapshotConfigFingerprintCache,
} from "./snapshot-config-fingerprint.js";

describe("skill snapshot config fingerprint", () => {
  it("reuses one config identity until the runtime apply owner resets it", () => {
    let workspace = "/tmp/first";
    let reads = 0;
    const config = {} as OpenClawConfig;
    Object.defineProperty(config, "agents", {
      enumerable: true,
      get: () => {
        reads += 1;
        return { defaults: { workspace } };
      },
    });

    const first = fingerprintSkillSnapshotConfig(config);
    const readsAfterFirstFingerprint = reads;
    expect(fingerprintSkillSnapshotConfig(config)).toBe(first);
    expect(reads).toBe(readsAfterFirstFingerprint);

    workspace = "/tmp/second";
    resetSkillSnapshotConfigFingerprintCache();
    const second = fingerprintSkillSnapshotConfig(config);
    expect(second).not.toBe(first);
    expect(reads).toBeGreaterThan(readsAfterFirstFingerprint);
  });
});
