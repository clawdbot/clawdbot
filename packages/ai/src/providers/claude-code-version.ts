// Resolves the installed Claude Code CLI version for OAuth user-agent headers.
//
// The user-agent header on every Anthropic OAuth request is `claude-cli/<version>`,
// where `<version>` MUST match the installed @anthropic-ai/claude-code package.
// A stale version causes Anthropic OAuth to reject the bearer request (#94716).
//
// Resolution strategy (tried in order, result cached for process lifetime):
//   1. OpenClaw module graph — createRequire(import.meta.url) walks OpenClaw's
//      own node_modules tree. Covers standard npm/pnpm installs where
//      @anthropic-ai/claude-code is a resolvable dependency of openclaw.
//   2. CLI binary on PATH — runs `claude --version` as a last-resort fallback.
//      Covers documented external/custom Claude CLI setups where the binary
//      exists on PATH but @anthropic-ai/claude-code is not in OpenClaw's
//      module graph (e.g. global npm install, nvm, custom claude command).
//      Called at most once per process (result is cached); not on the request path.
//
// This module never silently falls back to a stale hardcoded version. A stale
// fallback is exactly the failure mode #94716 reports; re-emitting the rejected
// value would preserve the production auth failure.
//
// The resolver is injectable via __setClaudeCodeVersionResolver so tests can
// run without depending on the host's global Node module graph or PATH.
//
// The version is resolved lazily on first call, never at module load — a
// module-load-time resolution would throw at import time in any environment
// where neither strategy succeeds yet (e.g. a fresh checkout before the CLI
// is installed), which is worse than a deferred, call-time error.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

// Resolver type. Returns the resolved version string, or `null` to signal
// "not resolvable from this source". Throws to signal a hard error.
// Both null and throw are treated as configuration errors.
export type ClaudeCodeVersionResolver = () => string | null;

// Process-stable version cache. Populated on first call to resolveClaudeCodeVersion().
// Cleared by __setClaudeCodeVersionResolver / __resetClaudeCodeVersionResolver
// for test isolation (tests that swap the resolver also get a fresh resolution).
let _versionCache: string | null = null;

function resolveFromModuleGraph(): string | null {
  try {
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve("@anthropic-ai/claude-code/package.json");
    const raw = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    if (typeof raw.version === "string" && /^\d/.test(raw.version)) {
      return raw.version;
    }
  } catch {
    // @anthropic-ai/claude-code not resolvable from OpenClaw's module graph.
    // Fall through to the PATH-based strategy.
  }
  return null;
}

function resolveFromCLIBinary(): string | null {
  // Covers external/custom Claude CLI setups: global npm install, nvm,
  // configured claude command path. The subprocess is cheap (single --version
  // flag) and only runs when the module-graph strategy fails. Result is cached.
  try {
    const out = execFileSync("claude", ["--version"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    // `claude --version` outputs something like "2.1.177" or "Claude Code 2.1.177"
    const m = out.trim().match(/(\d[\d.]+)/);
    if (m?.[1]) return m[1];
  } catch {
    // claude not on PATH or --version failed.
  }
  return null;
}

// Default resolver: multi-strategy, result is cached by resolveClaudeCodeVersion().
const defaultClaudeCodeVersionResolver: ClaudeCodeVersionResolver = () => {
  return resolveFromModuleGraph() ?? resolveFromCLIBinary();
};

let _resolver: ClaudeCodeVersionResolver = defaultClaudeCodeVersionResolver;

export function __setClaudeCodeVersionResolver(next: ClaudeCodeVersionResolver): void {
  _resolver = next;
  _versionCache = null;
}

export function __resetClaudeCodeVersionResolver(): void {
  _resolver = defaultClaudeCodeVersionResolver;
  _versionCache = null;
}

// Returns the validated Claude Code version, cached for the process lifetime.
// Throws on first call if neither resolution strategy succeeds — never returns
// a stale fallback.
export function resolveClaudeCodeVersion(): string {
  if (_versionCache !== null) return _versionCache;

  let result: string | null;
  try {
    result = _resolver();
  } catch (cause) {
    throw new Error(
      "Failed to resolve Claude Code version. " +
        "Install @anthropic-ai/claude-code or ensure the claude binary is on PATH.",
      { cause },
    );
  }
  if (typeof result !== "string" || result.length === 0 || !/^\d/.test(result)) {
    throw new Error(
      `Claude Code version resolver returned an invalid value: ${JSON.stringify(result)}. ` +
        "Expected a digit-leading non-empty semver-ish string. " +
        "Install @anthropic-ai/claude-code or ensure the claude binary is on PATH.",
    );
  }
  _versionCache = result;
  return result;
}
