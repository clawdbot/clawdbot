import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeHostStats } from "../../shared/node-host-stats.js";
import { registerNodesStatusCommands } from "./register.status.js";

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  log: vi.fn(),
  writeJson: vi.fn(),
}));

vi.mock("./rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rpc.js")>()),
  callNodeDiagnosticsGatewayCli: mocks.call,
  resolveNodeDiagnosticsId: async () => "node-1",
}));
vi.mock("../../runtime.js", () => ({
  defaultRuntime: { log: mocks.log, writeJson: mocks.writeJson },
}));
vi.mock("../../../packages/terminal-core/src/table.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../packages/terminal-core/src/table.js")>()),
  getTerminalTableWidth: () => 240,
}));

const now = 1_800_000_000_000;
const hostStats: NodeHostStats = {
  cpuCount: 24,
  loadAverage: [3.24, 2, 1],
  memoryTotalBytes: 192 * 1024 ** 3,
  memoryFreeBytes: 41 * 1024 ** 3,
  diskTotalBytes: 2 * 1024 ** 4,
  diskAvailableBytes: Math.round(1.2 * 1024 ** 4),
  updatedAtMs: now - 27 * 24 * 60 * 60 * 1000,
};

describe.each(["status", "describe"])("nodes %s host stats", (command) => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(now);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { label: "connected", connected: true, stats: hostStats },
    { label: "last known", connected: false, stats: hostStats },
    {
      label: "memory only",
      connected: true,
      stats: {
        cpuCount: 2,
        memoryTotalBytes: 1024 ** 3,
        memoryFreeBytes: 512 * 1024 ** 2,
        updatedAtMs: now,
      },
    },
    { label: "unavailable", connected: false, stats: undefined },
  ])("renders $label stats and preserves JSON", async ({ connected, stats }) => {
    const node = { nodeId: "node-1", paired: true, connected, hostStats: stats };
    mocks.call.mockResolvedValue(command === "status" ? { nodes: [node] } : node);
    const nodes = new Command("nodes");
    registerNodesStatusCommands(nodes);
    const args = command === "status" ? [command] : [command, "--node", "node-1"];
    await nodes.parseAsync(args, { from: "user" });

    const output = mocks.log.mock.calls.map(([line]) => String(line)).join("\n");
    if (stats === hostStats) {
      expect(output).toContain("load 3.2/24 · mem 151/192 GB · disk 1.2 TB free");
    } else if (stats) {
      expect(output).toContain("mem 512 MB/1.0 GB");
      expect(output).not.toContain("load ");
      expect(output).not.toContain("disk ");
    } else {
      expect(output).not.toContain("mem ");
    }
    if (stats && !connected) {
      expect(output).toContain("(last known 27d ago)");
    } else {
      expect(output).not.toContain("last known");
    }

    await nodes.parseAsync([...args, "--json"], { from: "user" });
    expect(mocks.writeJson).toHaveBeenCalledWith(
      command === "status" ? { ts: now, nodes: [node] } : node,
    );
  });
});
