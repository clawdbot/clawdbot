// Codex tests cover attempt context plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
} from "openclaw/plugin-sdk/memory-host-core";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCodexOpenClawPromptContext,
  buildCodexWatchedSessionsContext,
  buildCodexWorkspaceBootstrapContext,
  buildCodexSystemPromptReport,
  prepareCodexWorkspaceDeveloperInstructions,
  readContextEngineThreadBootstrapProjection,
  readMirroredSessionHistoryMessages,
  resolveContextEngineBootstrapProjectionDecision,
} from "./attempt-context.js";
import type { CodexDynamicToolSpec } from "./protocol.js";
import type { CodexAppServerContextEngineBinding } from "./session-binding.js";

afterEach(() => {
  vi.restoreAllMocks();
  clearMemoryPluginState();
});

describe("Codex app-server attempt context", () => {
  it("treats missing mirrored session history as empty without hook warning", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-attempt-context-history-"));
    const sessionFile = path.join(dir, "session.jsonl");
    try {
      await expect(
        readMirroredSessionHistoryMessages({
          sessionFile,
          sessionId: "codex-session",
          sessionKey: "codex-session",
        }),
      ).resolves.toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns a run context report without deferred Codex dynamic tool schemas", () => {
    const tools = [
      {
        type: "function",
        name: "message",
        description: "Send a message.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
          },
        },
      },
      {
        type: "namespace",
        name: "openclaw",
        description: "",
        tools: [
          {
            type: "function",
            name: "web_search",
            description: "Search the web.",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
            },
            deferLoading: true,
          },
        ],
      },
    ] as CodexDynamicToolSpec[];

    const report = buildCodexSystemPromptReport({
      attempt: {
        sessionId: "session-1",
        provider: "codex",
        modelId: "gpt-5.4-codex",
      } as EmbeddedRunAttemptParams,
      sessionKey: "agent:main:session-1",
      workspaceDir: path.join("tmp", "workspace"),
      developerInstructions: "test developer instructions",
      workspaceBootstrapContext: {
        bootstrapFiles: [],
        contextFiles: [],
        inheritsAgentWorkspace: false,
        promptContextFiles: [],
      },
      skillsPrompt: "",
      tools,
    });

    expect(report.source).toBe("run");
    expect(report.provider).toBe("codex");
    expect(report.model).toBe("gpt-5.4-codex");
    expect(report.systemPrompt.chars).toBeGreaterThan(0);
    expect(report.systemPrompt.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.skills.hash).toMatch(/^[a-f0-9]{64}$/u);

    const message = report.tools.entries.find((tool) => tool.name === "message");
    const webSearch = report.tools.entries.find((tool) => tool.name === "web_search");
    expect(message?.schemaChars).toBeGreaterThan(0);
    expect(message?.summaryHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(message?.schemaHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(webSearch?.schemaChars).toBe(0);
    expect(webSearch?.summaryHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(webSearch?.schemaHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.tools.schemaChars).toBe(message?.schemaChars);
  });

  it("keeps MEMORY.md injected when sandbox effective workspace differs", async () => {
    await withTempDir("codex-memory-workspace-", async (workspaceDir) => {
      await withTempDir("codex-memory-sandbox-", async (sandboxWorkspaceDir) => {
        const memorySummary = "Sandboxed turns need bounded memory fallback.";
        await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), memorySummary);

        const context = await buildCodexWorkspaceBootstrapContext({
          params: {
            sessionId: "session-1",
            sessionKey: "agent:main:session-1",
            config: {
              agents: {
                defaults: {
                  workspace: workspaceDir,
                },
              },
            },
          } as EmbeddedRunAttemptParams,
          resolvedWorkspace: workspaceDir,
          effectiveWorkspace: sandboxWorkspaceDir,
          sessionKey: "agent:main:session-1",
          sessionAgentId: "main",
          memoryToolNames: ["memory_search", "memory_get"],
          ringZeroActive: false,
        });

        expect(context.memoryReferenceFiles).toEqual([]);
        expect(context.promptContext).toContain(memorySummary);
        expect(context.memoryToolRouted).toBe(false);
      });
    });
  });

  it("passes agent context to Codex memory collaboration guidance", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-memory-"));
    let observedContext:
      | { agentId?: string; agentSessionKey?: string; sandboxed?: boolean }
      | undefined;
    registerMemoryCapability("memory-core", {
      promptBuilder: (context) => {
        observedContext = context;
        return [
          "## Agent Memory",
          `agent=${context.agentId} session=${context.agentSessionKey}`,
          "",
        ];
      },
    });

    try {
      const context = await buildCodexWorkspaceBootstrapContext({
        params: {
          sessionId: "session-1",
          sessionKey: "agent:marketing-agent:session-1",
          config: {
            agents: {
              defaults: { workspace: workspaceDir },
              list: [{ id: "marketing-agent", default: true, workspace: workspaceDir }],
            },
          },
        } as EmbeddedRunAttemptParams,
        resolvedWorkspace: workspaceDir,
        effectiveWorkspace: workspaceDir,
        sessionKey: "agent:marketing-agent:session-1",
        sessionAgentId: "marketing-agent",
        memoryToolNames: ["memory_search", "memory_get"],
        ringZeroActive: false,
        sandboxed: true,
      });

      expect(context.memoryToolRouted).toBe(true);
      expect(observedContext).toMatchObject({
        agentId: "marketing-agent",
        agentSessionKey: "agent:marketing-agent:session-1",
        sandboxed: true,
      });
      expect(context.memoryCollaborationInstructions).toContain(
        "agent=marketing-agent session=agent:marketing-agent:session-1",
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("inherits agent workspace instructions when Codex executes in another folder", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-workspace-"));
    const executionDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-execution-workspace-"));
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "Canonical agent instructions");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "Canonical agent soul");
    await fs.writeFile(path.join(workspaceDir, "TOOLS.md"), "Canonical environment facts");
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Canonical agent memory");
    await fs.writeFile(path.join(executionDir, "AGENTS.md"), "Execution project instructions");
    await fs.writeFile(path.join(executionDir, "TOOLS.md"), "Unrelated project environment facts");

    try {
      const context = await buildCodexWorkspaceBootstrapContext({
        params: {
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          config: { agents: { defaults: { workspace: workspaceDir } } },
        } as EmbeddedRunAttemptParams,
        resolvedWorkspace: workspaceDir,
        executionWorkspace: executionDir,
        effectiveWorkspace: executionDir,
        sessionKey: "agent:main:session-1",
        sessionAgentId: "main",
        memoryToolNames: ["memory_search", "memory_get"],
        ringZeroActive: false,
      });

      expect(context.threadDeveloperInstructions).toContain("Canonical agent instructions");
      expect(context.threadDeveloperInstructions).toContain("Canonical environment facts");
      expect(context.threadDeveloperInstructions).not.toContain(
        "Unrelated project environment facts",
      );
      expect(context.threadDeveloperInstructions).toContain(
        "OpenClaw Agent Workspace Instructions",
      );
      expect(context.threadDeveloperInstructions).toContain(path.join(workspaceDir, "AGENTS.md"));
      expect(context.threadDeveloperInstructions).not.toContain("Canonical agent soul");
      expect(context.threadDeveloperInstructions).not.toContain("Execution project instructions");
      expect(context.threadDeveloperInstructions).not.toContain(
        path.join(executionDir, "AGENTS.md"),
      );
      expect(context.turnScopedDeveloperInstructions).toContain("Canonical agent soul");
      expect(context.turnScopedDeveloperInstructions).not.toContain("Canonical agent instructions");
      expect(context.turnScopedDeveloperInstructions).not.toContain("Canonical environment facts");
      expect(context.memoryToolRouted).toBe(true);
      expect(context.promptContext).toBeUndefined();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      await fs.rm(executionDir, { recursive: true, force: true });
    }
  });

  it("keeps ambient workspace instructions out of overlapping ring-zero restrictions", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-ring-zero-workspace-"));
    const executionDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-ring-zero-execution-"));
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "Ambient workspace instructions");
    await fs.writeFile(path.join(workspaceDir, "TOOLS.md"), "Ambient environment facts");

    try {
      const context = await buildCodexWorkspaceBootstrapContext({
        params: {
          sessionId: "session-1",
          sessionKey: "agent:openclaw:session-1",
          toolsAllow: ["openclaw"],
          pluginHarnessToolPolicyRestricted: true,
          config: { agents: { defaults: { workspace: workspaceDir } } },
        } as EmbeddedRunAttemptParams,
        resolvedWorkspace: workspaceDir,
        executionWorkspace: executionDir,
        effectiveWorkspace: executionDir,
        sessionKey: "agent:openclaw:session-1",
        sessionAgentId: "openclaw",
        memoryToolNames: [],
        ringZeroActive: true,
      });

      expect(context.threadDeveloperInstructions).toBeUndefined();
      expect(context.threadDeveloperInstructionFiles).toEqual([]);
      expect(context.promptContext).toBeUndefined();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      await fs.rm(executionDir, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "per-file", bootstrapMaxChars: 256, bootstrapTotalMaxChars: 10_000 },
    { name: "shared", bootstrapMaxChars: 10_000, bootstrapTotalMaxChars: 384 },
  ])("bounds same-workspace TOOLS.md by the $name bootstrap budget", async (limits) => {
    await withTempDir("codex-tools-budget-", async (workspaceDir) => {
      const toolsContent = "Synthetic device aliases and environment facts.\n".repeat(100);
      await Promise.all([
        ...["AGENTS.md", "SOUL.md", "IDENTITY.md", "BOOTSTRAP.md"].map((file) =>
          fs.writeFile(path.join(workspaceDir, file), ""),
        ),
        fs.writeFile(path.join(workspaceDir, "TOOLS.md"), toolsContent),
      ]);
      const attempt = {
        sessionId: "tools-budget",
        config: {
          agents: {
            defaults: {
              workspace: workspaceDir,
              bootstrapMaxChars: limits.bootstrapMaxChars,
              bootstrapTotalMaxChars: limits.bootstrapTotalMaxChars,
            },
          },
        },
      } as EmbeddedRunAttemptParams;
      const context = await buildCodexWorkspaceBootstrapContext({
        params: attempt,
        resolvedWorkspace: workspaceDir,
        effectiveWorkspace: workspaceDir,
        sessionKey: "agent:main:tools-budget",
        sessionAgentId: "main",
        memoryToolNames: [],
        ringZeroActive: false,
      });
      const toolsFile = context.threadDeveloperInstructionFiles?.find(
        (file) => file.path === path.join(workspaceDir, "TOOLS.md"),
      );
      expect(toolsFile).toBeDefined();
      expect(toolsFile?.content).toContain("truncated");
      expect(toolsFile?.content.length).toBeLessThanOrEqual(
        Math.min(limits.bootstrapMaxChars, limits.bootstrapTotalMaxChars),
      );
      expect(context.threadDeveloperInstructions).toContain(toolsFile!.content);
      expect(context.threadDeveloperInstructions).toContain("does not grant tool permissions");
      expect(context.promptContext).toBeUndefined();
      expect(context.turnScopedDeveloperInstructions).toBeUndefined();
      const report = buildCodexSystemPromptReport({
        attempt,
        sessionKey: "agent:main:tools-budget",
        workspaceDir,
        developerInstructions: context.threadDeveloperInstructions ?? "",
        workspaceBootstrapContext: context,
        skillsPrompt: "",
        tools: [],
      });
      expect(report.injectedWorkspaceFiles.find((file) => file.name === "TOOLS.md")).toMatchObject({
        rawChars: toolsContent.trimEnd().length,
        injectedChars: toolsFile?.content.length,
        truncated: true,
      });
    });
  });

  it.each([
    { change: "created", before: "", after: "n".repeat(1800) },
    { change: "removed", before: "n".repeat(1000), after: "" },
    { change: "enlarged", before: "n".repeat(1000), after: "n".repeat(1800) },
  ])(
    "reserves frozen workspace context before budgeting fresh files when TOOLS.md is $change",
    async ({ before, after }) => {
      await withTempDir("codex-tools-retained-budget-", async (workspaceDir) => {
        await Promise.all([
          ...["AGENTS.md", "SOUL.md", "IDENTITY.md", "BOOTSTRAP.md"].map((file) =>
            fs.writeFile(path.join(workspaceDir, file), ""),
          ),
          fs.writeFile(path.join(workspaceDir, "USER.md"), "User preferences.\n".repeat(100)),
          fs.writeFile(path.join(workspaceDir, "TOOLS.md"), before),
        ]);
        const options = {
          params: {
            sessionId: "retained-budget",
            config: {
              agents: { defaults: { bootstrapMaxChars: 2048, bootstrapTotalMaxChars: 2048 } },
            },
          } as EmbeddedRunAttemptParams,
          resolvedWorkspace: workspaceDir,
          effectiveWorkspace: workspaceDir,
          sessionKey: "agent:main:retained-budget",
          sessionAgentId: "main",
          memoryToolNames: [],
          ringZeroActive: false,
        };
        const initial = await buildCodexWorkspaceBootstrapContext(options);
        const retainedSourceChars =
          initial.threadDeveloperInstructionFiles?.reduce(
            (sum, file) => sum + file.content.length,
            0,
          ) ?? 0;
        if (after) {
          await fs.writeFile(path.join(workspaceDir, "TOOLS.md"), after);
        } else {
          await fs.unlink(path.join(workspaceDir, "TOOLS.md"));
        }
        const resumed = await buildCodexWorkspaceBootstrapContext({
          ...options,
          retainedThreadContext: { instructions: initial.threadDeveloperInstructions },
        });

        expect(resumed.turnScopedDeveloperInstructionFiles).toEqual(
          initial.turnScopedDeveloperInstructionFiles,
        );
        const freshChars =
          resumed.turnScopedDeveloperInstructionFiles?.reduce(
            (sum, file) => sum + file.content.length,
            0,
          ) ?? 0;
        expect(retainedSourceChars + freshChars).toBeLessThanOrEqual(2048);
        expect(resumed.threadDeveloperInstructions).toBe(initial.threadDeveloperInstructions);
      });
    },
  );

  it.each(["missing", "empty", "whitespace"] as const)(
    "adds no inherited context for a %s optional TOOLS.md",
    async (contents) => {
      await withTempDir("codex-tools-absent-", async (workspaceDir) => {
        if (contents !== "missing") {
          await fs.writeFile(
            path.join(workspaceDir, "TOOLS.md"),
            contents === "empty" ? "" : "\n ",
          );
        }
        const context = await buildCodexWorkspaceBootstrapContext({
          params: { sessionId: "tools-absent" } as EmbeddedRunAttemptParams,
          resolvedWorkspace: workspaceDir,
          effectiveWorkspace: workspaceDir,
          sessionKey: "agent:main:tools-absent",
          sessionAgentId: "main",
          memoryToolNames: [],
          ringZeroActive: false,
        });
        expect(context.threadDeveloperInstructions).toBeUndefined();
        expect(context.promptContext).toBeUndefined();
        expect(context.turnScopedDeveloperInstructions).toBeUndefined();
      });
    },
  );

  it.each([
    {
      name: "lightweight cron",
      bootstrapContextMode: "lightweight",
      bootstrapContextRunKind: "cron",
    },
    {
      name: "tool-disabled restriction",
      disableTools: true,
      pluginHarnessToolPolicyRestricted: true,
    },
    {
      name: "message-only reply",
      sourceReplyDeliveryMode: "message_tool_only",
      toolsAllow: ["message"],
    },
    { name: "disabled context", config: { agents: { defaults: { contextInjection: "never" } } } },
  ])("does not carry TOOLS.md into $name context", async ({ name: _name, ...attempt }) => {
    await withTempDir("codex-tools-disabled-", async (workspaceDir) => {
      await fs.writeFile(path.join(workspaceDir, "TOOLS.md"), "Private environment reference");
      const context = await buildCodexWorkspaceBootstrapContext({
        params: { sessionId: "tools-disabled", ...attempt } as EmbeddedRunAttemptParams,
        resolvedWorkspace: workspaceDir,
        effectiveWorkspace: workspaceDir,
        sessionKey: "agent:main:tools-disabled",
        sessionAgentId: "main",
        memoryToolNames: [],
        ringZeroActive: false,
      });
      expect(context.threadDeveloperContextEnabled).toBe(false);
      expect(context.threadDeveloperInstructions).toBeUndefined();
      expect(context.promptContext).toBeUndefined();
      expect(context.turnScopedDeveloperInstructions).toBeUndefined();
    });
  });

  it.each([false, true])(
    "prepares inherited child TOOLS.md without turn-only files (external cwd: %s)",
    async (externalCwd) => {
      await withTempDir("codex-tools-child-", async (workspaceDir) => {
        await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "Agent workspace policy");
        await fs.writeFile(path.join(workspaceDir, "TOOLS.md"), "Child environment facts");
        await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "Parent persona");
        const prepared = await prepareCodexWorkspaceDeveloperInstructions({
          config: { agents: { defaults: { workspace: workspaceDir } } },
          agentId: "main",
          sessionKey: "agent:main:subagent:tools-child",
          sessionId: "tools-child",
          workspaceDir,
          cwd: externalCwd ? path.join(workspaceDir, "project") : workspaceDir,
        });
        expect(prepared).toContain("Child environment facts");
        expect(prepared).not.toContain("Parent persona");
        expect(prepared?.includes("Agent workspace policy")).toBe(externalCwd);
      });
    },
  );

  it("honors per-agent disabled context during child preparation", async () => {
    await withTempDir("codex-tools-child-disabled-", async (workspaceDir) => {
      await fs.writeFile(path.join(workspaceDir, "TOOLS.md"), "Child environment facts");
      const prepared = await prepareCodexWorkspaceDeveloperInstructions({
        config: {
          agents: {
            defaults: { workspace: workspaceDir, contextInjection: "always" },
            entries: { worker: { workspace: workspaceDir, contextInjection: "never" } },
          },
        },
        agentId: "worker",
        sessionKey: "agent:worker:subagent:tools-child",
        sessionId: "tools-child",
        workspaceDir,
        cwd: workspaceDir,
      });
      expect(prepared).toBeUndefined();
    });
  });

  it("reads and compares thread-bootstrap context-engine projections", () => {
    const projection = readContextEngineThreadBootstrapProjection({
      mode: "thread_bootstrap",
      epoch: " epoch-1 ",
      fingerprint: " fingerprint-1 ",
    });
    expect(projection).toEqual({
      mode: "thread_bootstrap",
      epoch: "epoch-1",
      fingerprint: "fingerprint-1",
    });

    const expectedBinding = {
      schemaVersion: 1,
      engineId: "lossless",
      policyFingerprint: "policy-v1",
      projection: {
        schemaVersion: 1,
        mode: "thread_bootstrap",
        epoch: "epoch-1",
        fingerprint: "fingerprint-1",
      },
    } satisfies CodexAppServerContextEngineBinding;
    expect(
      resolveContextEngineBootstrapProjectionDecision({
        startupBinding: {
          threadId: "thread-existing",
          dynamicToolsFingerprint: "same-tools",
          contextEngine: expectedBinding,
        } as never,
        expectedBinding,
        projection: projection!,
        dynamicToolsFingerprint: "same-tools",
      }),
    ).toEqual({
      project: false,
      reason: "matching-thread-bootstrap-binding",
    });
    expect(
      resolveContextEngineBootstrapProjectionDecision({
        startupBinding: {
          threadId: "thread-existing",
          dynamicToolsFingerprint: "old-tools",
          contextEngine: expectedBinding,
        } as never,
        expectedBinding,
        projection: projection!,
        dynamicToolsFingerprint: "new-tools",
      }),
    ).toEqual({
      project: true,
      reason: "dynamic-tools-mismatch",
    });
  });

  it("stitches watched-session context into the per-turn OpenClaw prompt context", () => {
    const attempt = { config: {} } as EmbeddedRunAttemptParams;

    expect(
      buildCodexOpenClawPromptContext({
        params: attempt,
        watchedSessionsContext: [
          "## Watched Sessions",
          "- agent:main:telegram:group:beta — Family group",
        ].join("\n"),
      }),
    ).toContain("## Watched Sessions");

    // No ambient watches (and no state) must render nothing, not an empty section.
    expect(
      buildCodexWatchedSessionsContext({
        attempt,
        dynamicTools: [
          {
            type: "function",
            name: "sessions_history",
            description: "history",
            inputSchema: {},
          },
        ],
        sessionKey: "agent:codex-test:main",
      }),
    ).toBe(undefined);

    // Lightweight cron turns keep the runtime context byte-for-byte untouched.
    expect(
      buildCodexWatchedSessionsContext({
        attempt: {
          config: {},
          bootstrapContextMode: "lightweight",
          bootstrapContextRunKind: "cron",
        } as EmbeddedRunAttemptParams,
        dynamicTools: [],
        sessionKey: "agent:codex-test:main",
      }),
    ).toBe(undefined);
  });
});
