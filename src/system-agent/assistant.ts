// OpenClaw assistant planning converts fuzzy user text into one safe command.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SYSTEM_AGENT_ASSISTANT_SYSTEM_PROMPT,
  SYSTEM_AGENT_GREETING_SYSTEM_PROMPT,
  buildSystemAgentAssistantUserPrompt,
  buildSystemAgentGreetingUserPrompt,
  parseSystemAgentAssistantPlanText,
  type SystemAgentAssistantPlan,
  type SystemAgentAssistantTurn,
} from "./assistant-prompts.js";
import { resolveSystemAgentAssistantTimeoutMs } from "./assistant-timeout.js";
import type { SystemAgentGreetingFacts, SystemAgentGreetingPlan } from "./greeting.js";
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
  const input = params.input.trim();
  if (!input) {
    return null;
  }
  const prompt = buildSystemAgentAssistantUserPrompt({
    input,
    overview: params.overview,
    ...(params.history ? { history: params.history } : {}),
    ...(params.pendingOperation ? { pendingOperation: params.pendingOperation } : {}),
  });
  const result = await runConfiguredSystemAgentText({
    prompt,
    systemPrompt: SYSTEM_AGENT_ASSISTANT_SYSTEM_PROMPT,
    runIdPrefix: "openclaw-planner",
    verifiedInference: params.verifiedInference,
    deps: params.deps,
  });
  const parsed = parseSystemAgentAssistantPlanText(result?.text);
  return parsed && result ? { ...parsed, modelLabel: result.modelLabel } : null;
}

/** One tool-free, verified inference turn for the cached caretaker greeting. */
export async function planSystemAgentGreetingWithConfiguredModel(params: {
  overview: SystemAgentOverview;
  facts: SystemAgentGreetingFacts;
  readonly verifiedInference: SystemAgentVerifiedInferenceBinding;
  deps?: SystemAgentConfiguredModelPlannerDeps;
  timeoutMs: number;
}): Promise<SystemAgentGreetingPlan | null> {
  const result = await runConfiguredSystemAgentText({
    prompt: buildSystemAgentGreetingUserPrompt(params),
    systemPrompt: SYSTEM_AGENT_GREETING_SYSTEM_PROMPT,
    runIdPrefix: "openclaw-greeting",
    verifiedInference: params.verifiedInference,
    deps: params.deps,
    timeoutMs: params.timeoutMs,
  });
  return result ? { text: result.text, modelRef: result.modelLabel } : null;
}

async function runConfiguredSystemAgentText(params: {
  prompt: string;
  systemPrompt: string;
  runIdPrefix: string;
  readonly verifiedInference: SystemAgentVerifiedInferenceBinding;
  deps?: SystemAgentConfiguredModelPlannerDeps;
  timeoutMs?: number;
}): Promise<{ text: string; modelLabel: string } | null> {
  const route = await requireVerifiedPlannerRoute(params.verifiedInference, params.deps);
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
  const tempDir = await (params.deps?.createTempDir ?? createTempPlannerDir)();
  let text: string | undefined;
  try {
    const runId = `${params.runIdPrefix}-${randomUUID()}`;
    const timeoutMs =
      params.timeoutMs ??
      (params.deps?.resolveAssistantTimeoutMs ?? resolveSystemAgentAssistantTimeoutMs)(route);
    const shared = {
      sessionId: `${runId}-session`,
      agentId: "openclaw",
      trigger: "manual" as const,
      sessionFile: path.join(tempDir, "session.jsonl"),
      workspaceDir: tempDir,
      cwd: tempDir,
      agentDir: route.agentDir,
      config: route.runConfig,
      prompt: params.prompt,
      provider: route.provider,
      model: route.model,
      timeoutMs,
      thinkLevel: "off" as const,
      runId,
      extraSystemPrompt: params.systemPrompt,
      extraSystemPromptStatic: params.systemPrompt,
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
    text = extractPlannerResultText(result)?.trim();
  } catch (error) {
    if (error instanceof SystemAgentInferenceUnavailableError) {
      throw error;
    }
    text = undefined;
  } finally {
    await (params.deps?.removeTempDir ?? removeTempPlannerDir)(tempDir);
  }
  if (!text) {
    return null;
  }
  // Cleanup is the final suspension before callers can display model text, so
  // authority must still match after cleanup completes.
  await requireVerifiedPlannerRoute(params.verifiedInference, params.deps);
  return { text, modelLabel: route.modelLabel };
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
