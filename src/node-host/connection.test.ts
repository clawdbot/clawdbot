import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NODE_HOST_STATS_EVENT, NODE_HOST_STATS_INTERVAL_MS } from "../shared/node-host-stats.js";
import { startNodeHostConnection } from "./connection.js";
import * as hostStats from "./host-stats.js";

const stats = { cpuCount: 8, memoryTotalBytes: 100, memoryFreeBytes: 50 };
const gateway = { url: "wss://gateway.example.test", protocol: 4, capabilities: [] };

function startConnectionFixture() {
  const request = vi.fn().mockResolvedValue({ ok: true, handled: false });
  const runtime = {
    invoke: vi.fn(),
    handleInput: vi.fn(),
    cancel: vi.fn(),
    cancelAll: vi.fn(),
    updateGatewayConnection: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  type Prepared = Parameters<typeof startNodeHostConnection>[0]["prepared"];
  const start = vi.fn<Prepared["start"]>(() => runtime);
  const prepared: Prepared = {
    manifest: { commands: [], caps: [], pathEnv: "/bin" },
    workerHostingEnabled: false,
    initialInventory: { skills: [], pluginTools: [] },
    start,
  };
  const writeStderrLine = vi.fn();
  const connection = startNodeHostConnection({
    prepared,
    client: { request },
    onManifestChanged: vi.fn(),
    writeStderrLine,
  });
  const publications = () => request.mock.calls.filter(([method]) => method === "node.event");
  return { connection, request, publications, writeStderrLine, start, prepared };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(hostStats, "sampleNodeHostStats").mockReturnValue(stats);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(["disconnect", "close", "manifest"] as const)(
  "publishes immediately and every minute until %s retires the connection",
  async (retire) => {
    const { connection, publications, start, prepared } = startConnectionFixture();
    try {
      expect(publications()).toEqual([]);
      connection.connect(gateway);
      expect(publications()).toEqual([
        ["node.event", { event: NODE_HOST_STATS_EVENT, payloadJSON: JSON.stringify(stats) }],
      ]);
      await vi.advanceTimersByTimeAsync(NODE_HOST_STATS_INTERVAL_MS - 1);
      expect(publications()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(publications()).toHaveLength(2);
      if (retire === "manifest") {
        start.mock.calls[0]?.[0].onManifestChanged?.(prepared.manifest);
      } else {
        await connection[retire]();
      }
      await vi.advanceTimersByTimeAsync(NODE_HOST_STATS_INTERVAL_MS * 2);
      expect(publications()).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await connection.close();
    }
  },
);

it("logs failures once per connection, redacts secrets, and waits for the next cadence", async () => {
  const { connection, request, publications, writeStderrLine } = startConnectionFixture();
  request.mockImplementation(async (method) => {
    if (method === "node.event") {
      throw new Error("publish unavailable password=fixture-secret");
    }
    return {};
  });
  try {
    connection.connect(gateway);
    await vi.advanceTimersByTimeAsync(0);
    expect(writeStderrLine).toHaveBeenCalledOnce();
    expect(writeStderrLine.mock.calls[0]?.[0]).toContain("node host stats publish failed:");
    expect(writeStderrLine.mock.calls[0]?.[0]).not.toContain("fixture-secret");
    await vi.advanceTimersByTimeAsync(NODE_HOST_STATS_INTERVAL_MS * 2);
    expect(publications()).toHaveLength(3);
    expect(writeStderrLine).toHaveBeenCalledOnce();
    connection.connect(gateway);
    await vi.advanceTimersByTimeAsync(0);
    expect(writeStderrLine).toHaveBeenCalledTimes(2);
  } finally {
    await connection.close();
  }
});

it("fences late failures and sends replacement samples only through the new client", async () => {
  const { connection, request, publications, writeStderrLine } = startConnectionFixture();
  let rejectOld!: (error: Error) => void;
  request.mockImplementation((method) =>
    method === "node.event"
      ? new Promise((_resolve, reject) => {
          rejectOld = reject;
        })
      : Promise.resolve({}),
  );
  const replacementRequest = vi.fn().mockResolvedValue({});
  try {
    connection.connect(gateway);
    connection.connect(gateway, { request: replacementRequest });
    rejectOld(new Error("retired request failed"));
    await vi.advanceTimersByTimeAsync(NODE_HOST_STATS_INTERVAL_MS);
    expect(writeStderrLine).not.toHaveBeenCalled();
    expect(publications()).toHaveLength(1);
    expect(
      replacementRequest.mock.calls.filter(([method]) => method === "node.event"),
    ).toHaveLength(2);
  } finally {
    await connection.close();
  }
});
