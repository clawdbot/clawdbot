export type PeripheryFinding = {
  ids: string[];
  kind: string;
  location: string;
  name: string;
  hints?: string[];
  [key: string]: unknown;
};

export type PeripheryIntersectionOptions = {
  iosResults: string;
  iosStatus: string;
  macosResults: string;
  macosStatus: string;
  output: string;
};

export function parseArgs(args: string[]): PeripheryIntersectionOptions;
export function validateFindings(value: unknown, label: string): PeripheryFinding[];
export function intersectFindings(iosFindings: unknown, macosFindings: unknown): PeripheryFinding[];
export function parseRepoLocation(location: string): {
  column: string;
  file: string;
  line: string;
};
export function filterIgnoredFindings(
  findings: PeripheryFinding[],
  repoRoot?: string,
): PeripheryFinding[];
export function escapeCommandData(value: unknown): string;
export function escapeCommandProperty(value: unknown): string;
export function formatAnnotation(finding: PeripheryFinding): string;
export function buildSummary(findings: PeripheryFinding[]): string;
export function run(args: string[], env?: NodeJS.ProcessEnv): number;
