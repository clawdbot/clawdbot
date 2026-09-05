import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { prepareEmbeddedAttemptBootstrap } from "../agents/embedded-agent-runner/run/attempt-bootstrap-prepare.js";
import type { EmbeddedRunAttemptParams } from "../agents/embedded-agent-runner/run/types.js";
import type { AgentExecutionAuthBinding } from "../agents/execution-auth-binding.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import type { ActivateSetupInferenceDeps } from "./setup-inference-core.js";
import type { SetupInferenceTestPlan } from "./setup-inference-plan-helpers.js";
import { runSetupInferenceTest } from "./setup-inference-test.js";

const tempRoots = createSuiteTempRootTracker({ prefix: "setup-local-agent-probe-" });
beforeEach(() => tempRoots.setup());
afterEach(() => tempRoots.cleanup());

type RunEmbeddedAgent = NonNullable<ActivateSetupInferenceDeps["runEmbeddedAgent"]>;
type RunParams = Parameters<RunEmbeddedAgent>[0];
const auth: AgentExecutionAuthBinding = {
  agentHarnessId: "fixture-harness",
  modelId: "fixture-model",
  authFingerprint: "fixture-owner",
};

function plan(managed = true, supportsTools = true): SetupInferenceTestPlan {
  return {
    runner: "embedded",
    provider: "local-fixture",
    model: "fixture-model",
    modelRef: "local-fixture/fixture-model",
    agentHarnessRuntimeOverride: "fixture-harness",
    routeAgentId: "main",
    config: {
      models: {
        providers: {
          "local-fixture": {
            baseUrl: "http://127.0.0.1:12345/v1",
            models: [
              {
                id: "fixture-model",
                name: "Fixture model",
                input: ["text"],
                reasoning: false,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextTokens: 16_384,
                maxTokens: 1_024,
                compat: { supportsTools },
              },
            ],
            ...(managed ? { localService: { command: "/fixture/server" } } : {}),
          },
        },
      },
    },
  };
}

function reply(text: string) {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 1,
      executionTrace: { winnerProvider: "local-fixture", winnerModel: "fixture-model" },
    },
  };
}

async function readFixture(input: RunParams) {
  const files = await fs.readdir(input.workspaceDir);
  expect(files).toHaveLength(1);
  const nonce = await fs.readFile(path.join(input.workspaceDir, files[0]!), "utf8");
  expect(input.prompt).not.toContain(nonce);
  return nonce;
}

async function probe(
  run: RunEmbeddedAgent,
  input?: {
    managed?: boolean;
    supportsTools?: boolean;
    verifyAgentTools?: boolean;
    prompt?: string;
    signal?: AbortSignal;
    plan?: SetupInferenceTestPlan;
  },
) {
  const tempDir = await tempRoots.make("case");
  const selectedPlan = input?.plan ?? plan(input?.managed, input?.supportsTools);
  selectedPlan.agentDir = path.join(tempDir, "agent");
  return await runSetupInferenceTest({
    plan: selectedPlan,
    tempDir,
    deps: { runEmbeddedAgent: run },
    authProfileStateMode: "read-only",
    requireExecutionOwner: true,
    verifyAgentTools: input?.verifyAgentTools ?? true,
    ...(input?.prompt ? { prompt: input.prompt } : {}),
    ...(input?.signal ? { signal: input.signal } : {}),
  });
}

describe("managed local model setup verification", () => {
  it("requires a real read result and final answer on the selected isolated runtime", async () => {
    const ambientWorkspace = await tempRoots.make("ambient-workspace");
    await fs.writeFile(path.join(ambientWorkspace, "AGENTS.md"), "Ambient agent instructions");
    const selectedPlan = plan();
    selectedPlan.config.agents = {
      defaults: { contextInjection: "never" },
      entries: {
        other: { workspace: "/other/workspace" },
        main: {
          workspace: ambientWorkspace,
          contextInjection: "always",
          model: selectedPlan.modelRef,
          params: { temperature: 0.2 },
          tools: { profile: "coding" },
          experimental: { localModelLean: false },
        },
      },
    };
    selectedPlan.executionConfig = { ...selectedPlan.config, tools: { allow: ["read"] } };
    const originalConfig = structuredClone(selectedPlan.executionConfig);
    let workspace: string | undefined;
    let bootstrapWorkspace: string | undefined;
    let bootstrap: Awaited<ReturnType<typeof prepareEmbeddedAttemptBootstrap>> | undefined;
    let toolRunConfig: RunParams["config"];
    const run = vi.fn<RunEmbeddedAgent>(async (input) => {
      input.onSuccessfulAuthBinding?.(auth);
      if (input.disableTools) {
        expect(input.modelRun).toBe(true);
        return reply("OK");
      }
      workspace = input.workspaceDir;
      expect(input.agentHarnessRuntimeOverride).toBe("fixture-harness");
      expect(input.modelRun).toBeUndefined();
      expect(input.sessionPersistence).toBe("detached");
      expect(input.toolsAllow).toEqual(["read"]);
      expect(input.toolExecutionAllow).toEqual(["read"]);
      expect(input.permissionMode).toBe("read-only");
      expect(input.sessionRoot).toBe(workspace);
      expect(input.agentDir?.startsWith(`${workspace}${path.sep}`)).toBe(false);
      toolRunConfig = input.config;
      bootstrapWorkspace = resolveAgentWorkspaceDir(input.config!, input.agentId!);
      bootstrap = await prepareEmbeddedAttemptBootstrap({
        attempt: {
          sessionId: input.sessionId,
          sessionKey: input.sessionKey,
          trigger: "manual",
          isCanonicalWorkspace: bootstrapWorkspace === workspace,
          config: input.config,
        } as EmbeddedRunAttemptParams,
        bootstrapWorkspaceDir: bootstrapWorkspace,
        effectiveWorkspace: workspace,
        hasReadTool: true,
        isRawModelRun: false,
        markStage: () => undefined,
        resolvedWorkspace: workspace,
        sessionAgentId: input.agentId!,
        sessionLabel: input.sessionKey!,
      });
      const nonce = await readFixture(input);
      input.onAgentToolResult?.({
        toolName: "read",
        result: { content: [{ type: "text", text: nonce }] },
        isError: false,
      });
      return reply(`The file contains: ${nonce}`);
    });
    expect(await probe(run, { plan: selectedPlan })).toMatchObject({ ok: true, auth });
    expect(bootstrap?.contextFiles).toEqual([]);
    expect(bootstrapWorkspace).toBe(workspace);
    expect(toolRunConfig).toEqual({
      ...originalConfig,
      agents: {
        ...originalConfig.agents,
        entries: {
          ...originalConfig.agents?.entries,
          main: {
            ...originalConfig.agents?.entries?.main,
            workspace,
            contextInjection: "never",
          },
        },
      },
    });
    expect(selectedPlan.executionConfig).toEqual(originalConfig);
    expect(run).toHaveBeenCalledTimes(2);
    await expect(fs.stat(workspace!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["missing read", "failed read", "wrong answer", "changed owner"])(
    "rejects %s instead of declaring the candidate verified",
    async (failure) => {
      let workspace: string | undefined;
      const run = vi.fn<RunEmbeddedAgent>(async (input) => {
        input.onSuccessfulAuthBinding?.(
          !input.disableTools && failure === "changed owner"
            ? { ...auth, authFingerprint: "another-owner" }
            : auth,
        );
        if (input.disableTools) {
          return reply("OK");
        }
        workspace = input.workspaceDir;
        const nonce = await readFixture(input);
        if (failure !== "missing read") {
          input.onAgentToolResult?.({
            toolName: "read",
            result: { content: [{ type: "text", text: nonce }] },
            isError: failure === "failed read",
          });
        }
        return reply(failure === "wrong answer" ? "Something else" : nonce);
      });
      expect(await probe(run)).toMatchObject({
        ok: false,
        status: failure === "changed owner" ? "auth" : "format",
      });
      await expect(fs.stat(workspace!)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([
    { phase: "response", failConnection: true },
    { phase: "tool-use", failConnection: false },
  ])(
    "reports the failed $phase check without suggesting an unrelated timeout setting",
    async ({ phase, failConnection }) => {
      const run = vi.fn<RunEmbeddedAgent>(async (input) => {
        input.onSuccessfulAuthBinding?.(auth);
        if (input.disableTools && !failConnection) {
          return reply("OK");
        }
        return {
          payloads: [
            {
              text: "Request timed out before a response was generated. Please try again, or increase `agents.defaults.timeoutSeconds` in your config.",
              isError: true,
            },
          ],
          meta: { durationMs: 90_000 },
        };
      });
      expect(await probe(run)).toEqual({
        ok: false,
        status: "timeout",
        error: `The setup ${phase} check timed out. Retry setup, or choose another model or runtime. No default model was changed.`,
      });
    },
  );

  it.each([
    { managed: false },
    { verifyAgentTools: false },
    { supportsTools: false },
    { prompt: "Answer a custom question" },
  ])(
    "keeps ordinary verification, tool-free models, and custom completions tool-free: %j",
    async (input) => {
      const run = vi.fn<RunEmbeddedAgent>(async (params) => {
        params.onSuccessfulAuthBinding?.(auth);
        expect(params.disableTools).toBe(true);
        return reply("OK");
      });
      expect(await probe(run, input)).toMatchObject({ ok: true });
      expect(run).toHaveBeenCalledOnce();
    },
  );

  it("cleans its fixture when the selected runtime cancels", async () => {
    const controller = new AbortController();
    let workspace: string | undefined;
    const run = vi.fn<RunEmbeddedAgent>(async (input) => {
      input.onSuccessfulAuthBinding?.(auth);
      if (!input.disableTools) {
        workspace = input.workspaceDir;
        controller.abort();
      }
      return reply("OK");
    });
    expect(await probe(run, { signal: controller.signal })).toMatchObject({ ok: false });
    await expect(fs.stat(workspace!)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
