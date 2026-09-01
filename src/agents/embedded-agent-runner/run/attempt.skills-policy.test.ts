import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveInternalSessionEffectsIdentity } from "../../../config/sessions/internal-session-key.js";
import { readNestedToolActivity } from "../../../sessions/nested-tool-activity.js";
import { createFixtureSkillEntry } from "../../../skills/test-support/test-helpers.js";
import {
  runSkillExperienceReview,
  type ExperienceReviewCandidate,
} from "../../../skills/workshop/experience-review.js";
import {
  bindActiveOperatorTurnAuthority,
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../cron-creator-authority-context.js";
import { SessionManager } from "../../sessions/session-manager.js";
import type {
  ToolSearchCatalogRef,
  ToolSearchCatalogToolExecutor,
} from "../../tool-search-types.js";
import { createToolSearchTools } from "../../tool-search.js";
import type { AnyAgentTool } from "../../tools/common.js";
import {
  beginPromptCacheObservation,
  collectPromptCacheTools,
} from "../prompt-cache-observability.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";
import type { RunEmbeddedAgentParams } from "./params.js";

const reviewRunEmbeddedAgent = vi.hoisted(() => vi.fn());

vi.mock("../../embedded-agent.js", () => ({ runEmbeddedAgent: reviewRunEmbeddedAgent }));

const hoisted = getHoisted();
const tempPaths: string[] = [];
const skillsPrompt = [
  "<available_skills>",
  "  <skill>",
  "    <name>demo</name>",
  "    <description>demo description</description>",
  "    <location>/skills/demo/SKILL.md</location>",
  "  </skill>",
  "</available_skills>",
].join("\n");

beforeAll(async () => {
  await preloadRunEmbeddedAttemptForTests();
});

beforeEach(() => {
  resetEmbeddedAttemptHarness();
  reviewRunEmbeddedAgent.mockReset();
});

afterEach(async () => {
  await cleanupTempPaths(tempPaths);
  vi.restoreAllMocks();
});

describe("runEmbeddedAttempt skill policy projections", () => {
  it.each([
    {
      label: "local operator CLI",
      context: {
        trigger: "manual" as const,
        cronCreatorCallerOrigin: { kind: "local" as const },
      },
    },
    {
      label: "Telegram group",
      context: {
        trigger: "user" as const,
        messageChannel: "telegram",
        senderId: "sender-1",
      },
    },
  ])("keeps cache state identical for $label", async ({ context }) => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-review-parity-"));
    tempPaths.push(workspaceDir);
    const foregroundPromptContext = {
      agentId: "main",
      agentDir: workspaceDir,
      workspaceDir,
      cwd: workspaceDir,
      sandboxSessionKey: "agent:main:main",
      promptCacheKey: "foreground-cache-prefix",
      reasoningLevel: "on" as const,
      ...context,
    };
    const tool = (name: string): AnyAgentTool =>
      ({
        name,
        label: name,
        description: `${name} tool`,
        parameters: { type: "object", properties: {} },
        execute: async () => ({
          content: [{ type: "text" as const, text: "ok" }],
          details: undefined,
        }),
      }) as AnyAgentTool;
    const snapshots: Array<{
      toolNames: string[];
      toolDigest: string;
      systemPromptDigest: string;
    }> = [];
    hoisted.createOpenClawCodingToolsMock.mockImplementation((...args: unknown[]) => {
      const options = args[0] as {
        messageChannel?: string;
        runId?: string;
        senderId?: string | null;
      };
      const operatorAuthority = bindActiveOperatorTurnAuthority(options.runId);
      const hasCaller =
        operatorAuthority?.source === "local" ||
        (options.messageChannel === "telegram" && Boolean(options.senderId?.trim()));
      return [tool("skill_workshop"), ...(hasCaller ? [tool("transcripts")] : [])];
    });
    const captureToolSurface = (options: {
      messageChannel?: string;
      runId?: string;
      senderId?: string | null;
    }) => {
      const tools = hoisted.createOpenClawCodingToolsMock(options) as AnyAgentTool[];
      const toolNames = tools.map((entry) => entry.name);
      const snapshot = beginPromptCacheObservation({
        sessionId: "embedded-session",
        sessionKey: "agent:main:main",
        provider: "openai",
        modelId: "gpt-test",
        streamStrategy: "test",
        systemPrompt: `system:${toolNames.join(",")}`,
        tools: collectPromptCacheTools(tools),
      }).snapshot;
      return {
        toolNames,
        toolDigest: snapshot.toolDigest,
        systemPromptDigest: snapshot.systemPromptDigest,
      };
    };

    const runId = "foreground-parity-run";
    const foregroundCapability = foregroundPromptContext.cronCreatorCallerOrigin
      ? createCronCreatorAuthorityCapability(runId, { kind: "local" })
      : undefined;
    const foregroundRun = () => captureToolSurface({ ...foregroundPromptContext, runId });
    snapshots.push(
      foregroundCapability
        ? runWithCronCreatorAuthorityCapability(foregroundCapability, foregroundRun)
        : foregroundRun(),
    );

    reviewRunEmbeddedAgent.mockImplementation(async (params: RunEmbeddedAgentParams) => {
      snapshots.push(captureToolSurface(params));
      return { meta: { durationMs: 1 } };
    });
    const reviewCandidate: ExperienceReviewCandidate = {
      ctx: {
        agentId: "main",
        runId,
        sessionId: "review-session",
        sessionKey: "agent:main:review",
        workspaceDir,
        modelProviderId: "openai",
        modelId: "gpt-test",
        skillWorkshopAvailable: true,
        foregroundPromptContext,
      },
      config: { skills: { workshop: { autonomous: { mode: "propose" } } } },
    };
    await runSkillExperienceReview(reviewCandidate, {
      getCurrentConfig: () => reviewCandidate.config ?? {},
    });
    expect(snapshots[1]).toEqual(snapshots[0]);
  });

  it("keeps review prompt digests equal on a private session without persistence", async () => {
    const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-review-parity-"));
    tempPaths.push(sessionRoot);
    const transcriptFile = path.join(sessionRoot, "transcript.jsonl");
    const storeFile = path.join(sessionRoot, "sessions.json");
    await fs.writeFile(
      transcriptFile,
      '{"type":"message","message":{"role":"user","content":"seed"}}\n',
    );
    await fs.writeFile(storeFile, '{"agent:main:main":{"sessionId":"embedded-session"}}\n');
    const beforeTranscript = await fs.readFile(transcriptFile);
    const beforeStore = await fs.readFile(storeFile);
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: undefined,
    }));
    const codingTools = [
      {
        name: "skill_workshop",
        label: "Skill Workshop",
        description: "Workshop",
        parameters: { type: "object", properties: {} },
        execute,
      },
      {
        name: "message",
        label: "Message",
        description: "Send a message",
        parameters: { type: "object", properties: {} },
        execute,
      },
      {
        name: "read",
        label: "Read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        execute,
      },
    ] as AnyAgentTool[];

    const foregroundSession = {
      sessionId: "embedded-session",
      sessionKey: "agent:main:main",
    };
    const reviewSession = resolveInternalSessionEffectsIdentity({
      agentId: "main",
      runId: "skill-workshop-review:prompt-parity",
    });
    const snapshots = [];
    let reviewReadOutcomes: PromiseSettledResult<unknown>[] = [];
    for (const review of [false, true]) {
      const session = review ? reviewSession : foregroundSession;
      resetEmbeddedAttemptHarness();
      hoisted.createOpenClawCodingToolsMock.mockReturnValue(codingTools);
      await createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey: session.sessionKey,
        tempPaths,
        sessionPrompt: async () => {
          if (!review) {
            return;
          }
          const sessionOptions = hoisted.createAgentSessionMock.mock.calls.at(-1)?.[0] as {
            customTools: AnyAgentTool[];
          };
          const read = sessionOptions.customTools.find((tool) => tool.name === "read");
          if (!read) {
            throw new Error("expected the review read tool");
          }
          reviewReadOutcomes = await Promise.allSettled([read.execute("call", {})]);
        },
        attemptOverrides: {
          disableTools: false,
          disableMessageTool: false,
          reasoningLevel: "on",
          sessionId: session.sessionId,
          sandboxSessionKey: foregroundSession.sessionKey,
          promptCacheKey: "foreground-cache-prefix",
          sessionFile: transcriptFile,
          sessionTarget: {
            agentId: "main",
            sessionId: session.sessionId,
            sessionKey: session.sessionKey,
            storePath: storeFile,
          },
          ...(review
            ? {
                // This override list mirrors runSkillExperienceReview.
                sessionPersistence: "detached" as const,
                toolExecutionAllow: ["skill_workshop"],
                skillWorkshopProposalOnly: true,
                disableTrajectory: true,
                verboseLevel: "off" as const,
                suppressToolErrorWarnings: true,
                trigger: "user" as const,
              }
            : {}),
        },
      });
      const sessionOptions = hoisted.createAgentSessionMock.mock.calls.at(-1)?.[0] as
        | { customTools?: AnyAgentTool[] }
        | undefined;
      const tools = sessionOptions?.customTools ?? [];
      expect(tools.some((tool) => tool.name === "message")).toBe(true);
      snapshots.push(
        beginPromptCacheObservation({
          sessionId: session.sessionId,
          sessionKey: session.sessionKey,
          provider: "openai",
          modelId: "gpt-test",
          streamStrategy: "test",
          systemPrompt: hoisted.systemPromptTexts.at(-1) ?? "",
          tools: collectPromptCacheTools(tools),
        }).snapshot,
      );
    }

    expect(reviewReadOutcomes).toMatchObject([
      {
        status: "rejected",
        reason: {
          message:
            "Unavailable during skill review. Use skill_workshop or finish with NOTHING_TO_LEARN.",
        },
      },
    ]);
    expect(execute).not.toHaveBeenCalled();
    expect(snapshots[1]?.systemPromptDigest).toBe(snapshots[0]?.systemPromptDigest);
    expect(snapshots[1]?.toolDigest).toBe(snapshots[0]?.toolDigest);
    expect(await fs.readFile(transcriptFile)).toEqual(beforeTranscript);
    expect(await fs.readFile(storeFile)).toEqual(beforeStore);
  });

  it("keeps wildcard allowlists equivalent to an unrestricted attempt", async () => {
    const observed: Array<{
      label: string;
      skillsPrompt?: string;
      skillsListAvailable: boolean;
    }> = [];

    for (const testCase of [
      { label: "undefined", toolsAllow: undefined },
      { label: "wildcard", toolsAllow: ["*"] },
      { label: "mixed wildcard", toolsAllow: ["message", "*"] },
      { label: "finite", toolsAllow: ["message"] },
    ]) {
      resetEmbeddedAttemptHarness();
      hoisted.resolveEmbeddedRunSkillEntriesMock.mockReturnValue({
        shouldLoadSkillEntries: true,
        skillEntries: [createFixtureSkillEntry("demo")],
        loadSkillEntries: vi.fn(() => [createFixtureSkillEntry("demo")]),
      });
      hoisted.resolveSkillsPromptForRunMock.mockReturnValue(skillsPrompt);

      await createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey: `agent:main:${testCase.label.replace(" ", "-")}`,
        tempPaths,
        attemptOverrides: {
          disableTools: false,
          toolsAllow: testCase.toolsAllow,
          config: { tools: { codeMode: true } },
        },
      });

      const sessionOptions = hoisted.createAgentSessionMock.mock.calls.at(-1)?.[0] as
        | { customTools?: AnyAgentTool[] }
        | undefined;
      const execTool = sessionOptions?.customTools?.find((tool) => tool.name === "exec");
      if (!execTool) {
        throw new Error("expected Code Mode exec tool");
      }
      const promptInput = hoisted.embeddedSystemPromptInputs.at(-1) as
        | { skillsPrompt?: string }
        | undefined;
      observed.push({
        label: testCase.label,
        skillsPrompt: promptInput?.skillsPrompt,
        skillsListAvailable: execTool.description.includes("await skills.list()"),
      });
    }

    expect(observed).toEqual([
      { label: "undefined", skillsPrompt, skillsListAvailable: true },
      { label: "wildcard", skillsPrompt, skillsListAvailable: true },
      { label: "mixed wildcard", skillsPrompt, skillsListAvailable: true },
      { label: "finite", skillsPrompt: undefined, skillsListAvailable: false },
    ]);
  });
  it("gates catalog-hidden tools during review while skill_workshop stays callable", async () => {
    const sessionManager = SessionManager.inMemory();
    const executed: string[] = [];
    const tool = (name: string): AnyAgentTool =>
      ({
        name,
        label: name,
        description: `${name} tool`,
        parameters: { type: "object", properties: {} },
        execute: async () => {
          executed.push(name);
          return { content: [{ type: "text" as const, text: "ok" }], details: undefined };
        },
      }) as AnyAgentTool;
    hoisted.createOpenClawCodingToolsMock.mockImplementation((...args: unknown[]) => {
      const options = args[0] as {
        config?: Parameters<typeof createToolSearchTools>[0]["config"];
        toolSearchCatalogRef?: ToolSearchCatalogRef;
        toolSearchCatalogExecutor?: ToolSearchCatalogToolExecutor;
      };
      return [
        ...createToolSearchTools({
          config: options.config,
          runtimeConfig: options.config,
          catalogRef: options.toolSearchCatalogRef,
          executeTool: options.toolSearchCatalogExecutor,
        }),
        tool("skill_workshop"),
        tool("read"),
      ];
    });
    let outcomes: PromiseSettledResult<unknown>[] = [];

    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:main",
      tempPaths,
      sessionPrompt: async () => {
        const sessionOptions = hoisted.createAgentSessionMock.mock.calls.at(-1)?.[0] as {
          customTools: AnyAgentTool[];
        };
        const toolCall = sessionOptions.customTools.find((entry) => entry.name === "tool_call");
        if (!toolCall) {
          throw new Error("expected the tool_call control");
        }
        outcomes = await Promise.allSettled([
          toolCall.execute("call-read", { id: "read" }),
          toolCall.execute("call-workshop", { id: "skill_workshop" }),
        ]);
      },
      attemptOverrides: {
        config: { tools: { toolSearch: { enabled: true, mode: "tools" } } },
        disableTools: false,
        sessionManager,
        sessionPersistence: "detached",
        toolExecutionAllow: ["skill_workshop"],
      },
    });

    expect(executed).toEqual(["skill_workshop"]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "fulfilled"]);
    expect(String((outcomes[0] as PromiseRejectedResult).reason)).toContain(
      "Unavailable during skill review",
    );
    const activities = sessionManager.getEntries().flatMap((entry) => {
      const activity = entry.type === "message" && readNestedToolActivity(entry.message);
      return activity ? [activity.details] : [];
    });
    expect(activities).toHaveLength(2);
    expect(activities.find((activity) => activity.toolName === "read")).toMatchObject({
      parentToolCallId: "call-read",
      isError: true,
      result: {
        details: {
          status: "error",
          error: expect.stringContaining("Unavailable during skill review"),
        },
      },
    });
    expect(activities.find((activity) => activity.toolName === "skill_workshop")).toMatchObject({
      parentToolCallId: "call-workshop",
      isError: false,
      result: { content: [{ type: "text", text: "ok" }] },
    });
  });
});
