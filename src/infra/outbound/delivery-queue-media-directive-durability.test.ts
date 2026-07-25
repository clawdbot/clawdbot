import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type {
  ChannelOutboundAdapter,
  ChannelOutboundContext,
} from "../../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import {
  releasePinnedPluginChannelRegistry,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";
import { collectEntrySpoolPaths } from "./delivery-queue-media-spool.js";
import { loadPendingDeliveries } from "./delivery-queue-storage.js";
import { drainPendingDeliveries, type DeliverFn } from "./delivery-queue.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
} from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

const cfg = {} as OpenClawConfig;

function installMatrixAdapter(outbound: ChannelOutboundAdapter): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "matrix",
        source: "test",
        plugin: createOutboundTestPlugin({ id: "matrix", outbound }),
      },
    ]),
  );
}

/** Adapter that records what the live send resolves, then proves nothing dispatched. */
function enqueuePhaseAdapter(mediaPaths: string[]): ChannelOutboundAdapter {
  return {
    deliveryMode: "direct",
    sendText: async () => ({ channel: "matrix", messageId: "t" }),
    sendMedia: async (ctx: ChannelOutboundContext) => {
      mediaPaths.push(ctx.mediaUrl ?? "");
      // Proven-not-dispatched clears send evidence so the durable row stays replayable.
      throw new PlatformMessageNotDispatchedError("forced not-dispatched (test)", {
        cause: new Error("test"),
      });
    },
  };
}

type RecoveredSend = { mediaUrl: string; fromSpool: boolean; bytes?: string; error?: string };

/** Adapter that reads the exact path the replayed send hands it (spool copy vs producer path). */
function recoveryPhaseAdapter(records: RecoveredSend[], spoolRoot: string): ChannelOutboundAdapter {
  return {
    deliveryMode: "direct",
    sendText: async () => ({ channel: "matrix", messageId: "t" }),
    sendMedia: async (ctx: ChannelOutboundContext) => {
      const mediaUrl = ctx.mediaUrl ?? "";
      const fromSpool = path.dirname(mediaUrl) === spoolRoot;
      let bytes: string | undefined;
      let error: string | undefined;
      try {
        bytes = (await fs.readFile(mediaUrl)).toString("hex");
      } catch (err) {
        error = String(err);
      }
      records.push({ mediaUrl, fromSpool, bytes, error });
      if (error) {
        throw new Error(error);
      }
      return { channel: "matrix", messageId: "recovered" };
    },
  };
}

describe("delivery-queue MEDIA-directive durability (end-to-end)", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  let tmpDir: string;
  let sourceDir: string;
  let spoolRoot: string;
  const to = "!room:example";
  // Plain-text document: passes the host-local media send buffer verification.
  const bytes = Buffer.from("durable media directive proof payload\n", "utf8");

  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });

  beforeEach(async () => {
    tmpDir = fixtures.tmpDir();
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    spoolRoot = path.join(tmpDir, "delivery-queue-media");
    sourceDir = await fs.realpath(await fs.mkdtemp(path.join(tmpDir, "src-")));
  });

  afterEach(() => {
    releasePinnedPluginChannelRegistry();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("replays MEDIA-directive local media from a queue-owned copy after the source is deleted", async () => {
    const source = path.join(sourceDir, "generated.txt");
    await fs.writeFile(source, bytes);

    const payloads: ReplyPayload[] = [{ text: `caption\nMEDIA:${source}` }];
    const inputSnapshot = structuredClone(payloads);

    const liveMediaPaths: string[] = [];
    installMatrixAdapter(enqueuePhaseAdapter(liveMediaPaths));

    await expect(
      deliverOutboundPayloads({
        cfg,
        channel: "matrix",
        to,
        payloads,
        queuePolicy: "required",
        mediaAccess: { localRoots: [sourceDir] },
      }),
    ).rejects.toThrow("forced not-dispatched");

    // Live send stays copy-free on the original producer path.
    expect(liveMediaPaths).toEqual([source]);
    // Input object is not mutated.
    expect(payloads).toEqual(inputSnapshot);

    // The durable row references a queue-owned spool copy, not the producer path.
    const [entry] = await loadPendingDeliveries(tmpDir);
    expect(entry).toBeDefined();
    // mediaUrl and mediaUrls[0] both anchor to the one staged copy, so dedupe.
    const spoolPaths = [...new Set(collectEntrySpoolPaths(entry?.payloads ?? [], tmpDir))];
    expect(spoolPaths).toHaveLength(1);
    expect(path.dirname(spoolPaths[0] ?? "")).toBe(spoolRoot);
    // Raw pre-hook text (directive included) is preserved on the row.
    expect(entry?.payloads[0]?.text).toBe(`caption\nMEDIA:${source}`);
    // Spool bytes equal source bytes.
    expect(await fs.readFile(spoolPaths[0] ?? "")).toEqual(bytes);

    // Producer source disappears (process exit / TTS temp cleanup).
    await fs.rm(source, { force: true });
    await expect(fs.readFile(source)).rejects.toThrow();

    // Fresh-process recovery replays the row.
    const recovered: RecoveredSend[] = [];
    installMatrixAdapter(recoveryPhaseAdapter(recovered, spoolRoot));
    const deliver = vi.fn<DeliverFn>(async (params) => deliverOutboundPayloads(params));
    await drainPendingDeliveries({
      drainKey: "media-directive-test",
      logLabel: "media-directive drain",
      cfg,
      log: createRecoveryLog(),
      stateDir: tmpDir,
      deliver,
      selectEntry: (e) => ({ match: e.channel === "matrix", bypassBackoff: true }),
    });

    // Recovery delivered from the queue-owned copy, not the deleted producer path.
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.fromSpool).toBe(true);
    expect(recovered[0]?.error).toBeUndefined();
    expect(recovered[0]?.bytes).toBe(bytes.toString("hex"));
    expect(recovered[0]?.mediaUrl).not.toBe(source);
    // Terminal ack clears the durable row.
    expect(await loadPendingDeliveries(tmpDir)).toHaveLength(0);
  });

  it("fails a required send closed for sensitive directive media (no row, no spool)", async () => {
    const source = path.join(sourceDir, "secret.txt");
    await fs.writeFile(source, bytes);
    installMatrixAdapter(enqueuePhaseAdapter([]));

    await expect(
      deliverOutboundPayloads({
        cfg,
        channel: "matrix",
        to,
        payloads: [{ text: `MEDIA:${source}`, sensitiveMedia: true }],
        queuePolicy: "required",
        mediaAccess: { localRoots: [sourceDir] },
      }),
    ).rejects.toThrow(/cannot be persisted|unsupported/i);

    expect(await loadPendingDeliveries(tmpDir)).toHaveLength(0);
    await expect(fs.readdir(spoolRoot)).rejects.toThrow(); // spool dir never created
  });

  it("does not spool directive media when the queue is skipped", async () => {
    const source = path.join(sourceDir, "skip.txt");
    await fs.writeFile(source, bytes);
    const liveMediaPaths: string[] = [];
    installMatrixAdapter({
      deliveryMode: "direct",
      sendText: async () => ({ channel: "matrix", messageId: "t" }),
      sendMedia: async (ctx: ChannelOutboundContext) => {
        liveMediaPaths.push(ctx.mediaUrl ?? "");
        return { channel: "matrix", messageId: "sent" };
      },
    });

    await deliverOutboundPayloads({
      cfg,
      channel: "matrix",
      to,
      payloads: [{ text: `MEDIA:${source}` }],
      skipQueue: true,
      mediaAccess: { localRoots: [sourceDir] },
    });

    // Live send used the original path; nothing was queued or spooled.
    expect(liveMediaPaths).toEqual([source]);
    expect(await loadPendingDeliveries(tmpDir)).toHaveLength(0);
    await expect(fs.readdir(spoolRoot)).rejects.toThrow();
  });
});
