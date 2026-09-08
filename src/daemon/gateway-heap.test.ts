// Managed Gateway heap tests cover capacity policy and safe native service controls.
import { describe, expect, it } from "vitest";
import {
  formatGatewayHeapLimitReport,
  inspectGatewayHeapLimit,
  resolveGatewayHeapExecArgv,
  resolveGatewayHeapNodeOptions,
} from "./gateway-heap.js";

const MIB = 1024 * 1024;

describe("Gateway heap capacity policy", () => {
  it.each([
    { physical: 8192, constrained: 0, budget: 4096, source: "physical" },
    { physical: 65536, constrained: 12288, budget: 6144, source: "constrained" },
    { physical: 8192, constrained: 3072, budget: 2048, source: "constrained" },
    { physical: 8192, constrained: 2048, budget: 1536, source: "constrained" },
    { physical: 8192, constrained: 512, budget: 384, source: "constrained" },
    { physical: 32768, constrained: 0, budget: 8192, source: "physical" },
    { physical: 65536, constrained: 0, budget: 16384, source: "physical" },
    { physical: 131072, constrained: 0, budget: 32768, source: "physical" },
    { physical: 8192, constrained: 65536, budget: 4096, source: "physical" },
    { physical: 8192, constrained: Infinity, budget: 4096, source: "physical" },
    { physical: 8192, constrained: Number.NaN, budget: 4096, source: "physical" },
    { physical: 8192, constrained: -1, budget: 4096, source: "physical" },
    { physical: Number.NaN, constrained: 2048, budget: 1536, source: "constrained" },
    { physical: 0, constrained: 2048, budget: 1536, source: "constrained" },
    { physical: 0, constrained: 0, budget: null, source: "unknown" },
    { physical: Number.NaN, constrained: Infinity, budget: null, source: "unknown" },
    { physical: Number.NaN, constrained: 2 ** 64 / MIB, budget: null, source: "unknown" },
    { physical: -1, constrained: -1, budget: null, source: "unknown" },
  ])("physical=$physical constrained=$constrained selects $budget MiB", (testCase) => {
    expect(
      inspectGatewayHeapLimit(undefined, {
        physicalMemoryBytes: testCase.physical * MIB,
        constrainedMemoryBytes: testCase.constrained * MIB,
      }),
    ).toMatchObject({ maxOldSpaceSizeMiB: testCase.budget, memorySource: testCase.source });
  });
});

describe("Gateway service heap controls", () => {
  it.each([
    ["--max-old-space-size=4096", "--max-old-space-size=4096"],
    ["--max_old_space_size=5120", "--max-old-space-size=5120"],
    ["--max-old-space-size 6144", "--max-old-space-size=6144"],
    ['--max-old-space-size="7168"', "--max-old-space-size=7168"],
    ['"--max-old-space-size=7680"', "--max-old-space-size=7680"],
    ['--max_old_space_size_percentage "25"', "--max-old-space-size-percentage=25"],
    ["--max-old-space-size-percentage=1e-1", "--max-old-space-size-percentage=0.1"],
    ['--max_heap_size="24576"', "--max-heap-size=24576"],
    ["--max-heap-size 24576", "--max-heap-size=24576"],
    ["--max-old-space-size=0 --max-heap-size=0", "--max-old-space-size=0 --max-heap-size=0"],
    ["--max-old-space-size=4096 --max_old_space_size=24576", "--max-old-space-size=24576"],
    [
      "--max-old-space-size-percentage=10 --max_old_space_size_percentage=25",
      "--max-old-space-size-percentage=25",
    ],
    ["--max-heap-size=8192 --max_heap_size=24576", "--max-heap-size=24576"],
    [
      "--require /tmp/preload.js --max-old-space-size=24576 --inspect=9229",
      "--max-old-space-size=24576",
    ],
    [
      "--max-old-space-size=4096 --max-heap-size=8192 --max-old-space-size-percentage=25",
      "--max-old-space-size=4096 --max-heap-size=8192 --max-old-space-size-percentage=25",
    ],
  ])("preserves only native heap controls from %s", (input, expected) => {
    expect(resolveGatewayHeapNodeOptions(input)).toBe(expected);
    expect(
      resolveGatewayHeapExecArgv({ programArguments: [], environment: { NODE_OPTIONS: input } }),
    ).toEqual([]);
  });

  it.each([
    undefined,
    "--require /tmp/preload.js --inspect=9229",
    '--max-old-space-size="6144',
    "--max-old-space-size='6144'",
    "--max-old-space-size=-1",
    "--max-old-space-size=NaN",
    "--max-heap-size=Infinity",
    "--max-old-space-size-percentage=101",
    "--max-old-space-size-percentage=0",
    "--max-old-space-size-percentage=NaN",
    "--max-old-space-size-percentage=0.1%",
    "--MAX-OLD-SPACE-SIZE=6144",
  ])("clears absent, unsafe, or invalid service options: %s", (input) => {
    expect(resolveGatewayHeapNodeOptions(input)).toBe("");
  });

  it.each(["/tmp/preload.js", "gateway"])(
    "preserves argv controls after preload %s and ignores application flags",
    (preload) => {
      const command = [
        "node",
        "--require",
        preload,
        "--max_old_space_size=24576",
        "--max-heap-size=32768",
        "cli.js",
        "gateway",
        "--max-old-space-size=1024",
      ];
      const nodeOptions = "--max-old-space-size-percentage=25 --max-old-space-size=4096";
      expect(
        resolveGatewayHeapExecArgv({
          programArguments: command,
          environment: { NODE_OPTIONS: nodeOptions },
        }),
      ).toEqual(["--max-old-space-size=24576", "--max-heap-size=32768"]);
      expect(inspectGatewayHeapLimit(nodeOptions, {}, command)).toMatchObject({
        nodeOptions,
        execArgv: ["--max-old-space-size=24576", "--max-heap-size=32768"],
      });
    },
  );

  it.each([4096, 6144])(
    "reports configured %s without guessing automatic provenance",
    (configured) => {
      const report = inspectGatewayHeapLimit(`--max-old-space-size=${configured}`, {
        constrainedMemoryBytes: 8192 * MIB,
        physicalMemoryBytes: 16384 * MIB,
      });
      const text = formatGatewayHeapLimitReport(report);
      expect(text).toContain(`service NODE_OPTIONS: --max-old-space-size=${configured}`);
      expect(text).toContain("installer recommendation: 4096 MiB old space");
      expect(text).toContain("runtime V8 ceiling: not measured");
      expect(text).not.toContain("adaptive default");
    },
  );

  it("reports unavailable capacity without inventing a recommendation", () => {
    expect(
      formatGatewayHeapLimitReport(
        inspectGatewayHeapLimit(undefined, {
          constrainedMemoryBytes: 0,
          physicalMemoryBytes: Number.NaN,
        }),
      ),
    ).toContain("installer recommendation: unavailable (unknown capacity; use Node default)");
  });
});
