// Task-lane protocol schema + validator behavior.
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { validateTaskLaneListParams } from "../index.js";
import { TaskLaneSnapshotSchema } from "./task-lanes.js";

/** Validator regressions for the read-only taskLanes.list RPC payloads. */
describe("task-lane protocol", () => {
  it("accepts empty and scoped list params", () => {
    expect(validateTaskLaneListParams({})).toBe(true);
    expect(validateTaskLaneListParams({ providerId: "cron" })).toBe(true);
    expect(validateTaskLaneListParams({ providerId: "json-file", limit: 50, offset: 0 })).toBe(
      true,
    );
  });

  it("rejects malformed list params", () => {
    expect(validateTaskLaneListParams({ providerId: "Bad Id" })).toBe(false);
    expect(validateTaskLaneListParams({ providerId: "" })).toBe(false);
    expect(validateTaskLaneListParams({ limit: 0 })).toBe(false);
    expect(validateTaskLaneListParams({ limit: 201 })).toBe(false);
    expect(validateTaskLaneListParams({ offset: -1 })).toBe(false);
    expect(validateTaskLaneListParams({ unknownField: 1 })).toBe(false);
  });

  it("accepts a minimal valid snapshot payload", () => {
    const snapshot = {
      lanes: [
        {
          id: "cron",
          label: "Cron runs",
          items: [{ id: "run-1", title: "Nightly digest", state: "succeeded" }],
        },
      ],
      diagnostics: [{ providerId: "cron", ok: true, laneCount: 1, itemCount: 1 }],
    };
    expect(Value.Check(TaskLaneSnapshotSchema, snapshot)).toBe(true);
    expect(
      Value.Check(TaskLaneSnapshotSchema, {
        lanes: [],
        diagnostics: [{ providerId: "broken", ok: false, error: "boom" }],
      }),
    ).toBe(true);
  });

  it("accepts source-omission fields on a provider diagnostic so truncation is visible on the wire", () => {
    // A provider that dropped lanes/items at its own count caps must be
    // able to publish the omission counts so the UI can surface a
    // truncation chip instead of a silently-cropped snapshot.
    expect(
      Value.Check(TaskLaneSnapshotSchema, {
        lanes: [],
        diagnostics: [
          {
            providerId: "big",
            ok: true,
            laneCount: 20,
            itemCount: 200,
            omittedLanes: 5,
            omittedItems: 12,
          },
        ],
      }),
    ).toBe(true);
  });

  it("rejects negative omission counts on a provider diagnostic", () => {
    // Counts come from arithmetic on observed lengths; a negative value
    // means the producer miscounted and the closed schema must reject it.
    expect(
      Value.Check(TaskLaneSnapshotSchema, {
        lanes: [],
        diagnostics: [
          { providerId: "big", ok: true, laneCount: 1, itemCount: 1, omittedLanes: -1 },
        ],
      }),
    ).toBe(false);
  });

  it("rejects snapshot payloads with unknown fields or invalid states", () => {
    expect(
      Value.Check(TaskLaneSnapshotSchema, {
        lanes: [
          {
            id: "cron",
            label: "Cron runs",
            items: [{ id: "run-1", title: "t", state: "exploded" }],
          },
        ],
        diagnostics: [],
      }),
    ).toBe(false);
    expect(
      Value.Check(TaskLaneSnapshotSchema, {
        lanes: [
          {
            id: "cron",
            label: "Cron runs",
            items: [{ id: "run-1", title: "t", state: "ok", unexpected: true }],
          },
        ],
        diagnostics: [],
      }),
    ).toBe(false);
    expect(
      Value.Check(TaskLaneSnapshotSchema, {
        lanes: [],
        diagnostics: [{ providerId: "broken", ok: false }],
      }),
    ).toBe(false);
  });
});
