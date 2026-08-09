// Managed Gateway heap tests cover adaptive sizing and safe service overrides.
import { describe, expect, it } from "vitest";
import {
  formatGatewayHeapLimitReport,
  inspectGatewayHeapLimit,
  resolveGatewayHeapNodeOptions,
} from "./gateway-heap.js";

const MIB = 1024 * 1024;

describe("resolveGatewayHeapLimit", () => {
  it("prefers constrained memory", () => {
    expect(
      inspectGatewayHeapLimit(undefined, {
        constrainedMemoryBytes: 12_288 * MIB,
        physicalMemoryBytes: 64_000 * MIB,
      }),
    ).toMatchObject({
      maxOldSpaceSizeMiB: 6144,
      availableMemoryMiB: 12_288,
      memorySource: "constrained",
    });
  });

  it("falls back to physical memory when no constraint is reported", () => {
    expect(
      inspectGatewayHeapLimit(undefined, {
        constrainedMemoryBytes: 0,
        physicalMemoryBytes: 8192 * MIB,
      }),
    ).toMatchObject({
      maxOldSpaceSizeMiB: 4096,
      availableMemoryMiB: 8192,
      memorySource: "physical",
    });
  });

  it("applies the floor when the host has enough headroom", () => {
    expect(
      inspectGatewayHeapLimit(undefined, {
        constrainedMemoryBytes: 3072 * MIB,
        physicalMemoryBytes: 8192 * MIB,
      }).maxOldSpaceSizeMiB,
    ).toBe(2048);
  });

  it("bounds the floor to leave native headroom on smaller hosts", () => {
    expect(
      inspectGatewayHeapLimit(undefined, {
        constrainedMemoryBytes: 2048 * MIB,
        physicalMemoryBytes: 8192 * MIB,
      }).maxOldSpaceSizeMiB,
    ).toBe(1536);
  });

  it("caps the default on large hosts", () => {
    expect(
      inspectGatewayHeapLimit(undefined, {
        constrainedMemoryBytes: 64_000 * MIB,
        physicalMemoryBytes: 128_000 * MIB,
      }).maxOldSpaceSizeMiB,
    ).toBe(8192);
  });

  it("bounds an oversized constraint by physical memory", () => {
    expect(
      inspectGatewayHeapLimit(undefined, {
        constrainedMemoryBytes: 64_000 * MIB,
        physicalMemoryBytes: 8192 * MIB,
      }),
    ).toMatchObject({
      maxOldSpaceSizeMiB: 4096,
      availableMemoryMiB: 8192,
      memorySource: "physical",
    });
  });
});

describe("Gateway service NODE_OPTIONS", () => {
  it("recognizes canonical, underscore, separated, and quoted heap flags", () => {
    expect(inspectGatewayHeapLimit("--max-old-space-size=4096").appliedMiB).toBe(4096);
    expect(inspectGatewayHeapLimit("--max_old_space_size=5120").appliedMiB).toBe(5120);
    expect(inspectGatewayHeapLimit("--max-old-space-size 6144").appliedMiB).toBe(6144);
    expect(inspectGatewayHeapLimit('--max-old-space-size="7168"').appliedMiB).toBe(7168);
    expect(inspectGatewayHeapLimit('"--max-old-space-size=7680"').appliedMiB).toBe(7680);
  });

  it("rejects malformed quoted NODE_OPTIONS", () => {
    expect(inspectGatewayHeapLimit('--max-old-space-size="6144').appliedMiB).toBeNull();
  });

  it("uses the last explicit heap flag", () => {
    expect(
      inspectGatewayHeapLimit("--max-old-space-size=4096 --max_old_space_size=7168").appliedMiB,
    ).toBe(7168);
  });

  it("preserves only an explicit service heap limit", () => {
    expect(
      resolveGatewayHeapNodeOptions(
        "--require /tmp/preload.js --max-old-space-size=6144 --inspect=0.0.0.0:9229",
        { constrainedMemoryBytes: 32_000 * MIB },
      ),
    ).toBe("--max-old-space-size=6144");
  });

  it("reports the applied limit and adaptive derivation", () => {
    const report = inspectGatewayHeapLimit("--max-old-space-size=6144", {
      constrainedMemoryBytes: 8192 * MIB,
      physicalMemoryBytes: 16_384 * MIB,
    });
    expect(formatGatewayHeapLimitReport(report)).toBe(
      "6144 MiB (service setting; adaptive default 4096 MiB from 50% of 8192 MiB constrained memory, target range 2048-8192 MiB, native headroom cap 6144 MiB)",
    );
  });
});
