// OpenClaw assistant planning converts fuzzy user text into one safe command.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SYSTEM_AGENT_ASSISTANT_SYSTEM_PROMPT,
  buildSystemAgentAssistantUserPrompt,
  parseSystemAgentAssistantPlanText,
  type SystemAgentAssistantPlan,
  type SystemAgentAssistantTurn,
} from "./assistant-prompts.js";
import { resolveSystemAgentAssistantTimeoutMs } from "./assistant-timeout.js";
import { SystemAgentInferenceUnavailableError } from "./inference-error.js";
import type { SystemAgentOverview } from "./overview.js";
import {
  resolveSystemAgentExpectedAgentHarnessRuntimeArtifact,
  resolveSystemAgentVerifiedInferenceRoute,
  type SystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceDeps,
} from "./verified-inference.js";

export {
  buildSystemAgentAssistantUserPrompt,
  parseSystemAgentAssistantPlanText,
  type SystemAgentAssistantPlan,
  type SystemAgentAssistantTurn,
} from "./assistant-prompts.js";

export type SystemAgentAssistantPlanner = (params: {
  input: string;
  overview: SystemAgentOverview;
  history?: SystemAgentAssistantTurn[];
  pendingOperation?: string;
  readonly verifiedInference: SystemAgentVerifiedInferenceBinding;
}) => Promise<SystemAgentAssistantPlan | null>;

type RunCliAgentFn = typeof import("../agents/cli-runner.js").runCliAgent;
type RunEmbeddedAgentFn = typeof import("../agents/embedded-agent.js").runEmbeddedAgent;

export type SystemAgentConfiguredModelPlannerDeps = SystemAgentVerifiedInferenceDeps & {
  runCliAgent?: RunCliAgentFn;
  runEmbeddedAgent?: RunEmbeddedAgentFn;
  createTempDir?: () => Promise<string>;
  removeTempDir?: (dir: string) => Promise<void>;
  resolveAssistantTimeoutMs?: typeof resolveSystemAgentAssistantTimeoutMs;
};

export async function planSystemAgentCommand(params: {
  input: string;
  overview: SystemAgentOverview;
  history?: SystemAgentAssistantTurn[];
  pendingOperation?: string;
  readonly verifiedInference: SystemAgentVerifiedInferenceBinding;
  deps?: SystemAgentConfiguredModelPlannerDeps;
}): Promise<SystemAgentAssistantPlan | null> {
  return await planSystemAgentCommandWithConfiguredModel(params);
}

/** Plan only through the configured default agent's verified route. */
export async function planSystemAgentCommandWithConfiguredModel(params: {
  input: string;
  overview: SystemAgentOverview;
  history?: SystemAgentAssistantTurn[];
  pendingOperation?: string;
  readonly verifiedInference: SystemAgentVerifiedInferenceBinding;
  deps?: SystemAgentConfiguredModelPlannerDeps;
}): Promise<SystemAgentAssistantPlan | null> {
  const route = await requireVerifiedPlannerRoute(params.verifiedInference, params.deps);
  const input = params.input.trim();
  if (!input) {
    return null;
  }
  let expectedAgentHarnessRuntimeArtifact: ReturnType<
    typeof resolveSystemAgentExpectedAgentHarnessRuntimeArtifact
  >;
  try {
    expectedAgentHarnessRuntimeArtifact = resolveSystemAgentExpectedAgentHarnessRuntimeArtifact(
      params.verifiedInference,
    );
  } catch (error) {
    throw new SystemAgentInferenceUnavailableError("planner", [error]);
  }
  const prompt = buildSystemAgentAssistantUserPrompt({
    input,
    overview: params.overview,
    ...(params.history ? { history: params.history } : {}),
    ...(params.pendingOperation ? { pendingOperation: params.pendingOperation } : {}),
  });
  const tempDir = await (params.deps?.createTempDir ?? createTempPlannerDir)();
  let plan: SystemAgentAssistantPlan | null;
  try {
    const runId = `openclaw-planner-${randomUUID()}`;
    const timeoutMs = (
      params.deps?.resolveAssistantTimeoutMs ?? resolveSystemAgentAssistantTimeoutMs
    )(route);
    const shared = {
      sessionId: `${runId}-session`,
      agentId: "openclaw",
      trigger: "manual" as const,
      sessionFile: path.join(tempDir, "session.jsonl"),
      workspaceDir: tempDir,
      cwd: tempDir,
      agentDir: route.agentDir,
      config: route.runConfig,
      prompt,
      provider: route.provider,
      model: route.model,
      timeoutMs,
      thinkLevel: "off" as const,
      runId,
      extraSystemPrompt: SYSTEM_AGENT_ASSISTANT_SYSTEM_PROMPT,
      extraSystemPromptStatic: SYSTEM_AGENT_ASSISTANT_SYSTEM_PROMPT,
      messageChannel: "openclaw",
      messageProvider: "openclaw",
      disableTools: true,
      disableTrajectory: true,
      ...(route.authProfileId ? { authProfileId: route.authProfileId } : {}),
    };
    const result =
      route.runner === "cli"
        ? await (params.deps?.runCliAgent ?? (await import("../agents/cli-runner.js")).runCliAgent)(
            {
              ...shared,
              executionMode: "side-question",
              cleanupCliLiveSessionOnRunEnd: true,
            },
          )
        : await (
            params.deps?.runEmbeddedAgent ??
            (await import("../agents/embedded-agent.js")).runEmbeddedAgent
          )({
            ...shared,
            toolsAllow: [],
            agentHarnessRuntimeOverride: route.agentHarnessRuntimeOverride,
            ...(expectedAgentHarnessRuntimeArtifact ? { expectedAgentHarnessRuntimeArtifact } : {}),
            cleanupBundleMcpOnRunEnd: true,
            ...(route.authProfileId ? { authProfileIdSource: "user" as const } : {}),
          });
    const parsed = parseSystemAgentAssistantPlanText(extractPlannerResultText(result));
    plan = parsed ? { ...parsed, modelLabel: route.modelLabel } : null;
  } catch (error) {
    if (error instanceof SystemAgentInferenceUnavailableError) {
      throw error;
    }
    plan = null;
  } finally {
    await (params.deps?.removeTempDir ?? removeTempPlannerDir)(tempDir);
  }
  // Cleanup is the final suspension before callers can display or execute the
  // model result, so authority must still match after cleanup completes.
  if (plan) {
    await requireVerifiedPlannerRoute(params.verifiedInference, params.deps);
  }
  return plan;
}

async function requireVerifiedPlannerRoute(
  binding: SystemAgentVerifiedInferenceBinding | undefined,
  deps: SystemAgentConfiguredModelPlannerDeps | undefined,
) {
  if (!binding) {
    throw new SystemAgentInferenceUnavailableError("planner");
  }
  try {
    const route = await resolveSystemAgentVerifiedInferenceRoute(binding, deps);
    if (route) {
      return route;
    }
  } catch (error) {
    throw new SystemAgentInferenceUnavailableError("planner", [error]);
  }
  throw new SystemAgentInferenceUnavailableError("planner");
}

async function createTempPlannerDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-planner-"));
}

async function removeTempPlannerDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

function extractPlannerResultText(result: {
  payloads?: Array<{ text?: string }>;
  meta?: {
    finalAssistantVisibleText?: string;
    finalAssistantRawText?: string;
  };
}): string | undefined {
  return (
    result.meta?.finalAssistantVisibleText ??
    result.meta?.finalAssistantRawText ??
    result.payloads
      ?.map((payload) => payload.text?.trim())
      .filter(Boolean)
      .join("\n")
  );
}
