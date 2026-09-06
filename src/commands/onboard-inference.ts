import { randomInt } from "node:crypto";
// Inference backend detection shared by onboarding bootstrap and OpenClaw setup.
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { resolveAgentConfig } from "../agents/agent-scope-config.js";
import {
  readCodexCliCredentialsCached,
  readGeminiCliCredentialsCached,
  resolveCodexCliHomePath,
} from "../agents/cli-credentials.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOsHomeDir } from "../infra/home-dir.js";
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
 * machine already has without activating providers. CLI version and credential
 * presence are detection evidence; explicit setup verifies the selected login.
 */

type DetectInferenceBackendsDeps = {
  probeLocalCommand?: typeof probeLocalCommand;
  detectClaudeLoginState?: (
    _probe: typeof probeLocalCommand,
    command: string,
    env?: NodeJS.ProcessEnv,
  ) => Promise<CliLoginState>;
  readCodexCliCredentials?: () => { type: string } | null;
  readGeminiCliCredentials?: () => { type: string } | null;
  detectCodexLoginState?: (
    probe: typeof probeLocalCommand,
    command: string,
  ) => Promise<boolean | undefined>;
  randomInt?: (maxExclusive: number) => number;
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

type CliAuthKind = "api-key" | "chatgpt-subscription" | "claude-subscription" | "token";
type CliLoginState = {
  credentials: boolean | undefined;
  authKind?: CliAuthKind;
  email?: string;
};

const CLI_AUTH_KIND_LABEL: Record<CliAuthKind, string> = {
  "api-key": "API key (usage-billed)",
  "chatgpt-subscription": "ChatGPT account",
  "claude-subscription": "Claude account",
  token: "OAuth token",
};

function describeCliDetail(state: CliLoginState, loginHint: string): string {
  if (state.authKind) {
    const account =
      state.authKind === "chatgpt-subscription" || state.authKind === "claude-subscription";
    const identity = account ? ` · ${state.email || "email unavailable"}` : "";
    return `logged in · ${CLI_AUTH_KIND_LABEL[state.authKind]}${identity}`;
  }
  if (state.credentials === true) {
    return "logged in · authentication method unavailable";
  }
  if (state.credentials === false) {
    return `installed, not logged in — ${loginHint}, then check again`;
  }
  return "installed";
}

function describeGeminiCliDetail(credentials: boolean | undefined): string {
  return credentials === true
    ? "installed; credentials found"
    : "installed; login status unavailable";
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
const CODEX_MACOS_APP_PROBE_TIMEOUT_MS = 3_000;

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
    // ChatGPT.app's signed Codex binary can spend most of the generic 1.5s
    // probe budget in macOS cold-start validation. Keep the broader probe
    // contract tight while giving known desktop-app binaries enough headroom.
    const appProbe = await params.probe(executable, ["--version"], {
      timeoutMs: CODEX_MACOS_APP_PROBE_TIMEOUT_MS,
    });
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
 * for backends that exist on this machine; explicit setup owns selection.
 * Backends that are definitively logged out sink below logged-in and
 * unknown ones so a stale install never outranks a working login.
 */
export async function detectInferenceBackends(
  options: DetectInferenceBackendsOptions = {},
): Promise<InferenceBackendCandidate[]> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const probe = options.deps?.probeLocalCommand ?? probeLocalCommand;
  const readCodex =
    options.deps?.readCodexCliCredentials ??
    (() => {
      const home = resolveOsHomeDir(env, env === process.env ? os.homedir : () => "");
      if (!home && !env.CODEX_HOME?.trim()) {
        return null;
      }
      return readCodexCliCredentialsCached({
        codexHome: resolveCodexCliHomePath(undefined, env),
        platform,
        allowKeychainPrompt: false,
        ttlMs: 60_000,
      });
    });
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
  const envCandidates = detectAmbientInferenceBackends(env).filter(
    (candidate) => candidate.kind === "openai-api-key" || candidate.kind === "anthropic-api-key",
  );

  const [claudeProbe, codexProbe, geminiProbe] = await Promise.all([
    probe("claude"),
    detectNativeCodexAppServer({ probeLocalCommand: probe, env, platform }),
    probe("gemini"),
  ]);
  const cliCandidates: InferenceBackendCandidate[] = [];
  const subscriptionPromotionEligibleCliKinds = new Set<InferenceBackendKind>();
  if (claudeProbe.found && !claudeProbe.timedOut) {
    const loginState: CliLoginState = options.deps?.detectClaudeLoginState
      ? await options.deps.detectClaudeLoginState(probe, claudeProbe.command)
      : { credentials: undefined };
    const credentials = loginState.credentials;
    if (credentials === true && loginState.authKind === "claude-subscription") {
      subscriptionPromotionEligibleCliKinds.add("claude-cli");
    }
    const detail = options.deps?.detectClaudeLoginState
      ? describeCliDetail(loginState, "run `claude auth login`")
      : "installed; login status unverified";
    cliCandidates.push({
      kind: "claude-cli",
      modelRef: CLAUDE_CLI_DEFAULT_MODEL_REF,
      label: "Claude Code",
      detail,
      ...(credentials === undefined ? {} : { credentials }),
    });
  }
  if (codexProbe.found && !codexProbe.timedOut) {
    const storedCredentials = readCodex() !== null;
    // Native status starts provider initialization (including migrations and
    // token refresh). A saved record proves neither the active store nor login.
    const credentials = options.deps?.detectCodexLoginState
      ? await options.deps.detectCodexLoginState(probe, codexProbe.command)
      : undefined;
    const detail = options.deps?.detectCodexLoginState
      ? describeCliDetail({ credentials }, "run `codex login`")
      : storedCredentials
        ? "installed; stored credentials found; login status unverified"
        : "installed; login status unverified";
    cliCandidates.push({
      kind: "codex-cli",
      modelRef: CODEX_APP_SERVER_DEFAULT_MODEL_REF,
      label: "Codex",
      detail,
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
  // Randomize only within a credential tier; stored credentials never establish
  // a verified subscription or outrank environment-key evidence.
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
