/**
 * Formatting utilities for sandbox CLI output
 */

export function formatStatus(running: boolean): string {
  return running ? "🟢 running" : "⚫ stopped";
}

export function formatSimpleStatus(running: boolean): string {
  return running ? "running" : "stopped";
}

export function formatImageMatch(matches: boolean): string {
  return matches ? "✓" : "⚠️  mismatch";
}

/**
 * Type guard and counter utilities
 */

export type ContainerItem = {
  running: boolean;
  imageMatch: boolean;
  containerName: string;
  sessionKey: string;
  image: string;
  createdAtMs: number;
  lastUsedAtMs: number;
};

export function countRunning(items: readonly { running: boolean }[]): number {
  return items.filter((item) => item.running).length;
}

export function countMismatches(items: readonly { imageMatch: boolean }[]): number {
  return items.filter((item) => !item.imageMatch).length;
}
