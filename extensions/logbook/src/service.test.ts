import { mkdtempSync, rmSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLogbookConfig } from "./config.js";
import { LogbookService } from "./service.js";

type NodeRecord = { nodeId: string; displayName?: string; commands: string[] };

const quietLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

function makeService(params: {
  nodes: NodeRecord[];
  invoke: (args: { nodeId: string; command: string }) => Promise<unknown>;
  config?: Record<string, unknown>;
  fullConfig?: Record<string, unknown>;
}) {
  const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), "logbook-service-test-")));
  const invoked: Array<{ nodeId: string; command: string }> = [];
  const runtime = {
    nodes: {
      list: async () => ({ nodes: params.nodes }),
      invoke: async (args: { nodeId: string; command: string }) => {
        invoked.push({ nodeId: args.nodeId, command: args.command });
        return await params.invoke(args);
      },
    },
  };
  const service = new LogbookService(
    resolveLogbookConfig({ captureEnabled: true, ...params.config }),
    {
      runtime: runtime as never,
      fullConfig: (params.fullConfig ?? {}) as never,
      logger: quietLogger as never,
      dataDir,
    },
  );
  service.start();
  const tick = () =>
    (service as unknown as { captureTick(): Promise<void> }).captureTick.call(service);
  return { service, invoked, tick, dataDir };
}

const framePayload = {
  payload: { format: "jpeg", base64: Buffer.from("fake-jpeg").toString("base64") },
};

describe("LogbookService capture node selection", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("prefers app nodes over headless node hosts regardless of node id order", async () => {
    const { service, invoked, tick, dataDir } = makeService({
      nodes: [
        { nodeId: "a-headless", commands: ["logbook.snapshot"] },
        { nodeId: "b-mac-app", commands: ["screen.snapshot"] },
      ],
      invoke: async () => framePayload,
    });
    cleanups.push(() => {
      service.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });

    await tick();
    expect(invoked).toEqual([{ nodeId: "b-mac-app", command: "screen.snapshot" }]);
    expect(service.status()).toMatchObject({ pendingFrames: 1, lastCaptureError: undefined });
  });

  it("rotates to the next capture node after a failure instead of re-picking the broken one", async () => {
    const { service, invoked, tick, dataDir } = makeService({
      nodes: [
        { nodeId: "a-broken", commands: ["logbook.snapshot"] },
        { nodeId: "b-working", commands: ["logbook.snapshot"] },
      ],
      invoke: async ({ nodeId }) => {
        if (nodeId === "a-broken") {
          return { payload: { error: "logbook.snapshot is not supported on linux" } };
        }
        return framePayload;
      },
    });
    cleanups.push(() => {
      service.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });

    await tick();
    await tick();
    expect(invoked.map((call) => call.nodeId)).toEqual(["a-broken", "b-working"]);
    expect(service.status().lastCaptureError).toBeUndefined();
  });

  it.each([
    ["malformed string", "not-base64!"],
    ["object", { encoded: "ZmFrZQ==" }],
    ["array", ["ZmFrZQ=="]],
  ])("rejects a %s snapshot payload before storing a frame", async (_label, base64) => {
    const { service, tick, dataDir } = makeService({
      nodes: [{ nodeId: "capture-node", commands: ["logbook.snapshot"] }],
      invoke: async () => ({ payload: { format: "jpeg", base64 } }),
    });
    cleanups.push(() => {
      service.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });

    await tick();

    expect(service.status()).toMatchObject({
      pendingFrames: 0,
      lastCaptureError: "logbook.snapshot returned invalid image payload",
    });
  });
});

describe("LogbookService vision model selection", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("borrows only a media provider with structured extraction", () => {
    const { service, dataDir } = makeService({
      nodes: [],
      invoke: async () => framePayload,
      fullConfig: {
        tools: {
          media: {
            image: {
              models: [
                { provider: "openai", model: "gpt-5.5", capabilities: ["image"] },
                { provider: " Codex ", model: "gpt-5.5", capabilities: ["image"] },
              ],
            },
          },
        },
      },
    });
    cleanups.push(() => {
      service.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });

    expect(service.status()).toMatchObject({
      visionModel: "codex/gpt-5.5",
      visionModelSource: "media-defaults",
    });
  });

  it("reports a missing model when borrowed defaults cannot extract structured data", () => {
    const { service, dataDir } = makeService({
      nodes: [],
      invoke: async () => framePayload,
      fullConfig: {
        tools: {
          media: {
            models: [{ provider: "openai", model: "gpt-5.5", capabilities: ["image"] }],
          },
        },
      },
    });
    cleanups.push(() => {
      service.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });

    expect(service.status()).toMatchObject({
      visionModel: undefined,
      visionModelSource: "missing",
    });
  });
});

describe("LogbookService status", () => {
  it("returns the capture-host timezone without exposing the state path", () => {
    const { service, dataDir } = makeService({
      nodes: [],
      invoke: async () => framePayload,
    });

    try {
      expect(service.status()).toMatchObject({
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      expect(service.status()).not.toHaveProperty("dataDir");
    } finally {
      service.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
