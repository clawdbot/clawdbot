// Qa Lab plugin module resolves evidence runtime metadata.
import { execFileSync } from "node:child_process";

// A wedged git (NFS hang, credential helper prompt) must not block evidence
// metadata resolution; the caller already falls back to GITHUB_SHA/null.
const QA_EVIDENCE_GIT_PROBE_TIMEOUT_MS = 5_000;

function resolveQaEvidenceCheckoutRef(repoRoot?: string) {
  try {
    const ref = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: repoRoot ?? process.cwd(),
      encoding: "utf8",
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: QA_EVIDENCE_GIT_PROBE_TIMEOUT_MS,
    }).trim();
    return ref || undefined;
  } catch {
    return undefined;
  }
}

export function resolveQaEvidenceEnvironment(params: {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
}) {
  return {
    // GitHub's GITHUB_SHA describes the workflow event, not necessarily the
    // checked-out ref selected by a manual or remote QA run.
    ref:
      params.env?.OPENCLAW_QA_REF?.trim() ||
      resolveQaEvidenceCheckoutRef(params.repoRoot) ||
      params.env?.GITHUB_SHA?.trim() ||
      null,
    os: process.platform,
    nodeVersion: process.version,
  };
}
