// Qa Lab tests cover runtime tool fixture plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QaSuiteInfraError } from "./errors.js";
import { runRuntimeToolFixture } from "./runtime-tool-fixture.js";
import { readRawQaSessionStore } from "./suite-runtime-agent-session.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

const tempRoots: string[] = [];

async function makeEnv(overrides: Partial<QaSuiteRuntimeEnv> = {}): Promise<QaSuiteRuntimeEnv> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-tool-fixture-"));
  const workspaceDir = path.join(tempRoot, "workspace");
  await fs.mkdir(workspaceDir);
  tempRoots.push(tempRoot);
  return {
    outputDir: tempRoot,
    repoRoot: tempRoot,
    providerMode: "mock-openai",
    primaryModel: "openai/gpt-5.6-luna",
    alternateModel: "openai/gpt-5.6-luna",
    mock: null,
    cfg: {},
    transport: {} as QaSuiteRuntimeEnv["transport"],
    gateway: {
      baseUrl: "http://127.0.0.1:1",
      tempRoot,
      workspaceDir,
      runtimeEnv: {},
      call: vi.fn(),
    },
    ...overrides,
  };
}

async function writeQaSessionTranscript(
  env: QaSuiteRuntimeEnv,
  sessionKey: string,
  messages: Array<Record<string, unknown>>,
) {
  const sessionId = sessionKey.replace(/[^a-z0-9]+/giu, "-");
  const sessionEnv = {
    ...process.env,
    OPENCLAW_STATE_DIR: path.join(env.gateway.tempRoot, "state"),
  };
  await upsertSessionEntry({
    agentId: "qa",
    env: sessionEnv,
    sessionKey,
    entry: { sessionId, updatedAt: Date.now() },
  });
  for (const message of messages) {
    await appendSessionTranscriptMessageByIdentity({
      agentId: "qa",
      env: sessionEnv,
      sessionId,
      sessionKey,
      message,
    });
  }
}

async function writeLiveRuntimeToolEvidence(env: QaSuiteRuntimeEnv, toolName = "read") {
  await writeQaSessionTranscript(env, `agent:qa:runtime-tool:${toolName}:happy`, [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: `call-${toolName}-happy`,
          name: toolName,
          input: { path: "README.md" },
        },
      ],
    },
    {
      role: "tool",
      toolName,
      tool_call_id: `call-${toolName}-happy`,
      content: "README contents",
    },
  ]);
  await writeQaSessionTranscript(env, `agent:qa:runtime-tool:${toolName}:failure`, [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: `call-${toolName}-failure`,
          name: toolName,
          input: { path: "/missing" },
        },
      ],
    },
    {
      role: "tool",
      toolName,
      tool_call_id: `call-${toolName}-failure`,
      isError: true,
      content: "outside allowed scope",
    },
  ]);
}

async function writeCodexNativePatchEvidence(
  env: QaSuiteRuntimeEnv,
  failureOutput = "apply_patch failed: path escapes sandbox root",
  options: {
    happyPath?: string;
    failurePath?: string;
    happyKind?: string;
    failureKind?: string;
    failureStructuredError?: boolean;
    happyArguments?: unknown;
    failureArguments?: unknown;
    happyInput?: unknown;
    failureInput?: unknown;
    omitFailureEvidence?: boolean;
  } = {},
) {
  const toolName = "apply_patch";
  await writeQaSessionTranscript(env, `agent:qa:runtime-tool:${toolName}:happy`, [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "native-patch-happy",
          name: toolName,
          ...(options.happyInput !== undefined ? { input: options.happyInput } : {}),
          arguments: options.happyArguments ?? {
            changes: [
              {
                path: options.happyPath ?? "runtime-tool-fixture-patch.txt",
                kind: { type: options.happyKind ?? "add" },
              },
            ],
          },
        },
      ],
    },
    {
      role: "toolResult",
      toolName,
      toolCallId: "native-patch-happy",
      isError: false,
      content: [
        {
          type: "toolResult",
          toolName,
          toolCallId: "native-patch-happy",
          content: "apply_patch completed",
        },
      ],
    },
  ]);
  if (options.omitFailureEvidence) {
    return;
  }
  await writeQaSessionTranscript(env, `agent:qa:runtime-tool:${toolName}:failure`, [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "native-patch-failure",
          name: toolName,
          ...(options.failureInput !== undefined ? { input: options.failureInput } : {}),
          arguments: options.failureArguments ?? {
            changes: [
              {
                path: options.failurePath ?? "../runtime-tool-fixture-denied.txt",
                kind: { type: options.failureKind ?? "update" },
              },
            ],
          },
        },
      ],
    },
    {
      role: "toolResult",
      toolName,
      toolCallId: "native-patch-failure",
      isError: options.failureStructuredError ?? true,
      content: [
        {
          type: "toolResult",
          toolName,
          toolCallId: "native-patch-failure",
          content: failureOutput,
        },
      ],
    },
  ]);
}

async function simulateRuntimePatchHappyTurn(
  env: Pick<QaSuiteRuntimeEnv, "gateway">,
  params: { sessionKey: string },
  contents: string | null = "runtime patch\n",
) {
  if (params.sessionKey.endsWith(":happy") && contents !== null) {
    await fs.writeFile(
      path.join(env.gateway.workspaceDir, "runtime-tool-fixture-patch.txt"),
      contents,
      "utf8",
    );
  }
  return {};
}

async function runMockRuntimeToolFixtureWithOutputs(params: {
  toolName: string;
  happyArgs: Record<string, unknown>;
  failureArgs: Record<string, unknown>;
  happyOutput: string;
  failureOutput: string;
  happyPatchContents?: string | null;
}) {
  const env = await makeEnv({
    mock: { baseUrl: "http://127.0.0.1:9999" },
  });
  const promptSnippet = `target=${params.toolName}`;
  const failurePromptSnippet = `failure target=${params.toolName}`;
  const happyCallId = `call-${params.toolName}-happy`;
  const failureCallId = `call-${params.toolName}-failure`;
  const fetchJson = vi
    .fn()
    .mockResolvedValueOnce({ cursor: 0 })
    .mockResolvedValueOnce([
      {
        allInputText: promptSnippet,
        plannedToolCallId: happyCallId,
        plannedToolName: params.toolName,
        plannedToolArgs: params.happyArgs,
      },
      {
        allInputText: promptSnippet,
        toolOutputCallId: happyCallId,
        toolOutput: params.happyOutput,
      },
      {
        allInputText: failurePromptSnippet,
        plannedToolCallId: failureCallId,
        plannedToolName: params.toolName,
        plannedToolArgs: params.failureArgs,
      },
      {
        allInputText: failurePromptSnippet,
        toolOutputCallId: failureCallId,
        toolOutput: params.failureOutput,
      },
    ]);

  return runRuntimeToolFixture(
    env,
    {
      toolName: params.toolName,
      toolCoverage: {
        bucket: "openclaw-dynamic-integration",
        expectedLayer: "openclaw-dynamic",
      },
      promptSnippet,
      failurePromptSnippet,
    },
    {
      createSession: vi.fn(async (_env, _label, key) => key!),
      readEffectiveTools: vi.fn(async () => new Set([params.toolName])),
      runAgentPrompt: vi.fn(async (runEnv, promptParams) => {
        if (params.toolName === "apply_patch") {
          return simulateRuntimePatchHappyTurn(runEnv, promptParams, params.happyPatchContents);
        }
        return {};
      }),
      fetchJson,
      ensureImageGenerationConfigured: vi.fn(),
    },
  );
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((tempRoot) => fs.rm(tempRoot, { recursive: true, force: true })),
  );
});

describe("runtime tool fixture", () => {
  it("checks effective tools on the same session used for the happy prompt", async () => {
    const env = await makeEnv();
    await writeLiveRuntimeToolEvidence(env);
    await expect(readRawQaSessionStore(env)).resolves.toHaveProperty(
      "agent:qa:runtime-tool:read:happy",
    );
    const createdKeys: string[] = [];
    const promptKeys: string[] = [];
    const promptEvidence: Array<{
      requireSuccessfulTranscriptToolResult?: boolean;
      transcriptToolName?: string;
    }> = [];
    const readEffectiveTools = vi.fn(async (_env, sessionKey: string) => {
      expect(sessionKey).toBe("agent:qa:runtime-tool:read:happy");
      return new Set(["read"]);
    });

    const details = await runRuntimeToolFixture(
      env,
      {
        toolName: "read",
        toolCoverage: {
          bucket: "openclaw-dynamic-integration",
          expectedLayer: "openclaw-dynamic",
        },
      },
      {
        createSession: vi.fn(async (_env, _label, key) => {
          createdKeys.push(key);
          return key;
        }),
        readEffectiveTools,
        runAgentPrompt: vi.fn(async (_env, params) => {
          promptKeys.push(params.sessionKey);
          promptEvidence.push({
            transcriptToolName: params.transcriptToolName,
            requireSuccessfulTranscriptToolResult: params.requireSuccessfulTranscriptToolResult,
          });
          return {};
        }),
        fetchJson: vi.fn(),
        ensureImageGenerationConfigured: vi.fn(),
      },
    );

    expect(createdKeys).toEqual([
      "agent:qa:runtime-tool:read:happy",
      "agent:qa:runtime-tool:read:failure",
    ]);
    expect(promptKeys).toEqual([
      "agent:qa:runtime-tool:read:happy",
      "agent:qa:runtime-tool:read:failure",
    ]);
    expect(promptEvidence).toEqual([
      { transcriptToolName: "read", requireSuccessfulTranscriptToolResult: true },
      { transcriptToolName: "read", requireSuccessfulTranscriptToolResult: undefined },
    ]);
    expect(details).toContain("RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:read:happy");
    expect(details).toContain("RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:read:failure");
  });

  it("retains both fixture session keys when the failure prompt throws", async () => {
    const env = await makeEnv();
    const infraError = new QaSuiteInfraError("agent_wait_failed", "failure prompt did not settle");
    const runAgentPrompt = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(infraError);

    const result = runRuntimeToolFixture(
      env,
      {
        toolName: "read",
        toolCoverage: {
          bucket: "openclaw-dynamic-integration",
          expectedLayer: "openclaw-dynamic",
        },
      },
      {
        createSession: vi.fn(async (_env, _label, key) => key),
        readEffectiveTools: vi.fn(async () => new Set(["read"])),
        runAgentPrompt,
        fetchJson: vi.fn(),
        ensureImageGenerationConfigured: vi.fn(),
      },
    );
    await expect(result).rejects.toBeInstanceOf(QaSuiteInfraError);
    await expect(result).rejects.toMatchObject({ code: "agent_wait_failed", cause: infraError });
    await expect(result).rejects.toThrow(
      [
        "RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:read:happy",
        "RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:read:failure",
        "failure prompt did not settle",
      ].join("\n"),
    );
  });

  it("requires live runtime tool fixtures to produce transcript tool output", async () => {
    const env = await makeEnv();
    await writeQaSessionTranscript(env, "agent:qa:runtime-tool:read:happy", [
      { role: "assistant", content: "I checked README.md and it looks good." },
    ]);
    await writeQaSessionTranscript(env, "agent:qa:runtime-tool:read:failure", [
      { role: "assistant", content: "The denied-input path looks good." },
    ]);

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "read",
          toolCoverage: {
            bucket: "openclaw-dynamic-integration",
            expectedLayer: "openclaw-dynamic",
          },
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set(["read"])),
          runAgentPrompt: vi.fn(async () => ({})),
          fetchJson: vi.fn(),
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toThrow("expected live happy-path tool call for read");
  });

  it("accepts live runtime tool fixtures only after transcript tool output", async () => {
    const env = await makeEnv();
    await writeLiveRuntimeToolEvidence(env);

    const details = await runRuntimeToolFixture(
      env,
      {
        toolName: "read",
        toolCoverage: {
          bucket: "openclaw-dynamic-integration",
          expectedLayer: "openclaw-dynamic",
        },
      },
      {
        createSession: vi.fn(async (_env, _label, key) => key!),
        readEffectiveTools: vi.fn(async () => new Set(["read"])),
        runAgentPrompt: vi.fn(async () => ({})),
        fetchJson: vi.fn(),
        ensureImageGenerationConfigured: vi.fn(),
      },
    );

    expect(details).toContain("read live provider happy planned args");
    expect(details).toContain("read live provider failure planned args");
  });

  it("skips async live runtime tool fixtures when the happy path has no result", async () => {
    const env = await makeEnv();
    await writeQaSessionTranscript(env, "agent:qa:runtime-tool:image_generate:happy", [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-image-happy",
            name: "image_generate",
            input: { prompt: "QA lighthouse runtime parity fixture" },
          },
        ],
      },
    ]);
    await writeQaSessionTranscript(env, "agent:qa:runtime-tool:image_generate:failure", [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-image-failure",
            name: "image_generate",
            input: { __qaFailureMode: "denied-input" },
          },
        ],
      },
      {
        role: "tool",
        toolName: "image_generate",
        tool_call_id: "call-image-failure",
        isError: true,
        content: "denied-input",
      },
    ]);

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "image_generate",
          toolCoverage: {
            bucket: "openclaw-dynamic-integration",
            expectedLayer: "openclaw-dynamic",
          },
          happyPathOutputRequired: false,
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set(["image_generate"])),
          runAgentPrompt: vi.fn(async () => ({})),
          fetchJson: vi.fn(),
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toThrow("planned call without a linked successful result");
  });

  it("still requires async live runtime tool fixtures to call the happy-path tool", async () => {
    const env = await makeEnv();
    await writeQaSessionTranscript(env, "agent:qa:runtime-tool:image_generate:happy", [
      { role: "assistant", content: "I can start image generation later." },
    ]);
    await writeQaSessionTranscript(env, "agent:qa:runtime-tool:image_generate:failure", [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-image-failure",
            name: "image_generate",
            input: { __qaFailureMode: "denied-input" },
          },
        ],
      },
      {
        role: "tool",
        toolName: "image_generate",
        tool_call_id: "call-image-failure",
        isError: true,
        content: "denied-input",
      },
    ]);

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "image_generate",
          toolCoverage: {
            bucket: "openclaw-dynamic-integration",
            expectedLayer: "openclaw-dynamic",
          },
          happyPathOutputRequired: false,
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set(["image_generate"])),
          runAgentPrompt: vi.fn(async () => ({})),
          fetchJson: vi.fn(),
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toThrow("expected live happy-path tool call for image_generate");
  });

  it("requires live failure fixtures to produce failure-shaped tool output", async () => {
    const env = await makeEnv();
    await writeQaSessionTranscript(env, "agent:qa:runtime-tool:read:happy", [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-read-happy",
            name: "read",
            input: { path: "README.md" },
          },
        ],
      },
      {
        role: "tool",
        toolName: "read",
        tool_call_id: "call-read-happy",
        content: "README documents invalid requests, errors, and denied inputs.",
      },
    ]);
    await writeQaSessionTranscript(env, "agent:qa:runtime-tool:read:failure", [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-read-failure",
            name: "read",
            input: { path: "/missing" },
          },
        ],
      },
      {
        role: "tool",
        toolName: "read",
        tool_call_id: "call-read-failure",
        content: "README contents",
      },
    ]);

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "read",
          toolCoverage: {
            bucket: "openclaw-dynamic-integration",
            expectedLayer: "openclaw-dynamic",
          },
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set(["read"])),
          runAgentPrompt: vi.fn(async () => ({})),
          fetchJson: vi.fn(),
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toThrow("expected live failure-path tool failure output for read");
  });

  it("rejects failure-shaped live happy-path tool output", async () => {
    const env = await makeEnv();
    await writeQaSessionTranscript(env, "agent:qa:runtime-tool:read:happy", [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-read-happy",
            name: "read",
            input: { path: "README.md" },
          },
        ],
      },
      {
        role: "tool",
        toolName: "read",
        tool_call_id: "call-read-happy",
        isError: true,
        content: "ENOENT: no such file or directory",
      },
    ]);
    await writeQaSessionTranscript(env, "agent:qa:runtime-tool:read:failure", [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-read-failure",
            name: "read",
            input: { path: "/missing" },
          },
        ],
      },
      {
        role: "tool",
        toolName: "read",
        tool_call_id: "call-read-failure",
        isError: true,
        content: "ENOENT: no such file or directory",
      },
    ]);

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "read",
          toolCoverage: {
            bucket: "openclaw-dynamic-integration",
            expectedLayer: "openclaw-dynamic",
          },
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set(["read"])),
          runAgentPrompt: vi.fn(async () => ({})),
          fetchJson: vi.fn(),
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toThrow("expected live happy-path successful tool output for read");
  });

  it("skips Codex-native fixtures when only OpenClaw dynamic exposure evidence is absent", async () => {
    const env = await makeEnv({
      mock: { baseUrl: "http://127.0.0.1:9999" },
      gateway: {
        baseUrl: "http://127.0.0.1:1",
        tempRoot: "",
        workspaceDir: "",
        runtimeEnv: { OPENCLAW_QA_FORCE_RUNTIME: "codex" },
        call: vi.fn(),
      },
    });
    env.gateway.tempRoot = env.repoRoot;
    env.gateway.workspaceDir = env.repoRoot;

    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ cursor: 0 })
      .mockResolvedValueOnce([
        {
          allInputText: "target=read",
          plannedToolName: "read",
          plannedToolArgs: { path: "README.md" },
        },
      ]);

    const transcriptToolNames: Array<string | undefined> = [];
    const runAgentPrompt = vi.fn(async (_env: unknown, params: { transcriptToolName?: string }) => {
      transcriptToolNames.push(params.transcriptToolName);
      return {};
    });
    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "read",
          toolCoverage: {
            bucket: "codex-native-workspace",
            expectedLayer: "codex-native-workspace",
            reason: "Codex owns read natively.",
          },
          promptSnippet: "target=read",
          failurePromptSnippet: "failure target=read",
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set<string>()),
          runAgentPrompt,
          fetchJson,
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toMatchObject({
      name: "QaSuiteScenarioSkipError",
      message: expect.stringMatching(
        /codex-native-workspace read[\s\S]*RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:read:happy[\s\S]*RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:read:failure/u,
      ),
    });
    expect(runAgentPrompt).toHaveBeenCalledTimes(2);
    expect(transcriptToolNames).toEqual([undefined, undefined]);
  });

  it.each([
    "apply_patch failed: path escapes sandbox root",
    "Operation not permitted (os error 1)",
    "patch rejected: writing outside of the project; rejected by user approval settings",
  ])("verifies native Codex patch success and workspace denial: %s", async (failureOutput) => {
    const env = await makeEnv();
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
    await writeCodexNativePatchEvidence(env, failureOutput);
    const promptEvidence: Array<{
      requireSuccessfulTranscriptToolResult?: boolean;
      transcriptToolName?: string;
    }> = [];

    const details = await runRuntimeToolFixture(
      env,
      {
        toolName: "apply_patch",
        toolCoverage: {
          bucket: "codex-native-workspace",
          expectedLayer: "codex-native-workspace",
          required: true,
        },
      },
      {
        createSession: vi.fn(async (_env, _label, key) => key!),
        readEffectiveTools: vi.fn(async () => new Set<string>()),
        runAgentPrompt: vi.fn(async (_env, params) => {
          promptEvidence.push({
            transcriptToolName: params.transcriptToolName,
            requireSuccessfulTranscriptToolResult: params.requireSuccessfulTranscriptToolResult,
          });
          return simulateRuntimePatchHappyTurn(_env, params);
        }),
        fetchJson: vi.fn(),
        ensureImageGenerationConfigured: vi.fn(),
      },
    );

    expect(promptEvidence).toEqual([
      { transcriptToolName: undefined, requireSuccessfulTranscriptToolResult: undefined },
      { transcriptToolName: undefined, requireSuccessfulTranscriptToolResult: undefined },
    ]);
    expect(details).toContain("apply_patch live provider happy planned args");
    expect(details).toContain("runtime-tool-fixture-patch.txt");
    expect(details).toContain("../runtime-tool-fixture-denied.txt");
    await expect(
      fs.access(path.resolve(env.gateway.workspaceDir, "../runtime-tool-fixture-denied.txt")),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(env.gateway.workspaceDir, "runtime-tool-fixture-patch.txt")),
    ).rejects.toThrow();
  });

  it("recognizes forced Codex native patches even when the effective inventory lists apply_patch", async () => {
    const env = await makeEnv();
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
    await writeCodexNativePatchEvidence(
      env,
      "patch rejected: writing outside of the project; rejected by user approval settings",
    );
    const promptEvidence: Array<{
      requireSuccessfulTranscriptToolResult?: boolean;
      transcriptToolName?: string;
    }> = [];

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "apply_patch",
          toolCoverage: {
            bucket: "codex-native-workspace",
            expectedLayer: "codex-native-workspace",
            required: true,
          },
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set(["apply_patch"])),
          runAgentPrompt: vi.fn(async (_env, params) => {
            promptEvidence.push({
              transcriptToolName: params.transcriptToolName,
              requireSuccessfulTranscriptToolResult: params.requireSuccessfulTranscriptToolResult,
            });
            return simulateRuntimePatchHappyTurn(_env, params);
          }),
          fetchJson: vi.fn(),
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).resolves.toContain("apply_patch live provider happy planned args");

    expect(promptEvidence).toEqual([
      { transcriptToolName: undefined, requireSuccessfulTranscriptToolResult: undefined },
      { transcriptToolName: undefined, requireSuccessfulTranscriptToolResult: undefined },
    ]);
  });

  it("rejects a native patch whose recorded working directory changes its target", async () => {
    const env = await makeEnv();
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
    await writeCodexNativePatchEvidence(env, "apply_patch failed: path escapes sandbox root", {
      happyArguments: {
        input:
          "*** Begin Patch\n*** Add File: runtime-tool-fixture-patch.txt\n+runtime patch\n*** End Patch\n",
        cwd: path.resolve(env.gateway.workspaceDir, ".."),
      },
    });

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "apply_patch",
          toolCoverage: {
            bucket: "codex-native-workspace",
            expectedLayer: "codex-native-workspace",
            required: true,
          },
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set<string>()),
          runAgentPrompt: vi.fn(simulateRuntimePatchHappyTurn),
          fetchJson: vi.fn(),
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toThrow("expected linked live apply_patch to add runtime-tool-fixture-patch.txt");
  });

  it.each([
    {
      label: "native freeform patch text",
      encode: (input: string) => input,
    },
    {
      label: "OpenClaw input envelope",
      encode: (input: string) => ({ input }),
    },
    {
      label: "JSON-encoded provider arguments",
      encode: (input: string) => JSON.stringify({ input }),
    },
    {
      label: "executed provider arguments with an empty mirrored input",
      encode: (input: string) => ({ input }),
      shadowInput: true,
    },
  ])("verifies linked $label without weakening workspace containment", async (testCase) => {
    const { encode } = testCase;
    const env = await makeEnv();
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
    await writeCodexNativePatchEvidence(env, "patch rejected: writing outside of the project", {
      happyArguments: encode(
        "*** Begin Patch\n*** Add File: runtime-tool-fixture-patch.txt\n+runtime patch\n*** End Patch\n",
      ),
      failureArguments: encode(
        "*** Begin Patch\n*** Update File: ../runtime-tool-fixture-denied.txt\n@@\n-runtime-tool-fixture-denied-original\n+runtime patch outside the workspace\n*** End Patch\n",
      ),
      ...("shadowInput" in testCase ? { happyInput: {}, failureInput: {} } : {}),
    });

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "apply_patch",
          toolCoverage: {
            bucket: "codex-native-workspace",
            expectedLayer: "codex-native-workspace",
            required: true,
          },
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set<string>()),
          runAgentPrompt: vi.fn(simulateRuntimePatchHappyTurn),
          fetchJson: vi.fn(),
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).resolves.toContain("apply_patch live provider happy planned args");

    await expect(
      fs.access(path.resolve(env.gateway.workspaceDir, "../runtime-tool-fixture-denied.txt")),
    ).rejects.toThrow();
  });

  it("recognizes native patch paths through a canonical workspace alias", async () => {
    const env = await makeEnv();
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
    const workspaceAlias = path.join(env.gateway.tempRoot, "workspace-alias");
    await fs.symlink(
      env.gateway.workspaceDir,
      workspaceAlias,
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeCodexNativePatchEvidence(env, "apply_patch failed: path escapes sandbox root", {
      happyPath: path.join(workspaceAlias, "runtime-tool-fixture-patch.txt"),
    });

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "apply_patch",
          toolCoverage: {
            bucket: "codex-native-workspace",
            expectedLayer: "codex-native-workspace",
            required: true,
          },
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set<string>()),
          runAgentPrompt: vi.fn(simulateRuntimePatchHappyTurn),
          fetchJson: vi.fn(),
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).resolves.toContain("apply_patch live provider happy planned args");
  });

  it("does not accept assistant text as evidence of a native Codex workspace rejection", async () => {
    const env = await makeEnv();
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
    await writeCodexNativePatchEvidence(env, undefined, { omitFailureEvidence: true });
    await writeQaSessionTranscript(env, "agent:qa:runtime-tool:apply_patch:failure", [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "patch rejected: writing outside of the project; rejected by user approval settings",
          },
        ],
      },
    ]);

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "apply_patch",
          toolCoverage: {
            bucket: "codex-native-workspace",
            expectedLayer: "codex-native-workspace",
            required: true,
          },
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set<string>()),
          runAgentPrompt: vi.fn(simulateRuntimePatchHappyTurn),
          fetchJson: vi.fn(),
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toThrow("expected live failure-path tool call for apply_patch");

    await expect(
      fs.access(path.resolve(env.gateway.workspaceDir, "../runtime-tool-fixture-denied.txt")),
    ).rejects.toThrow();
  });

  it("verifies executed patch envelopes with canonical absolute target paths", async () => {
    const env = await makeEnv();
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
    const happyPath = path.join(env.gateway.workspaceDir, "runtime-tool-fixture-patch.txt");
    const deniedPath = path.resolve(
      env.gateway.workspaceDir,
      "..",
      "runtime-tool-fixture-denied.txt",
    );
    await writeCodexNativePatchEvidence(env, "patch rejected: writing outside of the project", {
      happyArguments: {
        input: `*** Begin Patch\n*** Add File: ${happyPath}\n+runtime patch\n*** End Patch\n`,
      },
      failureArguments: {
        input: `*** Begin Patch\n*** Update File: ${deniedPath}\n@@\n-runtime-tool-fixture-denied-original\n+runtime patch outside the workspace\n*** End Patch\n`,
      },
    });

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "apply_patch",
          toolCoverage: {
            bucket: "codex-native-workspace",
            expectedLayer: "codex-native-workspace",
            required: true,
          },
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set<string>()),
          runAgentPrompt: vi.fn(simulateRuntimePatchHappyTurn),
          fetchJson: vi.fn(),
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).resolves.toContain("apply_patch live provider happy planned args");
  });

  it("rejects native patch transcripts that claim success without creating the workspace file", async () => {
    const env = await makeEnv();
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
    await writeCodexNativePatchEvidence(env);

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "apply_patch",
          toolCoverage: {
            bucket: "codex-native-workspace",
            expectedLayer: "codex-native-workspace",
            required: true,
          },
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set<string>()),
          runAgentPrompt: vi.fn(async () => ({})),
          fetchJson: vi.fn(),
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toThrow(
      "expected apply_patch to create runtime-tool-fixture-patch.txt with exact contents",
    );
  });

  it("rejects native Codex patch failures that only report missing patch context", async () => {
    const env = await makeEnv();
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
    await writeCodexNativePatchEvidence(
      env,
      "apply_patch failed: failed to find expected lines in runtime-tool-fixture-denied.txt",
    );

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "apply_patch",
          toolCoverage: {
            bucket: "codex-native-workspace",
            expectedLayer: "codex-native-workspace",
            required: true,
          },
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set<string>()),
          runAgentPrompt: vi.fn(simulateRuntimePatchHappyTurn),
          fetchJson: vi.fn(),
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toThrow(
      "expected live apply_patch failure to explicitly reject the workspace boundary",
    );
  });

  it("rejects native Codex patch failures without a linked failure result", async () => {
    const env = await makeEnv();
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
    await writeCodexNativePatchEvidence(env, "apply_patch completed", {
      failureStructuredError: false,
    });

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "apply_patch",
          toolCoverage: {
            bucket: "codex-native-workspace",
            expectedLayer: "codex-native-workspace",
            required: true,
          },
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set<string>()),
          runAgentPrompt: vi.fn(simulateRuntimePatchHappyTurn),
          fetchJson: vi.fn(),
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toThrow("expected live failure-path tool failure output for apply_patch");
  });

  it.each([
    {
      label: "happy-path file",
      options: { happyPath: "runtime-tool-fixture-wrong.txt" },
      expectedError: "expected linked live apply_patch to add runtime-tool-fixture-patch.txt",
    },
    {
      label: "failure-path file",
      options: { failurePath: "../runtime-tool-fixture-wrong.txt" },
      expectedError:
        "expected linked live apply_patch to update ../runtime-tool-fixture-denied.txt",
    },
    {
      label: "failure-path operation",
      options: { failureKind: "add" },
      expectedError:
        "expected linked live apply_patch to update ../runtime-tool-fixture-denied.txt",
    },
  ])("rejects linked native Codex patch evidence for the wrong $label", async (testCase) => {
    const env = await makeEnv();
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
    await writeCodexNativePatchEvidence(
      env,
      "apply_patch failed: path escapes sandbox root",
      testCase.options,
    );

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "apply_patch",
          toolCoverage: {
            bucket: "codex-native-workspace",
            expectedLayer: "codex-native-workspace",
            required: true,
          },
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set<string>()),
          runAgentPrompt: vi.fn(simulateRuntimePatchHappyTurn),
          fetchJson: vi.fn(),
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toThrow(testCase.expectedError);
  });

  it("validates the native patch call linked to its result instead of the first plan", async () => {
    const env = await makeEnv();
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
    await writeQaSessionTranscript(env, "agent:qa:runtime-tool:apply_patch:happy", [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "native-patch-unlinked-decoy",
            name: "apply_patch",
            arguments: {
              changes: [{ path: "runtime-tool-fixture-wrong.txt", kind: { type: "add" } }],
            },
          },
        ],
      },
    ]);
    await writeCodexNativePatchEvidence(env);

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "apply_patch",
          toolCoverage: {
            bucket: "codex-native-workspace",
            expectedLayer: "codex-native-workspace",
            required: true,
          },
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set<string>()),
          runAgentPrompt: vi.fn(simulateRuntimePatchHappyTurn),
          fetchJson: vi.fn(),
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).resolves.toContain("apply_patch live provider happy planned args");
  });

  it("fails closed and cleans up when a patch changes the outside-workspace sentinel", async () => {
    const env = await makeEnv();
    const sentinelPath = path.resolve(
      env.gateway.workspaceDir,
      "../runtime-tool-fixture-denied.txt",
    );

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "apply_patch",
          toolCoverage: {
            bucket: "openclaw-dynamic-integration",
            expectedLayer: "openclaw-dynamic",
          },
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set(["apply_patch"])),
          runAgentPrompt: vi.fn(async (_env, params) => {
            if (params.sessionKey.endsWith(":failure")) {
              expect(await fs.readFile(sentinelPath, "utf8")).toBe(
                "runtime-tool-fixture-denied-original\n",
              );
              await fs.writeFile(sentinelPath, "runtime patch outside the workspace\n", "utf8");
            }
            return simulateRuntimePatchHappyTurn(_env, params);
          }),
          fetchJson: vi.fn(),
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toThrow("apply_patch modified or removed the outside-workspace sentinel");

    await expect(fs.access(sentinelPath)).rejects.toThrow();
  });

  it("fails closed when required native Codex patch execution has no linked transcript", async () => {
    const env = await makeEnv();
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
    await writeQaSessionTranscript(env, "agent:qa:runtime-tool:apply_patch:happy", [
      { role: "assistant", content: "The patch was applied." },
    ]);
    await writeQaSessionTranscript(env, "agent:qa:runtime-tool:apply_patch:failure", [
      { role: "assistant", content: "The unsafe patch was rejected." },
    ]);

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "apply_patch",
          toolCoverage: {
            bucket: "codex-native-workspace",
            expectedLayer: "codex-native-workspace",
            required: true,
          },
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set<string>()),
          runAgentPrompt: vi.fn(simulateRuntimePatchHappyTurn),
          fetchJson: vi.fn(),
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toThrow("expected live happy-path tool call for apply_patch");
  });

  it.each([
    { label: "dynamically exposed", dynamicPatchExposed: true },
    { label: "native-only", dynamicPatchExposed: false },
  ])("verifies $label private-QA Codex patch calls without skipping them", async (testCase) => {
    const env = await makeEnv({
      mock: { baseUrl: "http://127.0.0.1:9999" },
    });
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
    const promptEvidence: Array<{
      requireSuccessfulTranscriptToolResult?: boolean;
      transcriptToolName?: string;
    }> = [];
    const happyCallId = "private-qa-patch-happy";
    const failureCallId = "private-qa-patch-failure";
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ cursor: 0 })
      .mockResolvedValueOnce([
        {
          allInputText: "target=apply_patch",
          plannedToolCallId: happyCallId,
          plannedToolName: "apply_patch",
          plannedToolArgs: {
            input:
              "*** Begin Patch\n*** Add File: runtime-tool-fixture-patch.txt\n+runtime patch\n*** End Patch\n",
          },
        },
        {
          allInputText: "target=apply_patch",
          toolOutputCallId: happyCallId,
          toolOutput: "Successfully applied patch",
        },
        {
          allInputText: "failure target=apply_patch",
          plannedToolCallId: failureCallId,
          plannedToolName: "apply_patch",
          plannedToolArgs: {
            input:
              "*** Begin Patch\n*** Update File: ../runtime-tool-fixture-denied.txt\n@@\n-runtime-tool-fixture-denied-original\n+runtime patch outside the workspace\n*** End Patch\n",
          },
        },
        {
          allInputText: "failure target=apply_patch",
          toolOutputCallId: failureCallId,
          toolOutput: "Error: Path escapes sandbox root",
        },
      ]);

    const details = await runRuntimeToolFixture(
      env,
      {
        toolName: "apply_patch",
        toolCoverage: {
          bucket: "codex-native-workspace",
          expectedLayer: "codex-native-workspace",
          required: true,
        },
        promptSnippet: "target=apply_patch",
        failurePromptSnippet: "failure target=apply_patch",
      },
      {
        createSession: vi.fn(async (_env, _label, key) => key!),
        readEffectiveTools: vi.fn(
          async () => new Set(testCase.dynamicPatchExposed ? ["apply_patch"] : []),
        ),
        runAgentPrompt: vi.fn(async (_env, params) => {
          promptEvidence.push({
            transcriptToolName: params.transcriptToolName,
            requireSuccessfulTranscriptToolResult: params.requireSuccessfulTranscriptToolResult,
          });
          return simulateRuntimePatchHappyTurn(_env, params);
        }),
        fetchJson,
        ensureImageGenerationConfigured: vi.fn(),
      },
    );

    expect(promptEvidence).toEqual([
      { transcriptToolName: undefined, requireSuccessfulTranscriptToolResult: undefined },
      { transcriptToolName: undefined, requireSuccessfulTranscriptToolResult: undefined },
    ]);
    expect(details).toContain("apply_patch mock provider happy planned args");
    expect(details).toContain("runtime-tool-fixture-patch.txt");
    expect(details).toContain("../runtime-tool-fixture-denied.txt");
    expect(details).not.toContain("codex-native-workspace apply_patch");
    await expect(
      fs.access(path.resolve(env.gateway.workspaceDir, "../runtime-tool-fixture-denied.txt")),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(env.gateway.workspaceDir, "runtime-tool-fixture-patch.txt")),
    ).rejects.toThrow();
  });

  it.each([
    "Operation not permitted",
    "Operation not permitted (os error 1)",
    "EPERM: sandbox denied the requested patch",
    "patch rejected: writing outside of the project; rejected by user approval settings",
  ])("accepts native sandbox denial as a mock patch failure: %s", async (failureOutput) => {
    await expect(
      runMockRuntimeToolFixtureWithOutputs({
        toolName: "apply_patch",
        happyArgs: {
          input:
            "*** Begin Patch\n*** Add File: runtime-tool-fixture-patch.txt\n+runtime patch\n*** End Patch\n",
        },
        failureArgs: {
          input:
            "*** Begin Patch\n*** Update File: ../runtime-tool-fixture-denied.txt\n@@\n-runtime-tool-fixture-denied-original\n+runtime patch outside the workspace\n*** End Patch\n",
        },
        happyOutput: "Successfully applied patch",
        failureOutput,
      }),
    ).resolves.toContain("apply_patch mock provider failure planned args");
  });

  it("rejects mock patch failures that only report missing patch context", async () => {
    await expect(
      runMockRuntimeToolFixtureWithOutputs({
        toolName: "apply_patch",
        happyArgs: {
          input:
            "*** Begin Patch\n*** Add File: runtime-tool-fixture-patch.txt\n+runtime patch\n*** End Patch\n",
        },
        failureArgs: {
          input:
            "*** Begin Patch\n*** Update File: ../runtime-tool-fixture-denied.txt\n@@\n-runtime-tool-fixture-denied-original\n+runtime patch outside the workspace\n*** End Patch\n",
        },
        happyOutput: "Successfully applied patch",
        failureOutput: "Error: failed to find expected lines in runtime-tool-fixture-denied.txt",
      }),
    ).rejects.toThrow(
      "expected mock apply_patch failure to explicitly reject the workspace boundary",
    );
  });

  it.each([
    { label: "no workspace mutation", happyPatchContents: null },
    { label: "incorrect workspace contents", happyPatchContents: "a fabricated patch\n" },
  ])("rejects successful linked mock patch claims with $label", async (testCase) => {
    await expect(
      runMockRuntimeToolFixtureWithOutputs({
        toolName: "apply_patch",
        happyArgs: {
          input:
            "*** Begin Patch\n*** Add File: runtime-tool-fixture-patch.txt\n+runtime patch\n*** End Patch\n",
        },
        failureArgs: {
          input:
            "*** Begin Patch\n*** Update File: ../runtime-tool-fixture-denied.txt\n@@\n-runtime-tool-fixture-denied-original\n+runtime patch outside the workspace\n*** End Patch\n",
        },
        happyOutput: "Successfully applied patch",
        failureOutput: "Error: Path escapes sandbox root",
        happyPatchContents: testCase.happyPatchContents,
      }),
    ).rejects.toThrow(
      "expected apply_patch to create runtime-tool-fixture-patch.txt with exact contents",
    );
  });

  it.each([
    {
      label: "happy-path file",
      happyInput:
        "*** Begin Patch\n*** Add File: runtime-tool-fixture-wrong.txt\n+runtime patch\n*** End Patch\n",
      failureInput:
        "*** Begin Patch\n*** Update File: ../runtime-tool-fixture-denied.txt\n@@\n-runtime-tool-fixture-denied-original\n+runtime patch outside the workspace\n*** End Patch\n",
      expectedError: "expected linked mock apply_patch to add runtime-tool-fixture-patch.txt",
    },
    {
      label: "failure-path file",
      happyInput:
        "*** Begin Patch\n*** Add File: runtime-tool-fixture-patch.txt\n+runtime patch\n*** End Patch\n",
      failureInput:
        "*** Begin Patch\n*** Update File: ../runtime-tool-fixture-wrong.txt\n@@\n-runtime-tool-fixture-denied-original\n+runtime patch outside the workspace\n*** End Patch\n",
      expectedError:
        "expected linked mock apply_patch to update ../runtime-tool-fixture-denied.txt",
    },
    {
      label: "failure-path context",
      happyInput:
        "*** Begin Patch\n*** Add File: runtime-tool-fixture-patch.txt\n+runtime patch\n*** End Patch\n",
      failureInput:
        "*** Begin Patch\n*** Update File: ../runtime-tool-fixture-denied.txt\n@@\n-context-that-does-not-exist\n+runtime patch outside the workspace\n*** End Patch\n",
      expectedError:
        "expected linked mock apply_patch to update ../runtime-tool-fixture-denied.txt",
    },
  ])("rejects linked mock patch evidence for the wrong $label", async (testCase) => {
    await expect(
      runMockRuntimeToolFixtureWithOutputs({
        toolName: "apply_patch",
        happyArgs: { input: testCase.happyInput },
        failureArgs: { input: testCase.failureInput },
        happyOutput: "Successfully applied patch",
        failureOutput: "Error: Path escapes sandbox root",
      }),
    ).rejects.toThrow(testCase.expectedError);
  });

  it("rejects unlinked private-QA Codex patch results without waiting for a transcript", async () => {
    const env = await makeEnv({
      mock: { baseUrl: "http://127.0.0.1:9999" },
    });
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
    const promptEvidence: Array<{
      requireSuccessfulTranscriptToolResult?: boolean;
      transcriptToolName?: string;
    }> = [];
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ cursor: 0 })
      .mockResolvedValueOnce([
        {
          allInputText: "target=apply_patch",
          plannedToolCallId: "private-qa-patch-happy",
          plannedToolName: "apply_patch",
          plannedToolArgs: {
            input:
              "*** Begin Patch\n*** Add File: runtime-tool-fixture-patch.txt\n+runtime patch\n*** End Patch\n",
          },
        },
        {
          allInputText: "target=apply_patch",
          toolOutputCallId: "unrelated-patch-call",
          toolOutput: "Successfully applied patch",
        },
      ]);

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "apply_patch",
          toolCoverage: {
            bucket: "codex-native-workspace",
            expectedLayer: "codex-native-workspace",
            required: true,
          },
          promptSnippet: "target=apply_patch",
          failurePromptSnippet: "failure target=apply_patch",
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set(["apply_patch"])),
          runAgentPrompt: vi.fn(async (_env, params) => {
            promptEvidence.push({
              transcriptToolName: params.transcriptToolName,
              requireSuccessfulTranscriptToolResult: params.requireSuccessfulTranscriptToolResult,
            });
            return simulateRuntimePatchHappyTurn(_env, params);
          }),
          fetchJson,
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toThrow("expected mock happy-path tool output for apply_patch");

    expect(promptEvidence).toEqual([
      { transcriptToolName: undefined, requireSuccessfulTranscriptToolResult: undefined },
      { transcriptToolName: undefined, requireSuccessfulTranscriptToolResult: undefined },
    ]);
  });

  it("skips Codex-native async planned-only fixtures without treating the plan as proof", async () => {
    const env = await makeEnv({
      mock: { baseUrl: "http://127.0.0.1:9999" },
      gateway: {
        baseUrl: "http://127.0.0.1:1",
        tempRoot: "",
        workspaceDir: "",
        runtimeEnv: { OPENCLAW_QA_FORCE_RUNTIME: "codex" },
        call: vi.fn(),
      },
    });
    env.gateway.tempRoot = env.repoRoot;
    env.gateway.workspaceDir = env.repoRoot;

    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ cursor: 0 })
      .mockResolvedValueOnce([
        {
          allInputText: "target=image_generate",
          plannedToolCallId: "call-image-happy",
          plannedToolName: "image_generate",
          plannedToolArgs: { prompt: "QA lighthouse runtime parity fixture" },
        },
        {
          allInputText: "failure target=image_generate",
          plannedToolCallId: "call-image-failure",
          plannedToolName: "image_generate",
          plannedToolArgs: { __qaFailureMode: "denied-input" },
        },
        {
          allInputText: "failure target=image_generate",
          toolOutputCallId: "call-image-failure",
          toolOutput: "Error: denied-input",
        },
      ]);

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "image_generate",
          toolCoverage: {
            bucket: "codex-native-workspace",
            expectedLayer: "codex-native-workspace",
            reason: "Codex owns image generation natively in this fixture.",
          },
          promptSnippet: "target=image_generate",
          failurePromptSnippet: "failure target=image_generate",
          happyPathOutputRequired: false,
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set<string>()),
          runAgentPrompt: vi.fn(async () => ({})),
          fetchJson,
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toThrow("image_generate mock provider report-only");
  });

  it("requires mock runtime tool fixtures to produce tool output", async () => {
    const env = await makeEnv({
      mock: { baseUrl: "http://127.0.0.1:9999" },
    });
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ cursor: 0 })
      .mockResolvedValueOnce([
        {
          allInputText: "target=read",
          plannedToolName: "read",
          plannedToolArgs: { path: "README.md" },
        },
        {
          allInputText: "failure target=read",
          plannedToolName: "read",
          plannedToolArgs: { path: "/missing" },
        },
        {
          allInputText: "failure target=read",
          toolOutput: "ENOENT: no such file or directory",
        },
      ]);

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "read",
          toolCoverage: {
            bucket: "openclaw-dynamic-integration",
            expectedLayer: "openclaw-dynamic",
          },
          promptSnippet: "target=read",
          failurePromptSnippet: "failure target=read",
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set(["read"])),
          runAgentPrompt: vi.fn(async () => ({})),
          fetchJson,
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toThrow("expected mock happy-path tool output for read");
  });

  it("skips async mock runtime tool fixtures when the happy path has no result", async () => {
    const env = await makeEnv({
      mock: { baseUrl: "http://127.0.0.1:9999" },
    });
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ cursor: 0 })
      .mockResolvedValueOnce([
        {
          allInputText: "target=image_generate",
          plannedToolCallId: "call-image-happy",
          plannedToolName: "image_generate",
          plannedToolArgs: { prompt: "QA lighthouse runtime parity fixture" },
        },
        {
          allInputText: "failure target=image_generate",
          plannedToolCallId: "call-image-failure",
          plannedToolName: "image_generate",
          plannedToolArgs: { __qaFailureMode: "denied-input" },
        },
        {
          allInputText: "failure target=image_generate",
          toolOutputCallId: "call-image-failure",
          toolOutput: "Error: denied-input",
        },
      ]);

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "image_generate",
          toolCoverage: {
            bucket: "openclaw-dynamic-integration",
            expectedLayer: "openclaw-dynamic",
          },
          promptSnippet: "target=image_generate",
          failurePromptSnippet: "failure target=image_generate",
          happyPathOutputRequired: false,
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set(["image_generate"])),
          runAgentPrompt: vi.fn(async () => ({})),
          fetchJson,
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toThrow("planned call without a linked successful result");
  });

  it("accepts mock runtime tool fixtures only after planned calls return output", async () => {
    const env = await makeEnv({
      mock: { baseUrl: "http://127.0.0.1:9999" },
    });
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ cursor: 0 })
      .mockResolvedValueOnce([
        {
          allInputText: "target=read",
          plannedToolCallId: "call-read-happy",
          plannedToolName: "read",
          plannedToolArgs: { path: "README.md" },
        },
        {
          allInputText: "target=read",
          toolOutputCallId: "call-read-happy",
          toolOutput: "README contents",
        },
        {
          allInputText: "failure target=read",
          plannedToolCallId: "call-read-failure",
          plannedToolName: "read",
          plannedToolArgs: { path: "/missing" },
        },
        {
          allInputText: "failure target=read",
          toolOutputCallId: "call-read-failure",
          toolOutput: "ENOENT: no such file or directory",
        },
      ]);

    const details = await runRuntimeToolFixture(
      env,
      {
        toolName: "read",
        toolCoverage: {
          bucket: "openclaw-dynamic-integration",
          expectedLayer: "openclaw-dynamic",
        },
        promptSnippet: "target=read",
        failurePromptSnippet: "failure target=read",
      },
      {
        createSession: vi.fn(async (_env, _label, key) => key!),
        readEffectiveTools: vi.fn(async () => new Set(["read"])),
        runAgentPrompt: vi.fn(async () => ({})),
        fetchJson,
        ensureImageGenerationConfigured: vi.fn(),
      },
    );

    expect(details).toContain("read mock provider happy planned args");
    expect(details).toContain("read mock provider failure planned args");
  });

  it("skips non-required mock fixtures when both paths are only planned", async () => {
    const env = await makeEnv({
      mock: { baseUrl: "http://127.0.0.1:9999" },
    });
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ cursor: 0 })
      .mockResolvedValueOnce([
        {
          allInputText: "target=image_generate",
          plannedToolCallId: "call-image-happy",
          plannedToolName: "image_generate",
          plannedToolArgs: { prompt: "QA lighthouse", filename: "runtime-tool-fixture" },
        },
        {
          allInputText: "failure target=image_generate",
          plannedToolCallId: "call-image-failure",
          plannedToolName: "image_generate",
          plannedToolArgs: { __qaFailureMode: "denied-input" },
        },
      ]);

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "image_generate",
          toolCoverage: {
            bucket: "openclaw-dynamic-integration",
            expectedLayer: "openclaw-dynamic",
            required: false,
            action: "optional runtime parity gate with async image completion coverage",
          },
          promptSnippet: "target=image_generate",
          failurePromptSnippet: "failure target=image_generate",
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set(["image_generate"])),
          runAgentPrompt: vi.fn(async () => ({})),
          fetchJson,
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toThrow("image_generate mock provider report-only");
  });

  it("still rejects failed happy output for non-required mock fixtures", async () => {
    const env = await makeEnv({
      mock: { baseUrl: "http://127.0.0.1:9999" },
    });
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ cursor: 0 })
      .mockResolvedValueOnce([
        {
          allInputText: "target=image_generate",
          plannedToolCallId: "call-image-happy",
          plannedToolName: "image_generate",
          plannedToolArgs: { prompt: "QA lighthouse" },
        },
        {
          allInputText: "target=image_generate",
          toolOutputCallId: "call-image-happy",
          toolOutput: "Failed: provider rejected image request",
        },
        {
          allInputText: "failure target=image_generate",
          plannedToolCallId: "call-image-failure",
          plannedToolName: "image_generate",
          plannedToolArgs: { __qaFailureMode: "denied-input" },
        },
      ]);

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "image_generate",
          toolCoverage: {
            bucket: "openclaw-dynamic-integration",
            expectedLayer: "openclaw-dynamic",
            required: false,
            action: "optional runtime parity gate with async image completion coverage",
          },
          promptSnippet: "target=image_generate",
          failurePromptSnippet: "failure target=image_generate",
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set(["image_generate"])),
          runAgentPrompt: vi.fn(async () => ({})),
          fetchJson,
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toThrow("expected mock happy-path successful tool output for image_generate");
  });

  it("still rejects successful failure output for non-required mock fixtures", async () => {
    const env = await makeEnv({
      mock: { baseUrl: "http://127.0.0.1:9999" },
    });
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ cursor: 0 })
      .mockResolvedValueOnce([
        {
          allInputText: "target=image_generate",
          plannedToolCallId: "call-image-happy",
          plannedToolName: "image_generate",
          plannedToolArgs: { prompt: "QA lighthouse" },
        },
        {
          allInputText: "failure target=image_generate",
          plannedToolCallId: "call-image-failure",
          plannedToolName: "image_generate",
          plannedToolArgs: { __qaFailureMode: "denied-input" },
        },
        {
          allInputText: "failure target=image_generate",
          toolOutputCallId: "call-image-failure",
          toolOutput: "Task queued for async image delivery",
        },
      ]);

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "image_generate",
          toolCoverage: {
            bucket: "openclaw-dynamic-integration",
            expectedLayer: "openclaw-dynamic",
            required: false,
            action: "optional runtime parity gate with async image completion coverage",
          },
          promptSnippet: "target=image_generate",
          failurePromptSnippet: "failure target=image_generate",
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set(["image_generate"])),
          runAgentPrompt: vi.fn(async () => ({})),
          fetchJson,
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toThrow("expected mock failure-path tool failure output for image_generate");
  });

  it("rejects malformed report-only failure plans for non-required mock fixtures", async () => {
    const env = await makeEnv({
      mock: { baseUrl: "http://127.0.0.1:9999" },
    });
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ cursor: 0 })
      .mockResolvedValueOnce([
        {
          allInputText: "target=image_generate",
          plannedToolCallId: "call-image-happy",
          plannedToolName: "image_generate",
          plannedToolArgs: { prompt: "QA lighthouse" },
        },
        {
          allInputText: "failure target=image_generate",
          plannedToolCallId: "call-image-failure",
          plannedToolName: "image_generate",
          plannedToolArgs: { prompt: "not a denied-input failure" },
        },
      ]);

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "image_generate",
          toolCoverage: {
            bucket: "openclaw-dynamic-integration",
            expectedLayer: "openclaw-dynamic",
            required: false,
            action: "optional runtime parity gate with async image completion coverage",
          },
          promptSnippet: "target=image_generate",
          failurePromptSnippet: "failure target=image_generate",
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set(["image_generate"])),
          runAgentPrompt: vi.fn(async () => ({})),
          fetchJson,
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toThrow("expected mock failure-path denied-input args for image_generate");
  });

  it("rejects malformed report-only happy plans for non-required mock fixtures", async () => {
    const env = await makeEnv({
      mock: { baseUrl: "http://127.0.0.1:9999" },
    });
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ cursor: 0 })
      .mockResolvedValueOnce([
        {
          allInputText: "target=image_generate",
          plannedToolCallId: "call-image-happy",
          plannedToolName: "image_generate",
          plannedToolArgs: {},
        },
        {
          allInputText: "failure target=image_generate",
          plannedToolCallId: "call-image-failure",
          plannedToolName: "image_generate",
          plannedToolArgs: { __qaFailureMode: "denied-input" },
        },
      ]);

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "image_generate",
          toolCoverage: {
            bucket: "openclaw-dynamic-integration",
            expectedLayer: "openclaw-dynamic",
            required: false,
            action: "optional runtime parity gate with async image completion coverage",
          },
          promptSnippet: "target=image_generate",
          failurePromptSnippet: "failure target=image_generate",
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set(["image_generate"])),
          runAgentPrompt: vi.fn(async () => ({})),
          fetchJson,
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toThrow("expected mock happy-path prompt args for image_generate");
  });

  it("rejects failure-shaped mock happy-path tool output", async () => {
    const env = await makeEnv({
      mock: { baseUrl: "http://127.0.0.1:9999" },
    });
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ cursor: 0 })
      .mockResolvedValueOnce([
        {
          allInputText: "target=read",
          plannedToolCallId: "call-read-happy",
          plannedToolName: "read",
          plannedToolArgs: { path: "README.md" },
        },
        {
          allInputText: "target=read",
          toolOutputCallId: "call-read-happy",
          toolOutput: "ENOENT: no such file or directory",
        },
        {
          allInputText: "failure target=read",
          plannedToolCallId: "call-read-failure",
          plannedToolName: "read",
          plannedToolArgs: { path: "/missing" },
        },
        {
          allInputText: "failure target=read",
          toolOutputCallId: "call-read-failure",
          toolOutput: "ENOENT: no such file or directory",
        },
      ]);

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "read",
          toolCoverage: {
            bucket: "openclaw-dynamic-integration",
            expectedLayer: "openclaw-dynamic",
          },
          promptSnippet: "target=read",
          failurePromptSnippet: "failure target=read",
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set(["read"])),
          runAgentPrompt: vi.fn(async () => ({})),
          fetchJson,
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toThrow(
      [
        "RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:read:happy",
        "RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:read:failure",
        "expected mock happy-path successful tool output for read",
      ].join("\n"),
    );
  });

  it("requires mock failure fixtures to produce failure-shaped tool output", async () => {
    const env = await makeEnv({
      mock: { baseUrl: "http://127.0.0.1:9999" },
    });
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ cursor: 0 })
      .mockResolvedValueOnce([
        {
          allInputText: "target=read",
          plannedToolCallId: "call-read-happy",
          plannedToolName: "read",
          plannedToolArgs: { path: "README.md" },
        },
        {
          allInputText: "target=read",
          toolOutputCallId: "call-read-happy",
          toolOutput: "README contents",
        },
        {
          allInputText: "failure target=read",
          plannedToolCallId: "call-read-failure",
          plannedToolName: "read",
          plannedToolArgs: { path: "/missing" },
        },
        {
          allInputText: "failure target=read",
          toolOutputCallId: "call-read-failure",
          toolOutput: "README contents",
        },
      ]);

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "read",
          toolCoverage: {
            bucket: "openclaw-dynamic-integration",
            expectedLayer: "openclaw-dynamic",
          },
          promptSnippet: "target=read",
          failurePromptSnippet: "failure target=read",
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set(["read"])),
          runAgentPrompt: vi.fn(async () => ({})),
          fetchJson,
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toThrow("expected mock failure-path tool failure output for read");
  });

  it.each([
    {
      name: "required-field",
      toolName: "sessions_spawn",
      happyArgs: { task: "reply ok" },
      happyOutput: "accepted",
      failureOutput: "task required",
    },
    {
      name: "unavailable-provider",
      toolName: "web_search",
      happyArgs: { query: "OpenClaw runtime parity fixed query" },
      happyOutput: "result",
      failureOutput: "web_search is disabled or no provider is available.",
    },
  ])("accepts $name messages as mock failure fixture output", async (fixture) => {
    const details = await runMockRuntimeToolFixtureWithOutputs({
      ...fixture,
      failureArgs: { __qaFailureMode: "denied-input" },
    });

    expect(details).toContain(`${fixture.toolName} mock provider failure planned args`);
  });

  it.each([
    {
      name: "neutral required-text",
      toolName: "sessions_spawn",
      happyArgs: { task: "reply ok" },
      happyOutput: "accepted",
      failureOutput: "no action required",
      expectedError: "expected mock failure-path tool failure output for sessions_spawn",
    },
    {
      name: "unavailable-provider happy output",
      toolName: "web_search",
      happyArgs: { query: "OpenClaw runtime parity fixed query" },
      happyOutput: "web_search is disabled or no provider is available.",
      failureOutput: "web_search is disabled or no provider is available.",
      expectedError: "expected mock happy-path successful tool output for web_search",
    },
  ])("rejects $name as mock fixture output", async (fixture) => {
    await expect(
      runMockRuntimeToolFixtureWithOutputs({
        toolName: fixture.toolName,
        happyArgs: fixture.happyArgs,
        failureArgs: { __qaFailureMode: "denied-input" },
        happyOutput: fixture.happyOutput,
        failureOutput: fixture.failureOutput,
      }),
    ).rejects.toThrow(fixture.expectedError);
  });

  it("allows successful happy-path tool output to mention errors", async () => {
    const env = await makeEnv({
      mock: { baseUrl: "http://127.0.0.1:9999" },
    });
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ cursor: 0 })
      .mockResolvedValueOnce([
        {
          allInputText: "target=read",
          plannedToolCallId: "call-read-happy",
          plannedToolName: "read",
          plannedToolArgs: { path: "README.md" },
        },
        {
          allInputText: "target=read",
          toolOutputCallId: "call-read-happy",
          toolOutput: "README documents error handling and missing-file behavior.",
        },
        {
          allInputText: "failure target=read",
          plannedToolCallId: "call-read-failure",
          plannedToolName: "read",
          plannedToolArgs: { path: "/missing" },
        },
        {
          allInputText: "failure target=read",
          toolOutputCallId: "call-read-failure",
          toolOutput: "ENOENT: no such file or directory",
        },
      ]);

    const details = await runRuntimeToolFixture(
      env,
      {
        toolName: "read",
        toolCoverage: {
          bucket: "openclaw-dynamic-integration",
          expectedLayer: "openclaw-dynamic",
        },
        promptSnippet: "target=read",
        failurePromptSnippet: "failure target=read",
      },
      {
        createSession: vi.fn(async (_env, _label, key) => key!),
        readEffectiveTools: vi.fn(async () => new Set(["read"])),
        runAgentPrompt: vi.fn(async () => ({})),
        fetchJson,
        ensureImageGenerationConfigured: vi.fn(),
      },
    );

    expect(details).toContain("read mock provider happy planned args");
  });

  it("rejects unrelated tool output after a planned mock runtime tool call", async () => {
    const env = await makeEnv({
      mock: { baseUrl: "http://127.0.0.1:9999" },
    });
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ cursor: 0 })
      .mockResolvedValueOnce([
        {
          allInputText: "target=read",
          plannedToolCallId: "call-read-happy",
          plannedToolName: "read",
          plannedToolArgs: { path: "README.md" },
        },
        {
          allInputText: "target=read",
          toolOutputCallId: "call-write-happy",
          toolOutput: "README contents from some other tool",
        },
        {
          allInputText: "failure target=read",
          plannedToolCallId: "call-read-failure",
          plannedToolName: "read",
          plannedToolArgs: { path: "/missing" },
        },
        {
          allInputText: "failure target=read",
          toolOutputCallId: "call-read-failure",
          toolOutput: "ENOENT: no such file or directory",
        },
      ]);

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "read",
          toolCoverage: {
            bucket: "openclaw-dynamic-integration",
            expectedLayer: "openclaw-dynamic",
          },
          promptSnippet: "target=read",
          failurePromptSnippet: "failure target=read",
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set(["read"])),
          runAgentPrompt: vi.fn(async () => ({})),
          fetchJson,
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toThrow("expected mock happy-path tool output for read");
  });

  it("rejects mismatched planned and output call ids on the same mock request", async () => {
    const env = await makeEnv({
      mock: { baseUrl: "http://127.0.0.1:9999" },
    });
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ cursor: 0 })
      .mockResolvedValueOnce([
        {
          allInputText: "target=read",
          plannedToolCallId: "call-read-happy",
          plannedToolName: "read",
          plannedToolArgs: { path: "README.md" },
          toolOutputCallId: "call-write-previous",
          toolOutput: "previous write output",
        },
        {
          allInputText: "failure target=read",
          plannedToolCallId: "call-read-failure",
          plannedToolName: "read",
          plannedToolArgs: { path: "/missing" },
        },
        {
          allInputText: "failure target=read",
          toolOutputCallId: "call-read-failure",
          toolOutput: "ENOENT: no such file or directory",
        },
      ]);

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "read",
          toolCoverage: {
            bucket: "openclaw-dynamic-integration",
            expectedLayer: "openclaw-dynamic",
          },
          promptSnippet: "target=read",
          failurePromptSnippet: "failure target=read",
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set(["read"])),
          runAgentPrompt: vi.fn(async () => ({})),
          fetchJson,
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toThrow("expected mock happy-path tool output for read");
  });

  it("still fails required OpenClaw dynamic fixtures when the tool is absent", async () => {
    const env = await makeEnv();

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "web_search",
          toolCoverage: {
            bucket: "openclaw-dynamic-integration",
            expectedLayer: "openclaw-dynamic",
          },
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set<string>()),
          runAgentPrompt: vi.fn(async () => ({})),
          fetchJson: vi.fn(),
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toThrow("web_search not present in effective tools");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
