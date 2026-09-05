// taskLanes.list handler behavior: param validation gate + snapshot passthrough.
import { describe, expect, it, vi } from "vitest";
import { taskLanesHandlers } from "./task-lanes.js";

type TaskLanesListHandler = NonNullable<(typeof taskLanesHandlers)["taskLanes.list"]>;
type HandlerOptions = Parameters<TaskLanesListHandler>[0];

function createHarness(snapshotImpl?: (options: unknown) => Promise<unknown>) {
  const respond = vi.fn();
  const snapshot = vi.fn(snapshotImpl ?? (async () => ({ lanes: [], diagnostics: [] })));
  const handler = taskLanesHandlers["taskLanes.list"]!;
  const call = (params: unknown) =>
    handler({
      params,
      respond,
      context: { taskLanes: { snapshot } },
    } as unknown as HandlerOptions);
  return { respond, snapshot, call };
}

describe("taskLanes.list handler", () => {
  it("passes validated params through to the registry snapshot", async () => {
    const payload = {
      lanes: [],
      diagnostics: [{ providerId: "cron", ok: true, laneCount: 1, itemCount: 2 }],
    };
    const harness = createHarness(async () => payload);
    await harness.call({ providerId: "cron", limit: 10, offset: 5 });
    expect(harness.snapshot).toHaveBeenCalledWith({
      providerId: "cron",
      limit: 10,
      offset: 5,
    });
    expect(harness.respond).toHaveBeenCalledWith(true, payload, undefined);
  });

  it("defaults omitted params to undefined and responds with the snapshot", async () => {
    const harness = createHarness();
    await harness.call({});
    expect(harness.snapshot).toHaveBeenCalledWith({
      providerId: undefined,
      limit: undefined,
      offset: undefined,
    });
    expect(harness.respond).toHaveBeenCalledWith(true, { lanes: [], diagnostics: [] }, undefined);
  });

  it("rejects out-of-range params without touching providers", async () => {
    const harness = createHarness();
    await harness.call({ limit: 0 });
    expect(harness.snapshot).not.toHaveBeenCalled();
    expect(harness.respond).toHaveBeenCalledTimes(1);
    const [ok, payload, error] = harness.respond.mock.calls[0]!;
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error).toBeDefined();
  });
});
