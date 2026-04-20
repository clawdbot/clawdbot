import { resolveBootstrapMode, type BootstrapMode } from "../../agents/bootstrap-mode.js";
import {
  buildFullBootstrapPromptLines,
  buildLimitedBootstrapPromptLines,
} from "../../agents/bootstrap-prompt.js";
import { appendCronStyleCurrentTimeLine } from "../../agents/current-time.js";
import { resolveEffectiveToolInventory } from "../../agents/tools-effective-inventory.js";
import { isWorkspaceBootstrapPending } from "../../agents/workspace.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const BARE_SESSION_RESET_PROMPT_BASE =
  "A new session was started via /new or /reset. Execute your Session Startup sequence now - read the required files before responding to the user. If BOOTSTRAP.md exists in the provided Project Context, read it and follow its instructions first. Then greet the user in your configured persona, if one is provided. Be yourself - use your defined voice, mannerisms, and mood. Keep it to 1-3 sentences and ask what they want to do. If the runtime model differs from default_model in the system prompt, mention the default model. Do not mention internal steps, files, tools, or reasoning.";

const BARE_SESSION_RESET_PROMPT_BOOTSTRAP_PENDING = [
  "A new session was started via /new or /reset while bootstrap is still pending for this workspace.",
  ...buildFullBootstrapPromptLines({
    readLine:
      "Please read BOOTSTRAP.md from the workspace now and follow it before replying normally.",
    firstReplyLine:
      "Your first user-visible reply must follow BOOTSTRAP.md, not a generic greeting.",
  }),
  "If the runtime model differs from default_model in the system prompt, mention the default model only after handling BOOTSTRAP.md.",
  "Do not mention internal steps, files, tools, or reasoning.",
].join(" ");

const BARE_SESSION_RESET_PROMPT_BOOTSTRAP_LIMITED = [
  "A new session was started via /new or /reset while bootstrap is still pending for this workspace, but this run cannot safely complete the full BOOTSTRAP.md workflow here.",
  ...buildLimitedBootstrapPromptLines({
    introLine:
      "Bootstrap is still pending for this workspace, but this run cannot safely complete the full BOOTSTRAP.md workflow here.",
    nextStepLine:
      "Typical next steps include switching to a primary interactive run with normal workspace access or having the user complete the canonical BOOTSTRAP.md deletion afterward.",
  }).slice(1),
  "If the runtime model differs from default_model in the system prompt, mention the default model only after you have handled this limitation.",
  "Do not mention internal steps, files, tools, or reasoning.",
].join(" ");

export function resolveBareResetBootstrapFileAccess(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  modelProvider?: string;
  modelId?: string;
}): boolean {
  if (!params.cfg) {
    return false;
  }
  const inventory = resolveEffectiveToolInventory({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });
  return inventory.groups.some((group) => group.tools.some((tool) => tool.id === "read"));
}

export async function resolveBareSessionResetPromptState(params: {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  nowMs?: number;
  isPrimaryRun?: boolean;
  isCanonicalWorkspace?: boolean;
  hasBootstrapFileAccess?: boolean | (() => boolean);
}): Promise<{
  bootstrapMode: BootstrapMode;
  prompt: string;
  shouldPrependStartupContext: boolean;
}> {
  const bootstrapPending = params.workspaceDir
    ? await isWorkspaceBootstrapPending(params.workspaceDir)
    : false;
  const hasBootstrapFileAccess = bootstrapPending
    ? typeof params.hasBootstrapFileAccess === "function"
      ? params.hasBootstrapFileAccess()
      : (params.hasBootstrapFileAccess ?? true)
    : true;
  const bootstrapMode = resolveBootstrapMode({
    bootstrapPending,
    runKind: "default",
    isInteractiveUserFacing: true,
    isPrimaryRun: params.isPrimaryRun ?? true,
    isCanonicalWorkspace: params.isCanonicalWorkspace ?? true,
    hasBootstrapFileAccess,
  });
  return {
    bootstrapMode,
    prompt: buildBareSessionResetPrompt(params.cfg, params.nowMs, bootstrapMode),
    shouldPrependStartupContext: bootstrapMode === "none",
  };
}

/**
 * Build the bare session reset prompt, appending the current date/time so agents
 * know which daily memory files to read during their Session Startup sequence.
 * Without this, agents on /new or /reset guess the date from their training cutoff.
 */
export function buildBareSessionResetPrompt(
  cfg?: OpenClawConfig,
  nowMs?: number,
  bootstrapMode?: BootstrapMode,
): string {
  return appendCronStyleCurrentTimeLine(
    bootstrapMode === "full"
      ? BARE_SESSION_RESET_PROMPT_BOOTSTRAP_PENDING
      : bootstrapMode === "limited"
        ? BARE_SESSION_RESET_PROMPT_BOOTSTRAP_LIMITED
        : BARE_SESSION_RESET_PROMPT_BASE,
    cfg ?? {},
    nowMs ?? Date.now(),
  );
}

/** @deprecated Use buildBareSessionResetPrompt(cfg) instead */
export const BARE_SESSION_RESET_PROMPT = BARE_SESSION_RESET_PROMPT_BASE;
