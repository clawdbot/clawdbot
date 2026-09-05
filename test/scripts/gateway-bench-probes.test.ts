import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { readProcessTreeCpuMs } from "../../scripts/lib/gateway-bench-probes.ts";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

describe("gateway benchmark process probes", () => {
  it.skipIf(process.platform === "win32")("parses day-prefixed process-tree CPU times", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "123 1 1-02:03:04\n124 123 01:02\n",
    } as never);

    expect(readProcessTreeCpuMs(123)).toBe(93_846_000);
  });
});
