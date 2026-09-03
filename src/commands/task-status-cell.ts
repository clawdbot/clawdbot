import { theme } from "../../packages/terminal-core/src/theme.js";

export const TASK_STATUS_CELL_WIDTH = 10;

export function formatTaskStatusCell(status: string, rich: boolean): string {
  const padded = status.padEnd(TASK_STATUS_CELL_WIDTH);
  if (!rich) {
    return padded;
  }
  if (status === "succeeded") {
    return theme.success(padded);
  }
  if (status === "failed" || status === "lost" || status === "timed_out") {
    return theme.error(padded);
  }
  if (status === "running") {
    return theme.accentBright(padded);
  }
  if (status === "blocked") {
    return theme.warn(padded);
  }
  return theme.muted(padded);
}
