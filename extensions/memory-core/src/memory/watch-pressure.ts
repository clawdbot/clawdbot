// Memory Core plugin module implements watch pressure behavior.
import type { FSWatcher } from "chokidar";

const MEMORY_WATCH_PRESSURE_WARNING_THRESHOLD = 2_000;

export type MemoryWatchPressureUnit = "directories" | "paths";

export type MemoryWatchPressureWarningState = {
  shown: boolean;
};

export function countChokidarWatchedEntries(watcher: FSWatcher): number {
  const watched = watcher.getWatched();
  let count = Object.keys(watched).length;
  for (const entries of Object.values(watched)) {
    count += entries.length;
  }
  return count;
}

export function warnIfMemoryWatchPressureHigh(
  state: MemoryWatchPressureWarningState,
  count: number,
  unit: MemoryWatchPressureUnit,
  pressureDetail: string,
  remediation: string,
  warn: (message: string) => void,
): boolean {
  if (state.shown || count <= MEMORY_WATCH_PRESSURE_WARNING_THRESHOLD) {
    return false;
  }
  state.shown = true;
  warn(`Memory file watching is tracking ${count} ${unit}. ${pressureDetail} ${remediation}`);
  return true;
}
