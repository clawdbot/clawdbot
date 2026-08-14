import { describe, expect, it, vi } from "vitest";
import { wrapStreamFnWithCompactionReplayRepair } from "./attempt-stream.js";

describe("wrapStreamFnWithCompactionReplayRepair", () => {
  it("repairs before preserving an existing rejection observer", () => {
    const order: string[] = [];
    const checkpoints: unknown[] = [];
    const checkpoint = { id: "cmp_rejected", data: "rejected-ciphertext" };
    const streamFn = vi.fn(() => undefined as never);
    const wrapped = wrapStreamFnWithCompactionReplayRepair(streamFn, (value) => {
      order.push("repair");
      checkpoints.push(value);
    });

    wrapped({} as never, { messages: [] }, {
      onCompactionRejected: (value: unknown) => {
        order.push("existing");
        checkpoints.push(value);
      },
    } as never);
    const options = streamFn.mock.calls[0]?.[2] as
      | { onCompactionRejected?: (value: typeof checkpoint) => void }
      | undefined;
    options?.onCompactionRejected?.(checkpoint);

    expect(order).toEqual(["repair", "existing"]);
    expect(checkpoints).toEqual([checkpoint, checkpoint]);
  });
});
