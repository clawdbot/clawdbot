import { randomInt } from "node:crypto";
// Inference backend detection shared by onboarding bootstrap and Crestodian setup.
import os from "node:os";
import path from "node:path";
import { resolveAgentConfig, resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import {
  readClaudeCliCredentialsCached,
  readCodexCliCredentialsCached,
  readGeminiCliCredentialsCached,
} from "../agents/cli-credentials.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { probeLocalCommand, type LocalCommandProbe } from "../crestodian/probes.js";

/**
 * Onboarding treats inference as the one required step: reuse whatever the
 * machine already has (env API keys, Claude Code login, Codex login) before
 * asking the user anything. The ladder order is a documented contract
 * (docs/cli/crestodian.md "Setup bootstrap") — change docs when changing it.
 */
export const OPENAI_API_DEFAULT_MODEL_REF = "openai/gpt-5.6";
export const ANTHROPIC_API_DEFAULT_MODEL_REF = "anthropic/claude-opus-4-8";
export const CLAUDE_CLI_DEFAULT_MODEL_REF = "claude-cli/claude-opus-4-8";
export const CODEX_APP_SERVER_DEFAULT_MODEL_REF = "openai/gpt-5.6-sol";
export const GEMINI_CLI_DEFAULT_MODEL_REF = "google-gemini-cli/gemini-3.1-pro-preview";

export type InferenceBackendKind =
  | "existing-model"
  | "openai-api-key"
  | "anthropic-api-key"
  | "claude-cli"
  | "codex-cli"
  | "gemini-cli";

export type InferenceBackendCandidate = {
  kind: InferenceBackendKind;
  modelRef: string;
  /** Short human label, e.g. "Claude Code CLI". */
  label: string;
  /** One-line provenance, e.g. "logged in", "ANTHROPIC_API_KEY set". */
  detail: string;
  /**
   * true: credentials verified; false: definitively logged out; undefined:
   * unknown (e.g. macOS keychain-backed logins we must not prompt for here).
   */
  credentials?: boolean;
};

export type DetectInferenceBackendsDeps = {
  probeLocalCommand?: typeof probeLocalCommand;
  readClaudeCliCredentials?: () => { type: string } | null;
  readCodexCliCredentials?: () => { type: string } | null;
  readGeminiCliCredentials?: () => { type: string } | null;
  randomInt?: (maxExclusive: number) => number;
};

export type DetectInferenceBackendsOptions = {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  deps?: DetectInferenceBackendsDeps;
};

export type DetectNativeCodexAppServerOptions = {
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

function describeCliDetail(credentials: boolean | undefined): string {
  if (credentials === true) {
    return "logged in";
  }
  if (credentials === false) {
    return "installed, not logged in";
  }
  return "installed";
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
  [candidates[claudeIndex], candidates[codexIndex]] = [
    candidates[codexIndex],
    candidates[claudeIndex],
  ];
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
export async function detectNativeCodexAppServer(
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
  const defaultAgentId = options.config ? resolveDefaultAgentId(options.config) : undefined;
  const defaultAgentModel = options.config
    ? resolveAgentConfig(options.config, resolveDefaultAgentId(options.config))?.model
    : undefined;
  const existingModel =
    resolveAgentModelPrimaryValue(defaultAgentModel) ??
    resolveAgentModelPrimaryValue(options.config?.agents?.defaults?.model);
  if (existingModel) {
    const resolved = resolveDefaultModelForAgent({
      cfg: options.config ?? {},
      ...(defaultAgentId ? { agentId: defaultAgentId } : {}),
    });
    candidates.push({
      kind: "existing-model",
      // Approval and activation bind to the executable target, not a mutable
      // alias spelling. The authored config itself remains untouched.
      modelRef: `${resolved.provider}/${resolved.model}`,
      label: "Current model",
      detail: "already configured",
      credentials: true,
    });
  }
  if (env.OPENAI_API_KEY?.trim()) {
    candidates.push({
      kind: "openai-api-key",
      modelRef: OPENAI_API_DEFAULT_MODEL_REF,
      label: "OpenAI API key",
      detail: "OPENAI_API_KEY set",
      credentials: true,
    });
  }
  if (env.ANTHROPIC_API_KEY?.trim()) {
    candidates.push({
      kind: "anthropic-api-key",
      modelRef: ANTHROPIC_API_DEFAULT_MODEL_REF,
      label: "Anthropic API key",
      detail: "ANTHROPIC_API_KEY set",
      credentials: true,
    });
  }

  const [claudeProbe, codexProbe, geminiProbe] = await Promise.all([
    probe("claude"),
    detectNativeCodexAppServer({ probeLocalCommand: probe, env, platform }),
    probe("gemini"),
  ]);
  const cliCandidates: InferenceBackendCandidate[] = [];
  if (claudeProbe.found) {
    const credentials = detectCliCredentialState({
      probe: claudeProbe,
      hasStoredCredentials: readClaude() !== null,
      platform,
    });
    cliCandidates.push({
      kind: "claude-cli",
      modelRef: CLAUDE_CLI_DEFAULT_MODEL_REF,
      label: "Claude Code",
      detail: describeCliDetail(credentials),
      ...(credentials === undefined ? {} : { credentials }),
    });
  }
  if (codexProbe.found) {
    const credentials = detectCliCredentialState({
      probe: codexProbe,
      hasStoredCredentials: readCodex() !== null,
      platform,
    });
    cliCandidates.push({
      kind: "codex-cli",
      modelRef: CODEX_APP_SERVER_DEFAULT_MODEL_REF,
      label: "Codex",
      detail: describeCliDetail(credentials),
      ...(credentials === undefined ? {} : { credentials }),
    });
  }
  if (geminiProbe.found) {
    // Gemini CLI stores its OAuth login in a plain file on every platform (no
    // keychain), so a missing credential file is a definitive logout signal.
    const credentials = readGemini() !== null;
    cliCandidates.push({
      kind: "gemini-cli",
      modelRef: GEMINI_CLI_DEFAULT_MODEL_REF,
      label: "Gemini CLI",
      detail: describeCliDetail(credentials),
      credentials,
    });
  }
  // Claude Code and Codex are equivalent subscription-backed choices. When both
  // may be usable, randomize their first-test order instead of encoding a preference.
  randomizeClaudeCodexTie(cliCandidates, options.deps?.randomInt ?? randomInt);
  // Stable partition: definitively logged-out installs still sink below usable or
  // keychain-unknown candidates; Gemini retains its documented fallback position.
  candidates.push(
    ...cliCandidates.filter((candidate) => candidate.credentials !== false),
    ...cliCandidates.filter((candidate) => candidate.credentials === false),
  );
  return candidates;
}
