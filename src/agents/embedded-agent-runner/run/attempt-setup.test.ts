import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachRuntimePromptMediaFacts } from "../../../media/media-facts.js";
import type { ProviderRuntimePluginHandle } from "../../../plugins/provider-hook-runtime.js";
import { castAgentMessage } from "../../test-helpers/agent-message-fixtures.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const resolveProviderRuntimePluginHandle = vi.hoisted(() => vi.fn());
const resolveSandboxContext = vi.hoisted(() => vi.fn(async () => null));

vi.mock("../../../plugins/provider-hook-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/provider-hook-runtime.js")>()),
  resolveProviderRuntimePluginHandle,
}));

vi.mock("../../sandbox.js", () => ({ resolveSandboxContext }));

import {
  installEmbeddedAttemptContextGuards,
  prepareEmbeddedAttemptSkills,
  prepareEmbeddedAttemptSetup,
  resolveAttemptWorkspaceSandbox,
} from "./attempt-setup.js";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==";

describe("prepareEmbeddedAttemptSetup", () => {
  beforeEach(() => {
    resolveProviderRuntimePluginHandle.mockReset();
    resolveSandboxContext.mockClear();
  });

  it("prepares the default and session agent identities together", async () => {
    const setup = await prepareEmbeddedAttemptSetup({
      config: {
        agents: {
          list: [{ id: "main", default: true }, { id: "marketing" }],
        },
      },
      modelId: "gpt-5.4",
      provider: "openai",
      runId: "run-prepared-agent-identities",
      sessionId: "session-prepared-agent-identities",
      sessionKey: "agent:marketing:main",
      thinkLevel: "high",
      timeoutMs: 30_000,
      workspaceDir: path.join(os.tmpdir(), "openclaw-attempt-setup-agent-identities"),
    } as unknown as EmbeddedRunAttemptParams);

    expect(setup.defaultAgentId).toBe("main");
    expect(setup.sessionAgentId).toBe("marketing");
  });

  it("hydrates recent history media from the prepared session agent workspace", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attempt-history-"));
    const imagePath = path.join(workspaceDir, "photo.png");
    await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
    const agent = {} as {
      transformContext?: (messages: unknown[], signal?: AbortSignal) => Promise<unknown[]>;
    };
    const settingsManager = { getBlockImages: () => false };
    const guards = installEmbeddedAttemptContextGuards({
      activeSession: { agent, settingsManager } as never,
      agentDir: workspaceDir,
      attempt: {
        config: { agents: { list: [{ id: "marketing", workspace: workspaceDir }] } },
        contextTokenBudget: 32_000,
        model: { input: ["text", "image"] },
        modelId: "gpt-5.4",
        provider: "openai",
      } as unknown as EmbeddedRunAttemptParams,
      computerContextEpoch: { value: 0 },
      dropThinkingBlocksForEstimate: false,
      effectiveCwd: workspaceDir,
      effectiveFsWorkspaceOnly: false,
      effectiveWorkspace: workspaceDir,
      getPrePromptMessageCount: () => 0,
      getPromptCache: () => undefined,
      getPromptCacheRetention: () => undefined,
      getSystemPrompt: () => "",
      isOpenAIResponsesApi: false,
      repairToolUseResultPairing: false,
      sessionAgentId: "marketing",
      sessionManager: {} as never,
      settingsManager: settingsManager as never,
    });
    const message = attachRuntimePromptMediaFacts(
      castAgentMessage({ role: "user", content: [{ type: "text", text: "describe" }] }),
      [{ path: imagePath, contentType: "image/png" }],
    );

    try {
      if (!agent.transformContext) {
        throw new Error("expected installed history transform");
      }
      const replay = await agent.transformContext([message]);
      expect((replay[0] as { content?: unknown }).content).toEqual([
        { type: "text", text: "describe" },
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ]);
    } finally {
      guards.remove();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("prepares one closed session permission policy", async () => {
    const root = path.join(os.tmpdir(), "openclaw-attempt-permission-root");
    const setup = await prepareEmbeddedAttemptSetup({
      config: {},
      modelId: "gpt-5.4",
      permissionMode: "workspace",
      provider: "openai",
      runId: "run-prepared-permission",
      sessionId: "session-prepared-permission",
      sessionRoot: root,
      thinkLevel: "high",
      timeoutMs: 30_000,
      workspaceDir: root,
    } as unknown as EmbeddedRunAttemptParams);

    expect(setup.sessionPermissionPolicy).toEqual({ root, mode: "workspace" });
  });

  it("passes the resolved skill snapshot into sandbox synchronization", async () => {
    const skillsSnapshot = {
      prompt: "skills",
      skills: [{ name: "alpha" }],
      resolvedSkills: [],
      version: 42,
    };

    await prepareEmbeddedAttemptSetup({
      config: {},
      modelId: "gpt-5.4",
      provider: "openai",
      runId: "run-sandbox-skills",
      sessionId: "session-sandbox-skills",
      sessionKey: "agent:main:main",
      skillsSnapshot,
      thinkLevel: "high",
      timeoutMs: 30_000,
      workspaceDir: path.join(os.tmpdir(), "openclaw-attempt-setup-sandbox-skills"),
    } as unknown as EmbeddedRunAttemptParams);

    expect(resolveSandboxContext).toHaveBeenCalledWith(expect.objectContaining({ skillsSnapshot }));
  });

  it.each(["ro", "rw"] as const)(
    "keeps collection review on the host workspace with %s sandbox access",
    async (workspaceAccess) => {
      const workspaceDir = path.join(os.tmpdir(), "openclaw-attempt-setup-collection-review");
      const setup = await resolveAttemptWorkspaceSandbox({
        agentId: "main",
        config: { agents: { defaults: { sandbox: { mode: "all", workspaceAccess } } } },
        sessionId: "session-collection-review",
        sessionKey: "agent:main:skill-collection-review",
        skillWorkshopCollectionReconcile: {},
        workspaceDir,
      });

      expect(resolveSandboxContext).not.toHaveBeenCalled();
      expect(setup.effectiveWorkspace).toBe(workspaceDir);
    },
  );

  it("reuses lifecycle metadata and the provider handle from the runtime plan", async () => {
    const metadataSnapshot = { plugins: [] } as never;
    const workspaceDir = path.join(os.tmpdir(), "openclaw-attempt-setup-prepared");
    const providerRuntimeHandle: ProviderRuntimePluginHandle & { prepared: true } = {
      provider: "openai",
      modelId: "gpt-5.4",
      prepared: true,
      workspaceDir,
      plugin: {} as never,
    };
    const setup = await prepareEmbeddedAttemptSetup({
      config: {},
      modelId: "gpt-5.4",
      provider: "openai",
      runId: "run-prepared",
      sessionId: "session-prepared",
      thinkLevel: "high",
      timeoutMs: 30_000,
      workspaceDir,
      preparedModelRuntime: { metadataSnapshot } as never,
      runtimePlan: { providerRuntimeHandle } as never,
    } as unknown as EmbeddedRunAttemptParams);

    expect(setup.getCurrentAttemptPluginMetadataSnapshot()).toBe(metadataSnapshot);
    expect(setup.getProviderRuntimeHandle()).toBe(providerRuntimeHandle);
    expect(resolveProviderRuntimePluginHandle).not.toHaveBeenCalled();
  });

  it("resolves partial handles without trusting scoped metadata", async () => {
    const resolvedHandle: ProviderRuntimePluginHandle = {
      provider: "openai",
      modelId: "gpt-5.4",
    };
    resolveProviderRuntimePluginHandle.mockReturnValue(resolvedHandle);
    const setup = await prepareEmbeddedAttemptSetup({
      config: {},
      modelId: "gpt-5.4",
      provider: "openai",
      runId: "run-partial",
      sessionId: "session-partial",
      thinkLevel: "high",
      timeoutMs: 30_000,
      workspaceDir: path.join(os.tmpdir(), "openclaw-attempt-setup-partial"),
      preparedModelRuntime: {
        metadataSnapshot: { pluginIds: ["other"] },
      } as never,
      runtimePlan: { providerRuntimeHandle: { provider: "openai" } } as never,
    } as unknown as EmbeddedRunAttemptParams);

    const preparedHandle = setup.getProviderRuntimeHandle();
    expect(preparedHandle).toMatchObject(resolvedHandle);
    expect(preparedHandle.modelId).toBe("gpt-5.4");
    expect(setup.getProviderRuntimeHandle()).toBe(preparedHandle);
    expect(resolveProviderRuntimePluginHandle).toHaveBeenCalledOnce();
    const call = resolveProviderRuntimePluginHandle.mock.calls[0]?.[0];
    expect(call).toMatchObject({ provider: "openai", modelId: "gpt-5.4" });
    expect(call).not.toHaveProperty("pluginMetadataSnapshot");
  });
});

describe("prepareEmbeddedAttemptSkills", () => {
  it("discovers fallback skills from the configured agent workspace", async () => {
    const agentWorkspace = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-skills-")),
    );
    const executionWorkspace = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-execution-skills-")),
    );
    const writeSkill = async (workspaceDir: string, name: string) => {
      const skillDir = path.join(workspaceDir, "skills", name);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name} description\n---\n\n# ${name}\n`,
      );
    };
    await writeSkill(agentWorkspace, "agent-workspace-skill");
    await writeSkill(executionWorkspace, "execution-workspace-skill");

    try {
      const prepared = prepareEmbeddedAttemptSkills({
        attempt: {
          bootstrapWorkspaceDir: agentWorkspace,
          config: {},
        } as EmbeddedRunAttemptParams,
        effectiveWorkspace: executionWorkspace,
        sandbox: null,
        sessionAgentId: "main",
      });
      try {
        expect(prepared.skillsPrompt).toContain("agent-workspace-skill");
        expect(prepared.skillsPrompt).not.toContain("execution-workspace-skill");
      } finally {
        prepared.restoreSkillEnv();
      }
    } finally {
      await fs.rm(agentWorkspace, { recursive: true, force: true });
      await fs.rm(executionWorkspace, { recursive: true, force: true });
    }
  });
});
