// Crestodian assistant planning converts fuzzy user text into one safe command.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CRESTODIAN_ASSISTANT_SYSTEM_PROMPT,
  CRESTODIAN_ASSISTANT_TIMEOUT_MS,
  buildCrestodianAssistantUserPrompt,
  parseCrestodianAssistantPlanText,
  type CrestodianAssistantPlan,
  type CrestodianAssistantTurn,
} from "./assistant-prompts.js";
import { CrestodianInferenceUnavailableError } from "./inference-error.js";
import type { CrestodianOverview } from "./overview.js";
import {
  resolveCrestodianExpectedAgentHarnessRuntimeArtifact,
  resolveCrestodianVerifiedInferenceRoute,
  type CrestodianVerifiedInferenceBinding,
  type CrestodianVerifiedInferenceDeps,
} from "./verified-inference.js";

export {
  buildCrestodianAssistantUserPrompt,
  parseCrestodianAssistantPlanText,
  type CrestodianAssistantPlan,
  type CrestodianAssistantTurn,
} from "./assistant-prompts.js";

export type CrestodianAssistantPlanner = (params: {
  input: string;
  overview: CrestodianOverview;
  history?: CrestodianAssistantTurn[];
  pendingOperation?: string;
  readonly verifiedInference: CrestodianVerifiedInferenceBinding;
}) => Promise<CrestodianAssistantPlan | null>;

type RunCliAgentFn = typeof import("../agents/cli-runner.js").runCliAgent;
type RunEmbeddedAgentFn = typeof import("../agents/embedded-agent.js").runEmbeddedAgent;

export type CrestodianConfiguredModelPlannerDeps = CrestodianVerifiedInferenceDeps & {
  runCliAgent?: RunCliAgentFn;
  runEmbeddedAgent?: RunEmbeddedAgentFn;
  createTempDir?: () => Promise<string>;
  removeTempDir?: (dir: string) => Promise<void>;
};

export async function planCrestodianCommand(params: {
  input: string;
  overview: CrestodianOverview;
  history?: CrestodianAssistantTurn[];
  pendingOperation?: string;
  readonly verifiedInference: CrestodianVerifiedInferenceBinding;
  deps?: CrestodianConfiguredModelPlannerDeps;
}): Promise<CrestodianAssistantPlan | null> {
  return await planCrestodianCommandWithConfiguredModel(params);
}

/** Plan only through the configured default agent's verified route. */
export async function planCrestodianCommandWithConfiguredModel(params: {
  input: string;
  overview: CrestodianOverview;
  history?: CrestodianAssistantTurn[];
  pendingOperation?: string;
  readonly verifiedInference: CrestodianVerifiedInferenceBinding;
  deps?: CrestodianConfiguredModelPlannerDeps;
}): Promise<CrestodianAssistantPlan | null> {
  const route = await requireVerifiedPlannerRoute(params.verifiedInference, params.deps);
  const input = params.input.trim();
  if (!input) {
    return null;
  }
  let expectedAgentHarnessRuntimeArtifact: ReturnType<
    typeof resolveCrestodianExpectedAgentHarnessRuntimeArtifact
  >;
  try {
    expectedAgentHarnessRuntimeArtifact = resolveCrestodianExpectedAgentHarnessRuntimeArtifact(
      params.verifiedInference,
    );
  } catch (error) {
    throw new CrestodianInferenceUnavailableError("planner", [error]);
  }
  const prompt = buildCrestodianAssistantUserPrompt({
    input,
    overview: params.overview,
    ...(params.history ? { history: params.history } : {}),
    ...(params.pendingOperation ? { pendingOperation: params.pendingOperation } : {}),
  });
  const tempDir = await (params.deps?.createTempDir ?? createTempPlannerDir)();
  let plan: CrestodianAssistantPlan | null;
  try {
    const runId = `crestodian-planner-${randomUUID()}`;
    const shared = {
      sessionId: `${runId}-session`,
      agentId: "crestodian",
      trigger: "manual" as const,
      sessionFile: path.join(tempDir, "session.jsonl"),
      workspaceDir: tempDir,
      cwd: tempDir,
      agentDir: route.agentDir,
      config: route.runConfig,
      prompt,
      provider: route.provider,
      model: route.model,
      timeoutMs: CRESTODIAN_ASSISTANT_TIMEOUT_MS,
      runId,
      extraSystemPrompt: CRESTODIAN_ASSISTANT_SYSTEM_PROMPT,
      extraSystemPromptStatic: CRESTODIAN_ASSISTANT_SYSTEM_PROMPT,
      messageChannel: "crestodian",
      messageProvider: "crestodian",
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
    const parsed = parseCrestodianAssistantPlanText(extractPlannerResultText(result));
    plan = parsed ? { ...parsed, modelLabel: route.modelLabel } : null;
  } catch (error) {
    if (error instanceof CrestodianInferenceUnavailableError) {
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
  binding: CrestodianVerifiedInferenceBinding | undefined,
  deps: CrestodianConfiguredModelPlannerDeps | undefined,
) {
  if (!binding) {
    throw new CrestodianInferenceUnavailableError("planner");
  }
  try {
    const route = await resolveCrestodianVerifiedInferenceRoute(binding, deps);
    if (route) {
      return route;
    }
  } catch (error) {
    throw new CrestodianInferenceUnavailableError("planner", [error]);
  }
  throw new CrestodianInferenceUnavailableError("planner");
}

async function createTempPlannerDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-crestodian-planner-"));
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
