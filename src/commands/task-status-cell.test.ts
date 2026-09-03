import { describe, expect, it, vi } from "vitest";

vi.mock("../../packages/terminal-core/src/theme.js", () => ({
  theme: {
    success: (value: string) => `success(${value})`,
    error: (value: string) => `error(${value})`,
    accentBright: (value: string) => `accentBright(${value})`,
    warn: (value: string) => `warn(${value})`,
    muted: (value: string) => `muted(${value})`,
  },
}));

import { formatTaskStatusCell, TASK_STATUS_CELL_WIDTH } from "./task-status-cell.js";

describe("formatTaskStatusCell", () => {
  it.each(["succeeded", "timed_out", "blocked", "future_status"])(
    "pads plain %s status cells to the shared width",
    (status) => {
      expect(formatTaskStatusCell(status, false)).toBe(status.padEnd(TASK_STATUS_CELL_WIDTH));
    },
  );

  it.each([
    ["succeeded", "success"],
    ["failed", "error"],
    ["lost", "error"],
    ["timed_out", "error"],
    ["running", "accentBright"],
    ["blocked", "warn"],
    ["queued", "muted"],
    ["future_status", "muted"],
  ])("renders rich %s status cells with the %s theme", (status, marker) => {
    expect(formatTaskStatusCell(status, true)).toBe(
      `${marker}(${status.padEnd(TASK_STATUS_CELL_WIDTH)})`,
    );
  });
});
