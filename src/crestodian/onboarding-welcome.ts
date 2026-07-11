// First-run onboarding welcome: state findings, propose setup, wait for "yes".
import { isSecretRef, normalizeSecretInputString } from "../config/types.secrets.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import type { CrestodianChatEngine } from "./chat-engine.js";
import { formatCrestodianOnboardingWelcome } from "./overview.js";

/**
 * The basic bootstrap is conversational: the welcome message carries the plan
 * and the engine holds it as the pending proposal, so a bare "yes" applies it.
 * This path starts only after a live inference turn. Already-configured
 * installs get the channels/handoff guide instead.
 */
/**
 * "Configured" must match the app onboarding gate (wizard metadata or gateway
 * auth), not just a model: a model-only config would otherwise get the
 * ready-guide welcome while the gate stays locked, stranding the page.
 */
export async function loadAuthoredSetupConfig(params: {
  configExists: boolean;
  configValid: boolean;
}): Promise<{
  authoredConfig?: import("../config/types.openclaw.js").OpenClawConfig;
  hasAuthoredSetup: boolean;
}> {
  const authoredConfig = await (async () => {
    if (!params.configExists || !params.configValid) {
      return undefined;
    }
    try {
      const { readConfigFileSnapshot } = await import("../config/config.js");
      const snapshot = await readConfigFileSnapshot();
      return snapshot.sourceConfig ?? snapshot.config ?? {};
    } catch {
      return undefined;
    }
  })();
  const auth = authoredConfig?.gateway?.auth;
  const hasAuthMode = normalizeSecretInputString(auth?.mode) !== undefined;
  const hasAuthSecret =
    isSecretRef(auth?.token) ||
    normalizeSecretInputString(auth?.token) !== undefined ||
    isSecretRef(auth?.password) ||
    normalizeSecretInputString(auth?.password) !== undefined;
  const hasWizardMetadata =
    authoredConfig?.wizard !== undefined && Object.keys(authoredConfig.wizard).length > 0;
  const hasAuthoredSetup = hasWizardMetadata || hasAuthMode || hasAuthSecret;
  return { ...(authoredConfig ? { authoredConfig } : {}), hasAuthoredSetup };
}

export async function buildOnboardingWelcome(params: {
  engine: CrestodianChatEngine;
  workspace?: string;
}): Promise<string> {
  const overview = await params.engine.loadOverview();
  const { authoredConfig, hasAuthoredSetup } = await loadAuthoredSetupConfig({
    configExists: overview.config.exists,
    configValid: overview.config.valid,
  });
  const defaultModel = overview.defaultModel?.trim();
  const requestedWorkspace = params.workspace?.trim()
    ? resolveUserPath(params.workspace.trim())
    : undefined;
  const authoredWorkspace = authoredConfig?.agents?.defaults?.workspace?.trim()
    ? resolveUserPath(authoredConfig.agents.defaults.workspace.trim())
    : undefined;
  if (
    hasAuthoredSetup &&
    defaultModel &&
    (!requestedWorkspace || requestedWorkspace === authoredWorkspace)
  ) {
    const welcome = formatCrestodianOnboardingWelcome(overview);
    params.engine.noteAssistantMessage(welcome);
    return welcome;
  }
  if (!defaultModel) {
    throw new Error(
      "Crestodian onboarding requires working inference first. Run `openclaw onboard` to configure and verify a default model.",
    );
  }

  const { DEFAULT_WORKSPACE } = await import("../commands/onboard-helpers.js");
  const workspace = resolveUserPath(requestedWorkspace || authoredWorkspace || DEFAULT_WORKSPACE);

  params.engine.propose({ kind: "setup", workspace });
  const welcome = [
    "## Hi, I'm Crestodian — let's hatch your agent.",
    "",
    "No menus here: tell me what you want and I'll do the configuring. I looked around this machine:",
    "",
    `- AI: ${defaultModel} — already verified with a real reply; switching later is one sentence.`,
    `- Workspace: ${shortenHomePath(workspace)}`,
    "- Gateway: runs locally, private to this machine (token auth).",
    "",
    "Say **yes** and I'll set all of that up now.",
    "",
    "Heads up: your agent gets real access to this machine — https://docs.openclaw.ai/security",
    "Afterwards: `connect discord`, `connect slack`, `connect telegram`, `connect whatsapp` (or `channels` for the full list), then `talk to agent` to meet your agent.",
  ].join("\n");
  params.engine.noteAssistantMessage(welcome);
  return welcome;
}
