// Task-lane registry: collision rejection, provider isolation, paging.
import { describe, expect, it } from "vitest";
import {
  createTaskLaneRegistry,
  listTaskLaneProviderIds,
  loadTaskLaneSnapshot,
  registerTaskLaneProvider,
} from "./registry.js";
import type { TaskLane, TaskLaneProvider } from "./types.js";

function lane(id: string, items: Array<Record<string, unknown>> = []): TaskLane {
  return { id, label: `Lane ${id}`, items: items as TaskLane["items"] };
}

function provider(
  id: string,
  load: TaskLaneProvider["load"] = async () => ({ lanes: [lane(id)] }),
): TaskLaneProvider {
  return { id, label: `Provider ${id}`, load };
}

describe("task-lane registry", () => {
  it("validates provider ids and rejects duplicates", () => {
    const registry = createTaskLaneRegistry();
    expect(() => registerTaskLaneProvider(registry, provider("Bad Id"))).toThrow(
      /invalid task lane provider id/,
    );
    registerTaskLaneProvider(registry, provider("cron"));
    expect(() => registerTaskLaneProvider(registry, provider("cron"))).toThrow(
      /already registered/,
    );
    expect(listTaskLaneProviderIds(registry)).toEqual(["cron"]);
  });

  it("loads lanes from all providers sorted by id with ok diagnostics", async () => {
    const registry = createTaskLaneRegistry();
    registerTaskLaneProvider(
      registry,
      provider("zeta", async () => ({
        lanes: [lane("zeta", [{ id: "i1", title: "t", state: "running" }])],
      })),
    );
    registerTaskLaneProvider(registry, provider("alpha"));
    const snapshot = await loadTaskLaneSnapshot(registry);
    expect(snapshot.lanes.map((entry) => entry.id)).toEqual(["alpha", "zeta"]);
    expect(snapshot.diagnostics).toEqual([
      { providerId: "alpha", ok: true, laneCount: 1, itemCount: 0 },
      { providerId: "zeta", ok: true, laneCount: 1, itemCount: 1 },
    ]);
  });

  it("isolates a throwing provider: diagnostics fail, other lanes survive", async () => {
    const registry = createTaskLaneRegistry();
    registerTaskLaneProvider(
      registry,
      provider("boom", async () => {
        throw new Error("provider exploded");
      }),
    );
    registerTaskLaneProvider(
      registry,
      provider("fine", async () => ({
        lanes: [lane("fine", [{ id: "i2", title: "t", state: "succeeded" }])],
      })),
    );
    const snapshot = await loadTaskLaneSnapshot(registry);
    expect(snapshot.diagnostics).toEqual([
      { providerId: "boom", ok: false, error: "provider exploded" },
      { providerId: "fine", ok: true, laneCount: 1, itemCount: 1 },
    ]);
    expect(snapshot.lanes.map((entry) => entry.id)).toEqual(["fine"]);
  });

  it("reports unknown providers requested by id", async () => {
    const registry = createTaskLaneRegistry();
    const snapshot = await loadTaskLaneSnapshot(registry, { providerId: "ghost" });
    expect(snapshot.lanes).toEqual([]);
    expect(snapshot.diagnostics).toEqual([
      { providerId: "ghost", ok: false, error: "unknown provider" },
    ]);
  });

  it("scopes lane identity per provider when two providers share a lane id", async () => {
    const registry = createTaskLaneRegistry();
    registerTaskLaneProvider(
      registry,
      provider("alpha", async () => ({
        lanes: [lane("work", [{ id: "a1", title: "alpha task", state: "running" }])],
      })),
    );
    registerTaskLaneProvider(
      registry,
      provider("beta", async () => ({
        lanes: [lane("work", [{ id: "b1", title: "beta task", state: "succeeded" }])],
      })),
    );
    const snapshot = await loadTaskLaneSnapshot(registry);
    expect(snapshot.lanes).toHaveLength(2);
    for (const entry of snapshot.lanes) {
      expect(entry.id).toBe("work");
      expect(entry.items.map((item) => item.id)).toHaveLength(1);
    }
    expect(snapshot.lanes.flatMap((entry) => entry.items.map((item) => item.id)).sort()).toEqual([
      "a1",
      "b1",
    ]);
  });

  it("pages the newest-first flat item list and normalizes states", async () => {
    const registry = createTaskLaneRegistry();
    registerTaskLaneProvider(
      registry,
      provider("src", async () => ({
        lanes: [
          lane("src", [
            { id: "old", title: "old", state: "weird", startedAtMs: 100 },
            { id: "new", title: "new", state: "running", startedAtMs: 300 },
            { id: "mid", title: "mid", state: "succeeded", startedAtMs: 200 },
          ]),
        ],
      })),
    );
    const page1 = await loadTaskLaneSnapshot(registry, { limit: 2 });
    expect(page1.lanes[0]?.items.map((item) => item.id)).toEqual(["new", "mid"]);
    expect(page1.lanes[0]?.items.map((item) => item.state)).toEqual(["running", "succeeded"]);
    const page2 = await loadTaskLaneSnapshot(registry, { limit: 2, offset: 2 });
    expect(page2.lanes[0]?.items.map((item) => item.id)).toEqual(["old"]);
    expect(page2.lanes[0]?.items.map((item) => item.state)).toEqual(["unknown"]);
  });
});
