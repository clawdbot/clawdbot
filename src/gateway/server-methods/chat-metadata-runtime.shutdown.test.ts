import { describe, expect, test, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createChatMetadataHarness } from "./chat-metadata-runtime.test-support.js";

describe("gateway chat metadata shutdown", () => {
  test("closes replacement waiters without publishing or reviving metadata", async () => {
    const onChanged = vi.fn();
    const harness = createChatMetadataHarness(undefined, { onChanged });
    await harness.runtime.refresh();
    harness.runtime.invalidate();
    const reads = [
      harness.runtime.read({ agentId: "main" }),
      harness.runtime.readStartup({
        agentId: "main",
        sessionEntry: { authProfileOverride: "test:session", authProfileOverrideSource: "user" },
      }),
    ].map((read) => read.catch((error: unknown) => error));

    await harness.runtime.stop();

    for (const result of await Promise.all(reads)) {
      expect(result).toMatchObject({
        name: "ChatMetadataSnapshotUnavailableError",
        message: "gateway chat metadata runtime is stopped",
      });
    }
    harness.runtime.invalidate();
    harness.runtime.fail(new Error("late owner failure"));
    await expect(harness.runtime.refresh()).rejects.toThrow("stopped");
    await expect(harness.runtime.read({ agentId: "main" })).rejects.toThrow("stopped");
    await expect(harness.runtime.readStartup({ agentId: "main" })).resolves.toBeUndefined();
    await harness.runtime.stop();
    expect(onChanged).toHaveBeenCalledOnce();
    expect(harness.buildProjection).toHaveBeenCalledOnce();
  });

  test("joins an abandoned projection after a sibling fails the generation", async () => {
    const onChanged = vi.fn();
    const harness = createChatMetadataHarness(
      { agents: { list: [{ id: "main", default: true }, { id: "other" }] } },
      { onChanged },
    );
    const release = createDeferred();
    const events: string[] = [];
    harness.buildProjection.mockImplementationOnce(async ({ facts }) => {
      await release.promise;
      events.push("projection settled");
      return { modelCatalog: facts.modelCatalog.entries, models: facts.modelCatalog.entries };
    });
    harness.buildProjection.mockRejectedValueOnce(new Error("sibling projection failed"));
    try {
      await expect(harness.runtime.refresh()).rejects.toThrow("sibling projection failed");
      const stopping = harness.runtime.stop().then(() => events.push("shutdown completed"));
      release.resolve();
      await stopping;
      expect(events).toEqual(["projection settled", "shutdown completed"]);
      expect(onChanged).toHaveBeenCalledOnce();
      await expect(harness.runtime.read({ agentId: "main" })).rejects.toThrow("stopped");
    } finally {
      release.resolve();
      await harness.runtime.stop();
    }
  });
});
