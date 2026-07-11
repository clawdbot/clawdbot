export function buildTestboxLeaseFingerprint(
  repoRoot: unknown,
  args: unknown,
): {
  version: number;
  baseSha: string;
  headSha: string;
  workingTreeClean: boolean;
  dependencyDigest: string;
  environmentDigest: string;
  workflow: unknown;
  job: unknown;
  ref: unknown;
};
export function testboxLeaseStaleReasons(saved: unknown, current: unknown): string[];
export function prepareTestboxLeaseFreshness({
  args,
  env,
  provider,
  repoRoot,
}: {
  args: unknown;
  env: unknown;
  provider: unknown;
  repoRoot: unknown;
}): {
  current: {
    version: number;
    baseSha: string;
    headSha: string;
    workingTreeClean: boolean;
    dependencyDigest: string;
    environmentDigest: string;
    workflow: unknown;
    job: unknown;
    ref: unknown;
  };
  path: string;
} | null;
export function recordTestboxLeaseFreshness(prepared: unknown): void;
