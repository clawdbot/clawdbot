import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { runCommandWithTimeout } from "../process/exec.js";

type GitSourceFailure = {
  action: "clone" | "checkout" | "resolve ref" | "resolve commit for";
  stdout: string;
  stderr: string;
};

/** Acquires a tree; callers retain source policy and ownership of its staging directory. */
export async function acquireGitSource(params: {
  url: string;
  label: string;
  repoDir: string;
  ref?: string;
  refMode: "detached" | "resolve-remote" | "shallow-branch";
  timeoutMs?: number;
  commandEnv?: () => { baseEnv?: NodeJS.ProcessEnv; env?: NodeJS.ProcessEnv };
  cloneSeparator?: boolean;
  recordCommit?: boolean;
  formatFailure?: (failure: GitSourceFailure) => string;
  cleanupOnFailure?: () => Promise<void>;
}): Promise<{ ok: true; commit?: string } | { ok: false; error: string }> {
  const run = (argv: string[], cwd?: string) =>
    runCommandWithTimeout(argv, {
      ...params.commandEnv?.(),
      ...(cwd ? { cwd } : {}),
      timeoutMs: params.timeoutMs ?? 120_000,
    });
  const failure = async (details: GitSourceFailure) => {
    await params.cleanupOnFailure?.();
    if (params.formatFailure) {
      return { ok: false as const, error: params.formatFailure(details) };
    }
    const safe = (value: string) => sanitizeForLog(redactSensitiveUrlLikeString(value));
    const label = safe(params.label);
    const ref = safe(params.ref ?? "");
    const detail = safe(details.stderr.trim() || details.stdout.trim() || "git failed");
    return {
      ok: false as const,
      error:
        details.action === "resolve ref"
          ? `failed to resolve ref ${ref} in ${label}`
          : `failed to ${details.action}${details.action === "checkout" ? ` ${params.ref}` : ""} ${label}: ${detail}`,
    };
  };

  const argv = ["git", "clone"];
  if (!params.ref || params.refMode === "shallow-branch") {
    argv.push("--depth", "1");
  }
  if (params.ref && params.refMode === "shallow-branch") {
    argv.push("--branch", params.ref);
  }
  if (params.cloneSeparator !== false) {
    argv.push("--");
  }
  argv.push(params.url, params.repoDir);
  const clone = await run(argv);
  if (clone.code !== 0) {
    return await failure({ action: "clone", ...clone });
  }

  if (params.ref && params.refMode !== "shallow-branch") {
    let checkoutRef = params.ref;
    if (params.refMode === "resolve-remote") {
      const candidates = params.ref.startsWith("origin/")
        ? [params.ref]
        : [params.ref, `origin/${params.ref}`];
      let commitish: string | undefined;
      for (const candidate of candidates) {
        const resolved = await run(
          ["git", "rev-parse", "--verify", "--quiet", `${candidate}^{commit}`],
          params.repoDir,
        );
        const commit = normalizeOptionalString(resolved.stdout);
        if (resolved.code === 0 && commit) {
          commitish = commit;
          break;
        }
      }
      if (!commitish) {
        return await failure({ action: "resolve ref", stdout: "", stderr: "" });
      }
      checkoutRef = commitish;
    }
    const checkout = await run(["git", "switch", "--detach", "--", checkoutRef], params.repoDir);
    if (checkout.code !== 0) {
      return await failure({ action: "checkout", ...checkout });
    }
  }

  if (params.recordCommit === false) {
    return { ok: true };
  }
  const rev = await run(["git", "rev-parse", "HEAD"], params.repoDir);
  if (rev.code !== 0) {
    return await failure({ action: "resolve commit for", ...rev });
  }
  return { ok: true, commit: normalizeOptionalString(rev.stdout) };
}
