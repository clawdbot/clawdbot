import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { onDecodedOutput } from "../process/decoded-output.js";
import type { WorkerProcessResult } from "../worker/worker-process-protocol.js";
import {
  observeNodeWorkerChildOutput,
  type NodeWorkerTerminalOutcome,
} from "./node-worker-launch-observation.js";
import type { NodeWorkerChildAdapter } from "./node-worker-launch-transport.js";
import {
  createNodeWorkerCredentialScrubber,
  NODE_WORKER_STDOUT_MAX_BYTES,
} from "./node-worker-output.js";

function resultFrame(turnId: string, transcriptLeafId = "leaf") {
  return {
    type: "result",
    turnId,
    result: { status: "completed", transcriptLeafId, transcriptNextSeq: 2 },
    retainWorker: false,
  } satisfies WorkerProcessResult;
}

function encodeResult(turnId: string, transcriptLeafId = "leaf"): Buffer {
  return Buffer.from(`${JSON.stringify(resultFrame(turnId, transcriptLeafId))}\n`);
}

function sizedResult(turnId: string, bytes: number): Buffer {
  return encodeResult(turnId, "x".repeat(bytes - encodeResult(turnId, "").length));
}

function observationHarness() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const journal = createDeferred();
  const exit = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  const unsubscribe: Array<() => void> = [];
  const kill = vi.fn();
  const dispose = vi.fn(() => {
    for (const stop of unsubscribe) {
      stop();
    }
    stdout.destroy();
    stderr.destroy();
  });
  const adapter = {
    supportsRawOutput: true,
    onStdout: (listener, onRaw) => {
      unsubscribe.push(onDecodedOutput(stdout, listener, onRaw));
    },
    onStderr: (listener, onRaw) => {
      unsubscribe.push(onDecodedOutput(stderr, listener, onRaw));
    },
    onExit: () => {},
    onError: () => {},
    wait: () => exit.promise,
    kill,
    dispose,
  } satisfies NodeWorkerChildAdapter;
  const frames: WorkerProcessResult[] = [];
  const outcome = observeNodeWorkerChildOutput(
    {
      adapter,
      journalReady: journal.promise,
      scrubber: createNodeWorkerCredentialScrubber("framing-fixture-token"),
      connectionFailure: {},
    },
    (frame) => frames.push(frame),
    () => undefined,
  );
  let closing: Promise<NodeWorkerTerminalOutcome> | undefined;
  const close = () =>
    (closing ??= (async () => {
      stdout.end();
      stderr.end();
      await Promise.all([finished(stdout), finished(stderr)]);
      journal.resolve();
      exit.resolve({ code: 0, signal: null });
      return await outcome;
    })());
  return {
    stdout,
    frames,
    kill,
    dispose,
    close,
    releaseJournal: async () => {
      journal.resolve();
      await journal.promise;
    },
  };
}

describe("node worker output framing", () => {
  it("preserves a UTF-8 character split across decoded output chunks", async () => {
    const harness = observationHarness();
    try {
      await harness.releaseJournal();
      const wire = encodeResult("first", "hello 漢😀");
      const split = wire.indexOf(Buffer.from("😀"));
      harness.stdout.write(wire.subarray(0, split + 1));
      harness.stdout.write(wire.subarray(split + 1, split + 3));
      expect(harness.frames).toEqual([]);
      harness.stdout.write(wire.subarray(split + 3));

      expect(await harness.close()).toEqual({
        state: "completed",
        resultJson: JSON.stringify(resultFrame("first", "hello 漢😀").result),
      });
      expect(harness.frames).toEqual([resultFrame("first", "hello 漢😀")]);
      expect(harness.kill).not.toHaveBeenCalled();
      expect(harness.dispose).toHaveBeenCalledOnce();
    } finally {
      await harness.close();
    }
  });

  it("accepts multiple bounded frames whose combined chunk exceeds the cap after journaling", async () => {
    const harness = observationHarness();
    try {
      await harness.releaseJournal();
      harness.stdout.write(
        Buffer.concat([
          sizedResult("first", NODE_WORKER_STDOUT_MAX_BYTES / 2 + 1),
          sizedResult("second", NODE_WORKER_STDOUT_MAX_BYTES / 2 + 1),
        ]),
      );

      expect(await harness.close()).toMatchObject({ state: "completed" });
      expect(harness.frames.map((frame) => frame.turnId)).toEqual(["first", "second"]);
      expect(harness.kill).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it("delivers an earlier frame before rejecting a later oversized frame in the same chunk", async () => {
    const harness = observationHarness();
    try {
      await harness.releaseJournal();
      harness.stdout.write(
        Buffer.concat([encodeResult("first"), Buffer.alloc(NODE_WORKER_STDOUT_MAX_BYTES + 1, 120)]),
      );

      expect(harness.frames).toEqual([resultFrame("first")]);
      expect(harness.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      expect(await harness.close()).toMatchObject({
        state: "failed",
        errorText: `worker stdout exceeded ${NODE_WORKER_STDOUT_MAX_BYTES} bytes`,
      });
    } finally {
      await harness.close();
    }
  });

  it.each([-1, 0, 1])(
    "bounds aggregate output including delimiters at cap + %i before journal readiness",
    async (delta) => {
      const harness = observationHarness();
      try {
        harness.stdout.write(
          Buffer.concat([
            sizedResult("first", NODE_WORKER_STDOUT_MAX_BYTES / 2),
            sizedResult("second", NODE_WORKER_STDOUT_MAX_BYTES / 2 + delta),
          ]),
        );

        expect(harness.frames).toEqual([]);
        expect(harness.kill).toHaveBeenCalledTimes(delta > 0 ? 1 : 0);
        const outcome = await harness.close();
        if (delta > 0) {
          expect(outcome).toMatchObject({
            state: "failed",
            errorText: `worker stdout exceeded ${NODE_WORKER_STDOUT_MAX_BYTES} bytes`,
          });
          expect(harness.frames).toEqual([]);
        } else {
          expect(outcome).toMatchObject({ state: "completed" });
          expect(harness.frames.map((frame) => frame.turnId)).toEqual(["first", "second"]);
        }
      } finally {
        await harness.close();
      }
    },
  );

  it.each([
    { name: "empty output", wire: Buffer.alloc(0), frames: 0 },
    { name: "an unterminated result", wire: encodeResult("first").subarray(0, -1), frames: 0 },
    {
      name: "a complete result followed by incomplete UTF-8",
      wire: Buffer.concat([encodeResult("first"), Buffer.from([0xf0, 0x9f])]),
      frames: 1,
    },
  ])("rejects EOF with $name", async ({ wire, frames }) => {
    const harness = observationHarness();
    try {
      await harness.releaseJournal();
      harness.stdout.write(wire);

      expect(await harness.close()).toMatchObject({
        state: "failed",
        errorText: "worker exited without a complete turn result",
      });
      expect(harness.frames).toHaveLength(frames);
    } finally {
      await harness.close();
    }
  });
});
