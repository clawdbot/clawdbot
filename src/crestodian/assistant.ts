import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { extractAssistantText } from "../agents/pi-embedded-utils.js";
import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
} from "../agents/simple-completion-runtime.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { selectCrestodianLocalPlannerBackends } from "./assistant-backends.js";
import {
  CRESTODIAN_ASSISTANT_MAX_TOKENS,
  CRESTODIAN_ASSISTANT_SYSTEM_PROMPT,
  CRESTODIAN_ASSISTANT_TIMEOUT_MS,
  buildCrestodianAssistantUserPrompt,
  parseCrestodianAssistantPlanText,
  type CrestodianAssistantPlan,
} from "./assistant-prompts.js";
import type { CrestodianOverview } from "./overview.js";

export {
  buildCrestodianAssistantUserPrompt,
  parseCrestodianAssistantPlanText,
  type CrestodianAssistantPlan,
} from "./assistant-prompts.js";

export type CrestodianAssistantPlanner = (params: {
  input: string;
  overview: CrestodianOverview;
}) => Promise<CrestodianAssistantPlan | null>;

type RunCliAgentFn = typeof import("../agents/cli-runner.js").runCliAgent;
type RunEmbeddedPiAgentFn = typeof import("../agents/pi-embedded.js").runEmbeddedPiAgent;
type ReadConfigFileSnapshotFn = typeof readConfigFileSnapshot;
type PrepareSimpleCompletionModelForAgentFn = typeof prepareSimpleCompletionModelForAgent;
type CompleteWithPreparedSimpleCompletionModelFn = typeof completeWithPreparedSimpleCompletionModel;

export type CrestodianConfiguredModelPlannerDeps = {
  readConfigFileSnapshot?: ReadConfigFileSnapshotFn;
  prepareSimpleCompletionModelForAgent?: PrepareSimpleCompletionModelForAgentFn;
  completeWithPreparedSimpleCompletionModel?: CompleteWithPreparedSimpleCompletionModelFn;
};

export type CrestodianLocalRuntimePlannerDeps = {
  runCliAgent?: RunCliAgentFn;
  runEmbeddedPiAgent?: RunEmbeddedPiAgentFn;
  createTempDir?: () => Promise<string>;
  removeTempDir?: (dir: string) => Promise<void>;
};

export type CrestodianPlannerDeps = CrestodianConfiguredModelPlannerDeps &
  CrestodianLocalRuntimePlannerDeps;

export async function planCrestodianCommand(params: {
  input: string;
  overview: CrestodianOverview;
  deps?: CrestodianPlannerDeps;
}): Promise<CrestodianAssistantPlan | null> {
  const configured = await planCrestodianCommandWithConfiguredModel(params);
  if (configured) {
    return configured;
  }
  return await planCrestodianCommandWithLocalRuntime(params);
}

export async function planCrestodianCommandWithConfiguredModel(params: {
  input: string;
  overview: CrestodianOverview;
  deps?: CrestodianConfiguredModelPlannerDeps;
}): Promise<CrestodianAssistantPlan | null> {
  const input = params.input.trim();
  if (!input) {
    return null;
  }
  const snapshot = await (params.deps?.readConfigFileSnapshot ?? readConfigFileSnapshot)();
  if (!snapshot.exists || !snapshot.valid) {
    return null;
  }
  const cfg = snapshot.runtimeConfig ?? snapshot.config;
  const agentId = resolveDefaultAgentId(cfg);
  const prepared = await (
    params.deps?.prepareSimpleCompletionModelForAgent ?? prepareSimpleCompletionModelForAgent
  )({
    cfg,
    agentId,
    allowMissingApiKeyModes: ["aws-sdk"],
  });
  if ("error" in prepared) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CRESTODIAN_ASSISTANT_TIMEOUT_MS);
  try {
    const response = await (
      params.deps?.completeWithPreparedSimpleCompletionModel ??
      completeWithPreparedSimpleCompletionModel
    )({
      model: prepared.model,
      auth: prepared.auth,
      context: {
        systemPrompt: CRESTODIAN_ASSISTANT_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: buildCrestodianAssistantUserPrompt({
              input,
              overview: params.overview,
            }),
            timestamp: Date.now(),
          },
        ],
      },
      options: {
        maxTokens: CRESTODIAN_ASSISTANT_MAX_TOKENS,
        signal: controller.signal,
      },
    });
    const parsed = parseCrestodianAssistantPlanText(extractAssistantText(response));
    if (!parsed) {
      return null;
    }
    return {
      ...parsed,
      modelLabel: `${prepared.selection.provider}/${prepared.selection.modelId}`,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function planCrestodianCommandWithLocalRuntime(params: {
  input: string;
  overview: CrestodianOverview;
  deps?: CrestodianLocalRuntimePlannerDeps;
}): Promise<CrestodianAssistantPlan | null> {
  const input = params.input.trim();
  if (!input) {
    return null;
  }
  const backends = selectCrestodianLocalPlannerBackends(params.overview);
  if (backends.length === 0) {
    return null;
  }
  const prompt = buildCrestodianAssistantUserPrompt({
    input,
    overview: params.overview,
  });

  for (const backend of backends) {
    try {
      const rawText = await runLocalRuntimePlanner(backend, {
        prompt,
        deps: params.deps,
      });
      const parsed = parseCrestodianAssistantPlanText(rawText);
      if (parsed) {
        return {
          ...parsed,
          modelLabel: backend.label,
        };
      }
    } catch {
      // Try the next locally available runtime. Crestodian must keep booting.
    }
  }
  return null;
}

async function runLocalRuntimePlanner(
  backend: ReturnType<typeof selectCrestodianLocalPlannerBackends>[number],
  params: {
    prompt: string;
    deps?: CrestodianLocalRuntimePlannerDeps;
  },
): Promise<string | undefined> {
  const tempDir = await (params.deps?.createTempDir ?? createTempPlannerDir)();
  try {
    const runId = `crestodian-planner-${randomUUID()}`;
    const sessionFile = path.join(tempDir, "session.jsonl");
    const sessionId = `${runId}-session`;
    const sessionKey = `temp:crestodian-planner:${runId}`;
    switch (backend.runner) {
      case "cli": {
        const runCli = params.deps?.runCliAgent ?? (await loadRunCliAgent());
        const result = await runCli({
          sessionId,
          sessionKey,
          agentId: "crestodian",
          trigger: "manual",
          sessionFile,
          workspaceDir: tempDir,
          config: backend.buildConfig(tempDir),
          prompt: params.prompt,
          provider: backend.provider,
          model: backend.model,
          timeoutMs: CRESTODIAN_ASSISTANT_TIMEOUT_MS,
          runId,
          extraSystemPrompt: CRESTODIAN_ASSISTANT_SYSTEM_PROMPT,
          extraSystemPromptStatic: CRESTODIAN_ASSISTANT_SYSTEM_PROMPT,
          messageChannel: "crestodian",
          messageProvider: "crestodian",
          senderIsOwner: true,
          cleanupCliLiveSessionOnRunEnd: true,
        });
        return extractPlannerResultText(result);
      }
      case "embedded": {
        const runEmbedded = params.deps?.runEmbeddedPiAgent ?? (await loadRunEmbeddedPiAgent());
        const result = await runEmbedded({
          sessionId,
          sessionKey,
          agentId: "crestodian",
          trigger: "manual",
          sessionFile,
          workspaceDir: tempDir,
          config: backend.buildConfig(tempDir),
          prompt: params.prompt,
          provider: backend.provider,
          model: backend.model,
          agentHarnessId: "codex",
          disableTools: true,
          toolsAllow: [],
          timeoutMs: CRESTODIAN_ASSISTANT_TIMEOUT_MS,
          runId,
          extraSystemPrompt: CRESTODIAN_ASSISTANT_SYSTEM_PROMPT,
          messageChannel: "crestodian",
          messageProvider: "crestodian",
          senderIsOwner: true,
          cleanupBundleMcpOnRunEnd: true,
        });
        return extractPlannerResultText(result);
      }
    }
    return undefined;
  } finally {
    await (params.deps?.removeTempDir ?? removeTempPlannerDir)(tempDir);
  }
}

async function createTempPlannerDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-crestodian-planner-"));
}

async function removeTempPlannerDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

async function loadRunCliAgent(): Promise<RunCliAgentFn> {
  return (await import("../agents/cli-runner.js")).runCliAgent;
}

async function loadRunEmbeddedPiAgent(): Promise<RunEmbeddedPiAgentFn> {
  return (await import("../agents/pi-embedded.js")).runEmbeddedPiAgent;
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
