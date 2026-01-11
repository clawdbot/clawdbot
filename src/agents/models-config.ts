import fs from "node:fs/promises";
import path from "node:path";

import { type ClawdbotConfig, loadConfig } from "../config/config.js";
import type { ModelsConfig as ModelsConfigShape } from "../config/types.js";
import {
  DEFAULT_COPILOT_API_BASE_URL,
  resolveCopilotApiToken,
} from "../providers/github-copilot-token.js";
import { resolveClawdbotAgentDir } from "./agent-paths.js";
import {
  ensureAuthProfileStore,
  listProfilesForProvider,
} from "./auth-profiles.js";

type ModelsConfig = NonNullable<ClawdbotConfig["models"]>;

type ModelsProviderConfig = NonNullable<ModelsConfigShape["providers"]>[string];

const DEFAULT_MODE: NonNullable<ModelsConfig["mode"]> = "merge";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function readJson(pathname: string): Promise<unknown> {
  try {
    const raw = await fs.readFile(pathname, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

async function maybeBuildCopilotProvider(params: {
  cfg: ClawdbotConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<ModelsProviderConfig | null> {
  const env = params.env ?? process.env;
  const authStore = ensureAuthProfileStore();
  const hasProfile =
    listProfilesForProvider(authStore, "github-copilot").length > 0;
  const envToken = env.COPILOT_GITHUB_TOKEN ?? env.GH_TOKEN ?? env.GITHUB_TOKEN;
  const githubToken = (envToken ?? "").trim();

  if (!hasProfile && !githubToken) return null;

  let selectedGithubToken = githubToken;
  if (!selectedGithubToken && hasProfile) {
    // Use the first available profile as a default for discovery (it will be
    // re-resolved per-run by the embedded runner).
    const profileId = listProfilesForProvider(authStore, "github-copilot")[0];
    const profile = profileId ? authStore.profiles[profileId] : undefined;
    if (profile && profile.type === "token") {
      selectedGithubToken = profile.token;
    }
  }

  let baseUrl = DEFAULT_COPILOT_API_BASE_URL;
  if (selectedGithubToken) {
    try {
      const token = await resolveCopilotApiToken({
        githubToken: selectedGithubToken,
        env,
      });
      baseUrl = token.baseUrl;
    } catch {
      baseUrl = DEFAULT_COPILOT_API_BASE_URL;
    }
  }

  // pi-coding-agent's ModelRegistry marks a model "available" only if its
  // `AuthStorage` has auth configured for that provider (via auth.json/env/etc).
  // Our Copilot auth lives in Clawdbot's auth-profiles store instead, so we also
  // write a runtime-only auth.json entry for pi-coding-agent to pick up.
  //
  // This is safe because it's (1) within Clawdbot's agent dir, (2) contains the
  // GitHub token (not the exchanged Copilot token), and (3) matches existing
  // patterns for OAuth-like providers in pi-coding-agent.
  // Note: we deliberately do not write pi-coding-agent's `auth.json` here.
  // Clawdbot uses its own auth store and exchanges tokens at runtime.
  // `models list` uses Clawdbot's auth heuristics for availability.

  // We intentionally do NOT define custom models for Copilot in models.json.
  // pi-coding-agent treats providers with models as replacements requiring apiKey.
  // We only override baseUrl; the model list comes from pi-ai built-ins.
  return {
    baseUrl,
    models: [],
  } satisfies ModelsProviderConfig;
}

export async function ensureClawdbotModelsJson(
  config?: ClawdbotConfig,
  agentDirOverride?: string,
): Promise<{ agentDir: string; wrote: boolean }> {
  const cfg = config ?? loadConfig();

  const explicitProviders = cfg.models?.providers ?? {};
  const implicitCopilot = await maybeBuildCopilotProvider({ cfg });
  const providers = implicitCopilot
    ? { ...explicitProviders, "github-copilot": implicitCopilot }
    : explicitProviders;

  if (!providers || Object.keys(providers).length === 0) {
    const agentDir = agentDirOverride?.trim()
      ? agentDirOverride.trim()
      : resolveClawdbotAgentDir();
    return { agentDir, wrote: false };
  }

  const mode = cfg.models?.mode ?? DEFAULT_MODE;
  const agentDir = agentDirOverride?.trim()
    ? agentDirOverride.trim()
    : resolveClawdbotAgentDir();
  const targetPath = path.join(agentDir, "models.json");

  let mergedProviders = providers;
  let existingRaw = "";
  if (mode === "merge") {
    const existing = await readJson(targetPath);
    if (isRecord(existing) && isRecord(existing.providers)) {
      const existingProviders = existing.providers as Record<
        string,
        NonNullable<ModelsConfig["providers"]>[string]
      >;
      mergedProviders = { ...existingProviders, ...providers };
    }
  }

  const next = `${JSON.stringify({ providers: mergedProviders }, null, 2)}\n`;
  try {
    existingRaw = await fs.readFile(targetPath, "utf8");
  } catch {
    existingRaw = "";
  }

  if (existingRaw === next) {
    return { agentDir, wrote: false };
  }

  await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(targetPath, next, { mode: 0o600 });
  return { agentDir, wrote: true };
}
