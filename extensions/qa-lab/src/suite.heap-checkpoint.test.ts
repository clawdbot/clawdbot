import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureGatewayHeapSnapshotCheckpoint } from "./suite.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const tempDirs = createTempDirHarness();
afterEach(() => tempDirs.cleanup());

describe("Gateway heap snapshot checkpoints", () => {
  async function createWriterFixture(outcome?: "failed" | "replaced-before" | "replaced-during") {
    const tempRoot = await tempDirs.makeTempDir("qa-heap-checkpoint-");
    const outputDir = path.join(tempRoot, "output");
    const snapshotPath = path.join(tempRoot, "Heap.snapshot.heapsnapshot");
    let pid = 123;
    const gateway = {
      tempRoot,
      get pid() {
        return pid;
      },
      async signalProcess() {
        await fs.writeFile(snapshotPath, '{"snapshot":');
        if (outcome === "replaced-before") {
          pid += 1;
        }
      },
      async call() {
        if (outcome === "failed") {
          throw new Error("Gateway exited during snapshot serialization");
        }
        if (outcome === "replaced-during") {
          pid += 1;
        }
        // Node's signal handler closes the snapshot before its JS thread can answer an RPC.
        await fs.appendFile(snapshotPath, '{"complete":true}}');
        return { ok: true };
      },
    };
    return { gateway, outputDir };
  }

  it("copies the completed snapshot even when an unfinished prefix has stopped growing", async () => {
    const params = await createWriterFixture();
    const checkpoint = await captureGatewayHeapSnapshotCheckpoint({
      ...params,
      label: "after turn",
    });
    expect(checkpoint).toBeDefined();
    const artifact = await fs.readFile(path.join(params.outputDir, checkpoint!.path));
    expect(JSON.parse(artifact.toString())).toEqual({ snapshot: { complete: true } });
    expect(checkpoint!.bytes).toBe(artifact.length);
  });

  it.each(["failed", "replaced-before", "replaced-during"] as const)(
    "does not publish a snapshot after the Gateway is %s",
    async (outcome) => {
      const params = await createWriterFixture(outcome);
      await expect(
        captureGatewayHeapSnapshotCheckpoint({ ...params, label: "after turn" }),
      ).rejects.toThrow(outcome === "failed" ? "Gateway exited" : "Gateway changed");
      await expect(fs.access(params.outputDir)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
