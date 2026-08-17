import { randomInt } from "node:crypto";
// Inference backend detection shared by onboarding bootstrap and OpenClaw setup.
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { resolveAgentConfig } from "../agents/agent-scope-config.js";
import {
  formatCliBackendVersionAdvisory,
  resolveCliBackendVersionGuidance,
} from "../agents/cli-backend-version-support.js";
import { resolveCliBackendLiveSessionRequirement } from "../agents/cli-backends.js";
import {
  readClaudeCliCredentialsCached,
  readCodexCliCredentialsCached,
  readGeminiCliCredentialsCached,
} from "../agents/cli-credentials.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { probeLocalCommand, type LocalCommandProbe } from "../system-agent/probes.js";
import {
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  CODEX_APP_SERVER_DEFAULT_MODEL_REF,
  GEMINI_CLI_DEFAULT_MODEL_REF,
  detectAmbientInferenceBackends,
  type InferenceBackendCandidate,
  type InferenceBackendKind,
} from "./onboard-inference-ambient.js";

export {
  ANTHROPIC_API_DEFAULT_MODEL_REF,
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  CODEX_APP_SERVER_DEFAULT_MODEL_REF,
  GEMINI_CLI_DEFAULT_MODEL_REF,
  OPENAI_API_DEFAULT_MODEL_REF,
  type InferenceBackendKind,
} from "./onboard-inference-ambient.js";

/**
 * Onboarding treats inference as the one required step: reuse whatever the
 * machine already has (env API keys, Claude Code login, Codex login) before
 * asking the user anything. The ladder order is a documented contract
 * (docs/cli/setup.md "Setup bootstrap") — change docs when changing it.
 */

type DetectInferenceBackendsDeps = {
  probeLocalCommand?: typeof probeLocalCommand;
  readClaudeCliCredentials?: () => { type: string } | null;
  readCodexCliCredentials?: () => { type: string } | null;
  readGeminiCliCredentials?: () => { type: string } | null;
  detectCodexLoginState?: typeof detectCodexLoginState;
  randomInt?: (maxExclusive: number) => number;
  resolveClaudeLiveSessionRequirement?: typeof resolveCliBackendLiveSessionRequirement;
};

type DetectInferenceBackendsOptions = {
  config?: OpenClawConfig;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  deps?: DetectInferenceBackendsDeps;
};

type DetectNativeCodexAppServerOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  probeLocalCommand?: typeof probeLocalCommand;
};

function detectCliCredentialState(params: {
  probe: LocalCommandProbe;
  hasStoredCredentials: boolean;
  platform: NodeJS.Platform;
}): boolean | undefined {
  if (!params.probe.found) {
    return undefined;
  }
  if (params.hasStoredCredentials) {
    return true;
  }
  // On macOS both CLIs may keep their login in the keychain, which we must not
  // read here (it can trigger a password prompt). Missing file creds is only a
  // definitive logout signal elsewhere.
  return params.platform === "darwin" ? undefined : false;
}

type CliAuthKind = "api-key" | "chatgpt-subscription" | "claude-subscription";
type CliLoginState = { credentials: boolean | undefined; authKind?: CliAuthKind };

const CLI_AUTH_KIND_LABEL: Record<CliAuthKind, string> = {
  "api-key": "API key (usage-billed)",
  "chatgpt-subscription": "ChatGPT subscription",
  "claude-subscription": "Claude subscription",
};

function describeCliDetail(state: CliLoginState, loginHint: string): string {
  if (state.authKind) {
    return `logged in · ${CLI_AUTH_KIND_LABEL[state.authKind]}`;
  }
  if (state.credentials === true) {
    return "logged in";
  }
  if (state.credentials === false) {
    return `installed, not logged in — ${loginHint}, then check again`;
  }
  return "installed";
}

function classifyClaudeCliAuth(
  credential: { type: string } | null,
  env: NodeJS.ProcessEnv,
): CliAuthKind | undefined {
  if (env.ANTHROPIC_API_KEY?.trim() || credential?.type === "api_key_helper") {
    return "api-key";
  }
  if (credential?.type === "oauth" || credential?.type === "token") {
    return "claude-subscription";
  }
  return undefined;
}

function describeGeminiCliDetail(credentials: boolean | undefined): string {
  return credentials === true
    ? "installed; credentials found"
    : "installed; login status unavailable";
}

async function classifyCodexLoginStatus(
  probe: typeof probeLocalCommand,
  command: string,
): Promise<CliLoginState> {
  const status = await probe(command, ["login", "status"], { timeoutMs: 3_000 });
  if (status.error) {
    // Codex login status covers its own auth store, not custom model-provider
    // credentials. Keep failures indeterminate so the live probe decides usability.
    return { credentials: undefined };
  }
  if (status.version === "Logged in using ChatGPT") {
    return { credentials: true, authKind: "chatgpt-subscription" };
  }
  if (/^Logged in using an API key - .+$/u.test(status.version ?? "")) {
    return { credentials: true, authKind: "api-key" };
  }
  return { credentials: true };
}

// Deliberately boolean-shaped: this signature is reachable from the exported
// detectInferenceBackends options type and therefore part of the plugin-sdk
// agent-harness API contract. Widening it would bump the contract hash — the
// rich classification stays module-local in classifyCodexLoginStatus.
async function detectCodexLoginState(
  probe: typeof probeLocalCommand,
  command: string,
): Promise<boolean | undefined> {
  return (await classifyCodexLoginStatus(probe, command)).credentials;
}

function randomizeClaudeCodexTie(
  candidates: InferenceBackendCandidate[],
  pickRandomInt: (maxExclusive: number) => number,
): void {
  const claudeIndex = candidates.findIndex(
    (candidate) => candidate.kind === "claude-cli" && candidate.credentials !== false,
  );
  const codexIndex = candidates.findIndex(
    (candidate) => candidate.kind === "codex-cli" && candidate.credentials !== false,
  );
  if (claudeIndex === -1 || codexIndex === -1 || pickRandomInt(2) === 0) {
    return;
  }
  const claudeCandidate = candidates[claudeIndex];
  const codexCandidate = candidates[codexIndex];
  candidates[claudeIndex] = expectDefined(codexCandidate, "Codex onboarding candidate");
  candidates[codexIndex] = expectDefined(claudeCandidate, "Claude onboarding candidate");
}

// ChatGPT.app is the current desktop owner; keep Codex stable/beta as fallbacks.
const CODEX_MACOS_APP_NAMES = ["ChatGPT.app", "Codex.app", "Codex Beta.app"] as const;

async function probeCodexCommand(params: {
  probe: typeof probeLocalCommand;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): Promise<LocalCommandProbe> {
  const pathProbe = await params.probe("codex");
  if (pathProbe.found || params.platform !== "darwin") {
    return pathProbe;
  }
  const home = params.env.HOME?.trim() || os.homedir();
  const appExecutables = new Set(
    CODEX_MACOS_APP_NAMES.flatMap((appName) => [
      path.join("/Applications", appName, "Contents", "Resources", "codex"),
      path.join(home, "Applications", appName, "Contents", "Resources", "codex"),
    ]),
  );
  for (const executable of appExecutables) {
    const appProbe = await params.probe(executable);
    if (appProbe.found) {
      return appProbe;
    }
  }
  return pathProbe;
}
/** Detects a native Codex App Server without coupling it to inference selection. */
async function detectNativeCodexAppServer(
  options: DetectNativeCodexAppServerOptions = {},
): Promise<LocalCommandProbe> {
  return await probeCodexCommand({
    probe: options.probeLocalCommand ?? probeLocalCommand,
    env: options.env ?? process.env,
    platform: options.platform ?? process.platform,
  });
}

/**
 * Detect usable inference backends in ladder order. Returns candidates only
 * for backends that exist on this machine; the first entry is the bootstrap
 * default. Backends that are definitively logged out sink below logged-in and
 * unknown ones so a stale install never outranks a working login.
 */
export async function detectInferenceBackends(
  options: DetectInferenceBackendsOptions = {},
): Promise<InferenceBackendCandidate[]> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const probe = options.deps?.probeLocalCommand ?? probeLocalCommand;
  const readClaude =
    options.deps?.readClaudeCliCredentials ??
    (() => readClaudeCliCredentialsCached({ allowKeychainPrompt: false, ttlMs: 60_000 }));
  const readCodex =
    options.deps?.readCodexCliCredentials ??
    (() => readCodexCliCredentialsCached({ allowKeychainPrompt: false, ttlMs: 60_000 }));
  const readGemini =
    options.deps?.readGeminiCliCredentials ??
    (() => readGeminiCliCredentialsCached({ ttlMs: 60_000 }));

  const candidates: InferenceBackendCandidate[] = [];
  const defaultAgentId = options.config
    ? options.agentId?.trim() || tryResolveLegacyCompatibilityAgentId(options.config)
    : undefined;
  const defaultAgentModel =
    options.config && defaultAgentId
      ? resolveAgentConfig(options.config, defaultAgentId)?.model
      : undefined;
  const existingModel =
    resolveAgentModelPrimaryValue(defaultAgentModel) ??
    resolveAgentModelPrimaryValue(options.config?.agents?.defaults?.model);
  if (existingModel) {
    const resolved = resolveDefaultModelForAgent({
      cfg: options.config ?? {},
      ...(defaultAgentId ? { agentId: defaultAgentId } : {}),
    });
    const modelRef = `${resolved.provider}/${resolved.model}`;
    candidates.push({
      kind: "existing-model",
      // Approval and activation bind to the executable target, not a mutable
      // alias spelling. The authored config itself remains untouched.
      modelRef,
      label: "Current model",
      detail: `${modelRef} — already configured`,
      credentials: true,
    });
  }
  const envCandidates = detectAmbientInferenceBackends(env);

  const [claudeProbe, codexProbe, geminiProbe] = await Promise.all([
    probe("claude"),
    detectNativeCodexAppServer({ probeLocalCommand: probe, env, platform }),
    probe("gemini"),
  ]);
  const cliCandidates: InferenceBackendCandidate[] = [];
  const subscriptionPromotionEligibleCliKinds = new Set<InferenceBackendKind>();
  if (claudeProbe.found && !claudeProbe.timedOut) {
    const liveSessionRequirement =
      (
        options.deps?.resolveClaudeLiveSessionRequirement ?? resolveCliBackendLiveSessionRequirement
      )("claude-cli") ?? undefined;
    const versionGuidance = liveSessionRequirement
      ? resolveCliBackendVersionGuidance(claudeProbe.version, liveSessionRequirement)
      : { status: "unknown" as const };
    const claudeCredential = readClaude();
    const credentials = detectCliCredentialState({
      probe: claudeProbe,
      hasStoredCredentials: claudeCredential !== null,
      platform,
    });
    if (credentials === true && claudeCredential?.type === "oauth") {
      subscriptionPromotionEligibleCliKinds.add("claude-cli");
    }
    const detail = describeCliDetail(
      { credentials, authKind: classifyClaudeCliAuth(claudeCredential, env) },
      "run `claude auth login`",
    );
    // Only the live init record can prove capability support. Keep backports and
    // wrappers selectable here even when their version predates the known release.
    cliCandidates.push({
      kind: "claude-cli",
      modelRef: CLAUDE_CLI_DEFAULT_MODEL_REF,
      label: "Claude Code",
      detail:
        versionGuidance.status === "below-known-floor" && liveSessionRequirement
          ? `${detail}; ${formatCliBackendVersionAdvisory({
              label: "Claude Code",
              requirement: liveSessionRequirement,
              version: versionGuidance.version,
            })}`
          : detail,
      ...(credentials === undefined ? {} : { credentials }),
    });
  }
  if (codexProbe.found && !codexProbe.timedOut) {
    const codexCredential = readCodex();
    const loginState: CliLoginState = options.deps?.detectCodexLoginState
      ? { credentials: await options.deps.detectCodexLoginState(probe, codexProbe.command) }
      : options.deps?.readCodexCliCredentials
        ? {
            credentials: detectCliCredentialState({
              probe: codexProbe,
              hasStoredCredentials: codexCredential !== null,
              platform,
            }),
            ...(codexCredential?.type === "oauth"
              ? { authKind: "chatgpt-subscription" as const }
              : {}),
          }
        : await classifyCodexLoginStatus(probe, codexProbe.command);
    const credentials = loginState.credentials;
    // Promote only prompt-free ChatGPT OAuth tokens. Status-only logins may be metered;
    // keychain-only ChatGPT users conservatively stay usable in the fallback tier.
    if (credentials === true && codexCredential?.type === "oauth") {
      subscriptionPromotionEligibleCliKinds.add("codex-cli");
    }
    cliCandidates.push({
      kind: "codex-cli",
      modelRef: CODEX_APP_SERVER_DEFAULT_MODEL_REF,
      label: "Codex",
      detail: describeCliDetail(loginState, "run `codex login`"),
      ...(credentials === undefined ? {} : { credentials }),
    });
  }
  if (geminiProbe.found && !geminiProbe.timedOut) {
    // Current Gemini CLI releases keep primary auth in a private secure store;
    // oauth_creds.json is only a legacy migration source. Its absence cannot
    // distinguish logout from a modern login, and probing the secure store can
    // prompt the user, so only readable legacy credentials are conclusive.
    const credentials = readGemini() !== null ? true : undefined;
    cliCandidates.push({
      kind: "gemini-cli",
      modelRef: GEMINI_CLI_DEFAULT_MODEL_REF,
      label: "Gemini CLI",
      detail: describeGeminiCliDetail(credentials),
      ...(credentials === undefined ? {} : { credentials }),
    });
  }
  // Claude Code and Codex share rank within a credential tier. Randomize before
  // partitioning so logged-in and unknown ties keep no provider preference.
  randomizeClaudeCodexTie(cliCandidates, options.deps?.randomInt ?? randomInt);
  const loggedInSubscriptionCliCandidates = cliCandidates.filter(
    (candidate) =>
      candidate.credentials === true && subscriptionPromotionEligibleCliKinds.has(candidate.kind),
  );
  const remainingCliCandidates = cliCandidates.filter(
    (candidate) => !loggedInSubscriptionCliCandidates.includes(candidate),
  );
  // Verified flat-rate subscription logins outrank metered environment keys.
  // Existing models stay first so guided setup never silently replaces one.
  candidates.push(
    ...loggedInSubscriptionCliCandidates,
    ...envCandidates,
    // Unknown login states and Gemini remain fallbacks; definitive logouts sink last.
    ...remainingCliCandidates.filter((candidate) => candidate.credentials !== false),
    ...remainingCliCandidates.filter((candidate) => candidate.credentials === false),
  );
  return candidates;
}
