export type CrabboxWorkload =
  | "ci-docker"
  | "ci-fast"
  | "ci-proof"
  | "desktop"
  | "interactive"
  | "release-proof"
  | "untrusted"
  | "windows";

export type CrabboxProviderReadiness = {
  ready: boolean;
  [key: string]: unknown;
};

export function normalizeCrabboxWorkload(value: unknown): CrabboxWorkload | "" | null;

export function crabboxWorkloadServerType(options: {
  workload: CrabboxWorkload | "";
  provider: string;
  target: string;
}): string;

export function crabboxWorkloadHydrateJob(options: {
  workload: CrabboxWorkload | "";
  target: string;
}): string;

export function crabboxProviderChain(options: {
  workload: CrabboxWorkload | "";
  configuredProvider: string;
  target: string;
  advertisedProviders: readonly string[];
}): string[];

export function selectReadyCrabboxProvider<T extends CrabboxProviderReadiness>(
  chain: readonly string[],
  readiness: ReadonlyMap<string, T>,
): { provider: string; readiness: T } | null;
