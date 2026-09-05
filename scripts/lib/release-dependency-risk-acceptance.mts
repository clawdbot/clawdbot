import type { runDependencyVulnerabilityGate } from "../dependency-vulnerability-gate.mts";

type Blocker = Awaited<ReturnType<typeof runDependencyVulnerabilityGate>>["blockers"][number];

// Maintainer accepted these existing dependency risks for 2026.9.1 without
// dependency updates. Exact graph bytes and findings prevent this decision
// from admitting another release, a changed graph, or an additional advisory.
export const RELEASE_DEPENDENCY_RISK_LOCKFILES = {
  "pnpm-lock.yaml": "60ec3478d55f958efd41f314b32e0975a5becb4e0a90216c3cf9f9c6365e1443",
  ".github/release/vercel-cli/package-lock.json":
    "b06b20bca67a863ad99cb479d51319b3483fb131b57c6855c26a35a92c2c89b5",
  ".github/release/clawhub-cli/package-lock.json":
    "adc9d3613a752dfe00597a8826f45fab82e7651478d16ba1bf5354369157fee9",
};

const acceptedFindings = new Set([
  "pnpm-lock.yaml|fast-uri|GHSA-58mr-gqgx-xq4g|4.1.3",
  "pnpm-lock.yaml|fast-uri|GHSA-qw65-cvwx-89v3|4.1.3",
  ".github/release/vercel-cli/package-lock.json|fast-uri|GHSA-58mr-gqgx-xq4g|3.1.6",
  ".github/release/vercel-cli/package-lock.json|fast-uri|GHSA-qw65-cvwx-89v3|3.1.6",
  "pnpm-lock.yaml|nodemailer|GHSA-2x7j-588g-ccc2|9.0.4,9.0.5",
]);

export function resolveReleaseDependencyRiskAcceptance(params: {
  packageVersion: string;
  lockfileSha256: Record<string, string>;
  blockers: Blocker[];
}) {
  const { packageVersion, lockfileSha256, blockers } = params;
  const keys = blockers.map(
    (finding) =>
      `${finding.lockfile}|${finding.packageName}|${finding.id}|${(finding.matchedVersions ?? []).toSorted().join(",")}`,
  );
  if (
    packageVersion !== "2026.9.1" ||
    Object.entries(RELEASE_DEPENDENCY_RISK_LOCKFILES).some(
      ([file, digest]) => lockfileSha256[file] !== digest,
    ) ||
    keys.length !== acceptedFindings.size ||
    new Set(keys).size !== acceptedFindings.size ||
    keys.some((key) => !acceptedFindings.has(key)) ||
    blockers.some(
      (finding) => finding.severity !== "high" || finding.malware || finding.graph !== "production",
    )
  ) {
    return null;
  }
  return {
    kind: "operator-accepted-dependency-risk" as const,
    packageVersion,
    acceptedOn: "2026-09-02",
    decision:
      "Release with unchanged dependencies; retain known advisory findings as accepted risk.",
    lockfileSha256,
    blockers,
  };
}
