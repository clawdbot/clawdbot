import { describe, expect, it, vi } from "vitest";
import { runOwnedUpdateSteps } from "./owned-update-steps.js";

function step(name: string, options: { fail?: Error; rollback?: () => Promise<void> } = {}) {
  const rollback = vi.fn(options.rollback ?? (async () => undefined));
  const apply = vi.fn(async () => ({ appliedIds: [name], rollback }));
  return { name, rollback, apply, options };
}

const partial = (message: string) => new Error(`partial: ${message}`);
const fail = (code: string, message: string) => new Error(`fail ${code}: ${message}`);

describe("runOwnedUpdateSteps", () => {
  it("applies steps in order and registers their rollback handles", async () => {
    const first = step("first");
    const second = step("second");
    const executed = await runOwnedUpdateSteps(
      [
        {
          name: first.name,
          apply: first.apply,
          onError: () => ({ kind: "fail", code: "x", message: "x" }),
        },
        {
          name: second.name,
          apply: second.apply,
          onError: () => ({ kind: "fail", code: "x", message: "x" }),
        },
      ],
      { fail, partial },
    );
    expect(executed.get("first")?.appliedIds).toEqual(["first"]);
    expect(second.apply).toHaveBeenCalled();
  });

  it("rolls predecessors back in declaration order when a step fails", async () => {
    const first = step("first");
    const second = step("second");
    const failing = {
      ...step("failing"),
      apply: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    await expect(
      runOwnedUpdateSteps(
        [
          {
            name: first.name,
            apply: first.apply,
            onError: () => ({ kind: "fail", code: "x", message: "x" }),
          },
          {
            name: second.name,
            apply: second.apply,
            onError: () => ({ kind: "fail", code: "x", message: "x" }),
          },
          {
            name: failing.name,
            apply: failing.apply,
            rollbackAfter: ["second", "first"],
            onError: () => ({ kind: "fail", code: "boom", message: "boom" }),
          },
        ],
        { fail, partial },
      ),
    ).rejects.toThrow("fail boom: boom");
    expect(first.rollback).toHaveBeenCalledOnce();
    expect(second.rollback).toHaveBeenCalledOnce();
    expect(first.rollback.mock.invocationCallOrder[0]!).toBeGreaterThan(
      second.rollback.mock.invocationCallOrder[0]!,
    );
  });

  it("runs ownRollback before predecessor rollbacks", async () => {
    const order: string[] = [];
    const first = step("first");
    const failing = {
      ...step("failing"),
      apply: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    await expect(
      runOwnedUpdateSteps(
        [
          {
            name: first.name,
            apply: first.apply,
            onError: () => ({ kind: "fail", code: "x", message: "x" }),
          },
          {
            name: failing.name,
            apply: failing.apply,
            ownRollback: async () => {
              order.push("own");
            },
            rollbackAfter: ["first"],
            onError: () => ({ kind: "fail", code: "boom", message: "boom" }),
          },
        ],
        { fail, partial },
      ),
    ).rejects.toThrow("fail boom");
    order.push("first");
    expect(order).toEqual(["own", "first"]);
  });

  it("reports retained requirements to later onError calls and skips rollback for partial outcomes", async () => {
    const first = step("first");
    const second = {
      ...step("second"),
      apply: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const onError = vi.fn(() => ({ kind: "partial" as const, message: "uncertain" }));
    await expect(
      runOwnedUpdateSteps(
        [
          {
            name: first.name,
            retainedOnApply: true,
            apply: first.apply,
            onError: () => ({ kind: "fail", code: "x", message: "x" }),
          },
          { name: second.name, apply: second.apply, rollbackAfter: ["first"], onError },
        ],
        { fail, partial },
      ),
    ).rejects.toThrow("partial: uncertain");
    expect(onError).toHaveBeenCalledWith(expect.anything(), { retainedRequirements: true });
    expect(first.rollback).not.toHaveBeenCalled();
  });

  it("aggregates rollback failures into a partial mutation", async () => {
    const first = step("first", {
      rollback: async () => {
        throw new Error("rollback exploded");
      },
    });
    const failing = {
      ...step("failing"),
      apply: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    await expect(
      runOwnedUpdateSteps(
        [
          {
            name: first.name,
            apply: first.apply,
            onError: () => ({ kind: "fail", code: "x", message: "x" }),
          },
          {
            name: failing.name,
            apply: failing.apply,
            rollbackAfter: ["first"],
            onError: () => ({ kind: "fail", code: "boom", message: "boom" }),
          },
        ],
        { fail, partial },
      ),
    ).rejects.toThrow("partial: boom; first rollback failed: rollback exploded");
  });
});
