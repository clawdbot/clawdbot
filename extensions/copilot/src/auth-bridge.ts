import { createHash } from "node:crypto";
import { homedir as osHomedir } from "node:os";
import { join, normalize, resolve, sep } from "node:path";

/**
 * Pure functional auth resolver for the copilot agent runtime.
 *
 * Scope:
 *
 *   - Consumes the resolved auth signals that core's harness contract
 *     already carries on `EmbeddedRunAttemptParams` (=
 *     `AgentHarnessAttemptParams`): `resolvedApiKey`, `authProfileId`,
 *     `authProfileIdSource`. Core resolves these from the agent's
 *     `AuthProfileStore` via `provider-usage.auth.ts:resolveProviderAuths`
 *     before invoking the harness, so the harness does not re-perform
 *     the lookup (and could not, due to the package boundary in
 *     `tsconfig.package-boundary.base.json`).
 *   - Reads optional explicit overrides from the harness attempt params
 *     (`auth.useLoggedInUser`, `auth.gitHubToken`) for direct CLI / test
 *     use cases.
 *   - Falls back to OPENCLAW_GITHUB_TOKEN, COPILOT_GITHUB_TOKEN,
 *     GH_TOKEN, or GITHUB_TOKEN env vars (in that precedence) when
 *     no contract-resolved token is given; synthesises a stable,
 *     non-reversible pool fingerprint so token rotation busts the
 *     client pool cleanly.
 *   - Computes a per-agent `copilotHome` default
 *     (`<openClawHome>/.openclaw/agents/<agentId>/copilot`, or
 *     `<agentDir>/copilot` when an agent directory is supplied) that
 *     respects `OPENCLAW_HOME` for the home directory root.
 *   - Defaults to `useLoggedInUser` when no token signal is available.
 *
 * Precedence (highest to lowest):
 *   1. `auth.useLoggedInUser === true` (explicit user opt-in)
 *   2. `auth.gitHubToken` (explicit override; requires
 *      `profileId` + `profileVersion`)
 *   3. `resolvedApiKey` + `authProfileId` from the contract (core's
 *      AuthProfileStore-resolved token — the production main path for
 *      a configured `github-copilot` auth profile)
 *   4. OPENCLAW_GITHUB_TOKEN, then COPILOT_GITHUB_TOKEN, then
 *      GH_TOKEN, then GITHUB_TOKEN env vars (mirrors the
 *      shipped `github-copilot` provider precedence so headless
 *      users who already follow the documented
 *      COPILOT_GITHUB_TOKEN / GH_TOKEN setup get the token they
 *      configured rather than silently falling through to the
 *      logged-in CLI user.)
 *   5. `useLoggedInUser` (default)
 */

export const COPILOT_TOKEN_PROFILE_ERROR =
  "[copilot-attempt] gitHubToken auth requires profileId+profileVersion (pool keying safety; per Q5/Q1 decisions)";

export const COPILOT_DEFAULT_AGENT_ID = "copilot";

/** Resolved auth shape that the runtime / pool consumes. */
export interface ResolvedCopilotAuth {
  authMode: "useLoggedInUser" | "gitHubToken";
  /** Present only when authMode is "gitHubToken". */
  gitHubToken?: string;
  /** Present only when authMode is "gitHubToken". */
  authProfileId?: string;
  /** Present only when authMode is "gitHubToken". */
  authProfileVersion?: string;
  /** Absolute, normalized path. */
  copilotHome: string;
  /** Validated agent id used for path defaults and pool keying. */
  agentId: string;
}

export interface ResolveCopilotAuthInput {
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  copilotHome?: string;
  auth?: {
    gitHubToken?: string;
    useLoggedInUser?: boolean;
    profileId?: string;
    profileVersion?: string;
  };
  /**
   * Contract-resolved token from core's AuthProfileStore lookup,
   * carried on `EmbeddedRunAttemptParams.resolvedApiKey`. Used as the
   * production main path when the agent has a configured
   * `github-copilot` auth profile.
   */
  resolvedApiKey?: string;
  /**
   * Contract-resolved auth profile id, carried on
   * `EmbeddedRunAttemptParams.authProfileId`. Used for pool keying so
   * concurrent agents with distinct profiles do not share a CLI
   * session/state.
   */
  authProfileId?: string;
  /**
   * Legacy top-level `profileVersion` fallback kept for back-compat
   * with explicit-token (`auth.gitHubToken`) callers. The
   * contract-resolved `resolvedApiKey` path synthesises a version from
   * the token fingerprint because `EmbeddedRunAttemptParams` does not
   * carry a `profileVersion` field.
   */
  profileVersion?: string;
  /** Injected for test seams. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Injected for test seams. Defaults to `os.homedir()`. */
  homeDir?: () => string;
}

/**
 * Resolve copilot auth + copilotHome.
 *
 * Synchronous because we intentionally do not perform any I/O or
 * cross-package credential lookups here (see file header for rationale).
 *
 * Throws if `gitHubToken` is supplied via `params.auth.gitHubToken`
 * WITHOUT both `profileId` and `profileVersion` (the existing invariant
 * from attempt.ts; preserves pool-key safety per Q5/Q1).
 */
export function resolveCopilotAuth(input: ResolveCopilotAuthInput): ResolvedCopilotAuth {
  const env = input.env ?? process.env;
  const homeDir = input.homeDir ?? osHomedir;

  const agentId = sanitizeAgentId(input.agentId);
  const copilotHome = resolveCopilotHome({
    explicit: readString(input.copilotHome),
    agentDir: readString(input.agentDir),
    workspaceDir: readString(input.workspaceDir),
    agentId,
    env,
    homeDir,
  });

  const explicitToken = readString(input.auth?.gitHubToken);
  const explicitProfileId = readString(input.auth?.profileId) ?? readString(input.authProfileId);
  const explicitProfileVersion =
    readString(input.auth?.profileVersion) ?? readString(input.profileVersion);

  if (input.auth?.useLoggedInUser === true) {
    return {
      authMode: "useLoggedInUser",
      copilotHome,
      agentId,
    };
  }

  if (explicitToken) {
    if (!explicitProfileId || !explicitProfileVersion) {
      throw new Error(COPILOT_TOKEN_PROFILE_ERROR);
    }
    return {
      authMode: "gitHubToken",
      gitHubToken: explicitToken,
      authProfileId: explicitProfileId,
      authProfileVersion: explicitProfileVersion,
      copilotHome,
      agentId,
    };
  }

  // Contract-resolved token from core's AuthProfileStore lookup. This
  // is the production main path: a configured `github-copilot` auth
  // profile flows into `EmbeddedRunAttemptParams.resolvedApiKey` and
  // `authProfileId` upstream of the harness, and we consume both here
  // so headless / cron / multi-profile runs work without env vars.
  // We synthesise the pool-key version from the token fingerprint so
  // rotation busts the cache cleanly (matching the env-fallback
  // strategy). The contract does not carry a separate `profileVersion`.
  const contractToken = readString(input.resolvedApiKey);
  if (contractToken) {
    const contractProfileId = readString(input.authProfileId);
    return {
      authMode: "gitHubToken",
      gitHubToken: contractToken,
      authProfileId: contractProfileId ?? "pi:resolved",
      authProfileVersion: tokenFingerprint(contractToken),
      copilotHome,
      agentId,
    };
  }

  const envFallback = readEnvTokenFallback(env);
  if (envFallback) {
    return {
      authMode: "gitHubToken",
      gitHubToken: envFallback.token,
      authProfileId: envFallback.profileId,
      authProfileVersion: envFallback.profileVersion,
      copilotHome,
      agentId,
    };
  }

  return {
    authMode: "useLoggedInUser",
    copilotHome,
    agentId,
  };
}

/**
 * Validate + sanitise an agent id for use in filesystem paths and pool
 * keys.
 *
 * Mirrors the shape constraints documented by core's `normalizeAgentId`
 * / `isValidAgentId` in `src/routing/session-key.ts` (alnum + `-_`,
 * starts with alnum, lowercase, <=64 chars). We re-implement here
 * because the package boundary prevents importing from `src/`. Any
 * caller that passes an invalid id falls back to the shared default
 * (`COPILOT_DEFAULT_AGENT_ID`) rather than throwing - the harness's
 * job is to keep running with a safe default, not to validate config.
 */
export function sanitizeAgentId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (!trimmed) {
    return COPILOT_DEFAULT_AGENT_ID;
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(trimmed)) {
    return COPILOT_DEFAULT_AGENT_ID;
  }
  return trimmed;
}

function resolveCopilotHome(args: {
  explicit: string | undefined;
  agentDir: string | undefined;
  workspaceDir: string | undefined;
  agentId: string;
  env: NodeJS.ProcessEnv;
  homeDir: () => string;
}): string {
  if (args.explicit) {
    return resolve(args.explicit);
  }
  // When the host hands us an agent directory we isolate the SDK CLI state
  // (config.json, logs/, session-store.db, session-state/) under a dedicated
  // "copilot" subdir so it cannot collide with OpenClaw's own files
  // (models.json, auth-profiles.json, ...) in the same agent directory.
  // This matches the documented layout and mirrors how the codex harness
  // isolates `<agentDir>/codex-home/`.
  if (args.agentDir) {
    return resolve(join(args.agentDir, "copilot"));
  }

  const openClawHome = readString(args.env.OPENCLAW_HOME);
  const rootHome = openClawHome ? resolve(openClawHome) : safeHomeDir(args.homeDir);
  // Per-agent isolation per proposal section 3.6:
  //   <openClawHome>/.openclaw/agents/<agentId>/copilot
  return resolve(join(rootHome, ".openclaw", "agents", args.agentId, "copilot"));
}

function safeHomeDir(homeDir: () => string): string {
  try {
    const value = homeDir();
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  } catch {
    // fall through
  }
  return process.cwd();
}

function readEnvTokenFallback(
  env: NodeJS.ProcessEnv,
): { token: string; profileId: string; profileVersion: string } | undefined {
  // OPENCLAW_GITHUB_TOKEN is the harness-specific override and stays at
  // the top so operators can pin a token without disturbing system-wide
  // gh / Copilot CLI config. The remaining entries mirror the shipped
  // `github-copilot` provider precedence
  // (COPILOT_GITHUB_TOKEN -> GH_TOKEN -> GITHUB_TOKEN, see
  // extensions/github-copilot/auth.ts:24) and the documented Copilot SDK
  // setup in docs/providers/github-copilot.md, so a headless user who
  // already configured COPILOT_GITHUB_TOKEN / GH_TOKEN and opted into
  // agentRuntime.id: "copilot" gets the token they configured rather
  // than silently falling through to the logged-in CLI user.
  const candidates: Array<{ name: string; value: string | undefined }> = [
    { name: "OPENCLAW_GITHUB_TOKEN", value: readString(env.OPENCLAW_GITHUB_TOKEN) },
    { name: "COPILOT_GITHUB_TOKEN", value: readString(env.COPILOT_GITHUB_TOKEN) },
    { name: "GH_TOKEN", value: readString(env.GH_TOKEN) },
    { name: "GITHUB_TOKEN", value: readString(env.GITHUB_TOKEN) },
  ];
  for (const { name, value } of candidates) {
    if (value) {
      return {
        token: value,
        profileId: `env:${name}`,
        profileVersion: tokenFingerprint(value),
      };
    }
  }
  return undefined;
}

/**
 * Non-reversible 12-hex-char fingerprint of a token, prefixed with
 * `sha256:` for forward-compat. Used as the pool-key profileVersion when
 * a token comes from env: rotation -> different fingerprint -> pool
 * entry invalidated cleanly. 48 bits of entropy is sufficient
 * collision resistance for a per-agent client pool; never log the
 * fingerprint alongside an account id.
 */
export function tokenFingerprint(token: string): string {
  const hex = createHash("sha256").update(token).digest("hex").slice(0, 12);
  return `sha256:${hex}`;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Normalize a copilotHome path for cross-platform pool keying.
 * Re-exported so attempt.ts / runtime.ts can share the same
 * normalization without re-implementing.
 */
export function normalizeCopilotHomePath(value: string): string {
  return normalize(resolve(value)).replace(new RegExp(`${escapeForRegex(sep)}+$`), "");
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
