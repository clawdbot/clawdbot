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

function transcriptToolCall(
  toolName: string,
  phase: "happy" | "failure",
  input: Record<string, unknown>,
) {
  return {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: `call-${toolName}-${phase}`,
        name: toolName,
        input,
      },
    ],
  };
}

function transcriptToolResult(
  toolName: string,
  phase: "happy" | "failure",
  content: string,
  isError?: boolean,
) {
  return {
    role: "tool",
    toolName,
    tool_call_id: `call-${toolName}-${phase}`,
    ...(isError === undefined ? {} : { isError }),
    content,
  };
}

async function writeRuntimeToolTranscripts(
  env: QaSuiteRuntimeEnv,
  toolName: string,
  happyMessages: Array<Record<string, unknown>>,
  failureMessages: Array<Record<string, unknown>>,
) {
  await writeQaSessionTranscript(env, `agent:qa:runtime-tool:${toolName}:happy`, happyMessages);
  await writeQaSessionTranscript(env, `agent:qa:runtime-tool:${toolName}:failure`, failureMessages);
}

async function writeLiveRuntimeToolEvidence(env: QaSuiteRuntimeEnv, toolName = "read") {
  await writeRuntimeToolTranscripts(
    env,
    toolName,
    [
      transcriptToolCall(toolName, "happy", { path: "README.md" }),
      transcriptToolResult(toolName, "happy", "README contents"),
    ],
    [
      transcriptToolCall(toolName, "failure", { path: "/missing" }),
      transcriptToolResult(toolName, "failure", "outside allowed scope", true),
    ],
  );
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

type RuntimeToolFixtureConfig = Parameters<typeof runRuntimeToolFixture>[1];
type RuntimeToolFixtureDeps = Parameters<typeof runRuntimeToolFixture>[2];

const MOCK_BASE_URL = "http://127.0.0.1:9999";

function runtimeToolFixtureConfig(
  toolName: string,
  overrides: RuntimeToolFixtureConfig = {},
): RuntimeToolFixtureConfig {
  return {
    toolName,
    toolCoverage: {
      bucket: "openclaw-dynamic-integration",
      expectedLayer: "openclaw-dynamic",
    },
    ...overrides,
  };
}

function nativePatchFixtureConfig(): RuntimeToolFixtureConfig {
  return runtimeToolFixtureConfig("apply_patch", {
    toolCoverage: {
      bucket: "codex-native-workspace",
      expectedLayer: "codex-native-workspace",
      required: true,
    },
  });
}

function runtimeToolFixtureDeps(
  params: {
    tools?: Iterable<string>;
    fetchJson?: RuntimeToolFixtureDeps["fetchJson"];
    runAgentPrompt?: RuntimeToolFixtureDeps["runAgentPrompt"];
  } = {},
): RuntimeToolFixtureDeps {
  return {
    createSession: vi.fn(async (_env, _label, key) => key!),
    readEffectiveTools: vi.fn(async () => new Set(params.tools)),
    runAgentPrompt: params.runAgentPrompt ?? vi.fn(async () => ({})),
    fetchJson: params.fetchJson ?? vi.fn(),
    ensureImageGenerationConfigured: vi.fn(),
  };
}

function runLiveRuntimeToolFixture(
  env: QaSuiteRuntimeEnv,
  params: {
    toolName?: string;
    config?: RuntimeToolFixtureConfig;
    tools?: Iterable<string>;
    runAgentPrompt?: RuntimeToolFixtureDeps["runAgentPrompt"];
  } = {},
) {
  const toolName = params.toolName ?? "read";
  return runRuntimeToolFixture(
    env,
    params.config ?? runtimeToolFixtureConfig(toolName),
    runtimeToolFixtureDeps({
      tools: params.tools ?? [toolName],
      runAgentPrompt: params.runAgentPrompt,
    }),
  );
}

function runNativePatchFixture(
  env: QaSuiteRuntimeEnv,
  params: {
    tools?: Iterable<string>;
    runAgentPrompt?: RuntimeToolFixtureDeps["runAgentPrompt"];
  } = {},
) {
  return runLiveRuntimeToolFixture(env, {
    toolName: "apply_patch",
    config: nativePatchFixtureConfig(),
    tools: params.tools ?? [],
    runAgentPrompt: params.runAgentPrompt ?? vi.fn(simulateRuntimePatchHappyTurn),
  });
}

function mockRequestLog(requests: Array<Record<string, unknown>>) {
  return vi.fn().mockResolvedValueOnce({ cursor: 0 }).mockResolvedValueOnce(requests);
}

function mockToolRequests(params: {
  toolName?: string;
  happyArgs?: Record<string, unknown>;
  happyOutput?: string;
  failureArgs?: Record<string, unknown>;
  failureOutput?: string;
  happyCallId?: string;
  happyOutputCallId?: string;
  failureCallId?: string;
  failureOutputCallId?: string;
  omitHappyOutput?: boolean;
  omitFailureOutput?: boolean;
}) {
  const toolName = params.toolName ?? "read";
  const happyCallId = params.happyCallId ?? `call-${toolName}-happy`;
  const failureCallId = params.failureCallId ?? `call-${toolName}-failure`;
  return [
    {
      allInputText: `target=${toolName}`,
      plannedToolCallId: happyCallId,
      plannedToolName: toolName,
      plannedToolArgs: params.happyArgs ?? { path: "README.md" },
    },
    ...(params.omitHappyOutput
      ? []
      : [
          {
            allInputText: `target=${toolName}`,
            toolOutputCallId: params.happyOutputCallId ?? happyCallId,
            toolOutput: params.happyOutput ?? "README contents",
          },
        ]),
    {
      allInputText: `failure target=${toolName}`,
      plannedToolCallId: failureCallId,
      plannedToolName: toolName,
      plannedToolArgs: params.failureArgs ?? { path: "/missing" },
    },
    ...(params.omitFailureOutput
      ? []
      : [
          {
            allInputText: `failure target=${toolName}`,
            toolOutputCallId: params.failureOutputCallId ?? failureCallId,
            toolOutput: params.failureOutput ?? "ENOENT: no such file or directory",
          },
        ]),
  ];
}

async function runMockRuntimeToolFixture(params: {
  env?: QaSuiteRuntimeEnv;
  toolName?: string;
  requests: Array<Record<string, unknown>>;
  config?: RuntimeToolFixtureConfig;
  tools?: Iterable<string>;
  runAgentPrompt?: RuntimeToolFixtureDeps["runAgentPrompt"];
  forceCodex?: boolean;
}) {
  const toolName = params.toolName ?? "read";
  const env = params.env ?? (await makeEnv({ mock: { baseUrl: MOCK_BASE_URL } }));
  if (params.forceCodex) {
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
  }
  return runRuntimeToolFixture(
    env,
    runtimeToolFixtureConfig(toolName, {
      promptSnippet: `target=${toolName}`,
      failurePromptSnippet: `failure target=${toolName}`,
      ...params.config,
    }),
    runtimeToolFixtureDeps({
      tools: params.tools ?? [toolName],
      fetchJson: mockRequestLog(params.requests),
      runAgentPrompt: params.runAgentPrompt,
    }),
  );
}

function asyncImageFixtureConfig(overrides: RuntimeToolFixtureConfig = {}) {
  return runtimeToolFixtureConfig("image_generate", {
    toolCoverage: {
      bucket: "openclaw-dynamic-integration",
      expectedLayer: "openclaw-dynamic",
      required: false,
      action: "optional runtime parity gate with async image completion coverage",
    },
    promptSnippet: "target=image_generate",
    failurePromptSnippet: "failure target=image_generate",
    ...overrides,
  });
}

function runtimePatchAddInput(file = "runtime-tool-fixture-patch.txt") {
  return `*** Begin Patch\n*** Add File: ${file}\n+runtime patch\n*** End Patch\n`;
}

function runtimePatchUpdateInput(
  file = "../runtime-tool-fixture-denied.txt",
  context = "runtime-tool-fixture-denied-original",
) {
  return `*** Begin Patch\n*** Update File: ${file}\n@@\n-${context}\n+runtime patch outside the workspace\n*** End Patch\n`;
}

async function runMockRuntimeToolFixtureWithOutputs(params: {
  toolName: string;
  happyArgs: Record<string, unknown>;
  failureArgs: Record<string, unknown>;
  happyOutput: string;
  failureOutput: string;
  happyPatchContents?: string | null;
}) {
  return runMockRuntimeToolFixture({
    toolName: params.toolName,
    requests: mockToolRequests(params),
    runAgentPrompt: vi.fn(async (runEnv, promptParams) =>
      params.toolName === "apply_patch"
        ? simulateRuntimePatchHappyTurn(runEnv, promptParams, params.happyPatchContents)
        : {},
    ),
  });
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

    const result = runLiveRuntimeToolFixture(env, { runAgentPrompt });
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
    await writeRuntimeToolTranscripts(
      env,
      "read",
      [{ role: "assistant", content: "I checked README.md and it looks good." }],
      [{ role: "assistant", content: "The denied-input path looks good." }],
    );

    await expect(runLiveRuntimeToolFixture(env)).rejects.toThrow(
      "expected live happy-path tool call for read",
    );
  });

  it("accepts live runtime tool fixtures only after transcript tool output", async () => {
    const env = await makeEnv();
    await writeLiveRuntimeToolEvidence(env);

    const details = await runLiveRuntimeToolFixture(env);

    expect(details).toContain("read live provider happy planned args");
    expect(details).toContain("read live provider failure planned args");
  });

  it("skips async live runtime tool fixtures when the happy path has no result", async () => {
    const env = await makeEnv();
    await writeRuntimeToolTranscripts(
      env,
      "image_generate",
      [
        transcriptToolCall("image_generate", "happy", {
          prompt: "QA lighthouse runtime parity fixture",
        }),
      ],
      [
        transcriptToolCall("image_generate", "failure", {
          __qaFailureMode: "denied-input",
        }),
        transcriptToolResult("image_generate", "failure", "denied-input", true),
      ],
    );

    await expect(
      runLiveRuntimeToolFixture(env, {
        toolName: "image_generate",
        config: runtimeToolFixtureConfig("image_generate", { happyPathOutputRequired: false }),
      }),
    ).rejects.toThrow("planned call without a linked successful result");
  });

  it("still requires async live runtime tool fixtures to call the happy-path tool", async () => {
    const env = await makeEnv();
    await writeRuntimeToolTranscripts(
      env,
      "image_generate",
      [{ role: "assistant", content: "I can start image generation later." }],
      [
        transcriptToolCall("image_generate", "failure", {
          __qaFailureMode: "denied-input",
        }),
        transcriptToolResult("image_generate", "failure", "denied-input", true),
      ],
    );

    await expect(
      runLiveRuntimeToolFixture(env, {
        toolName: "image_generate",
        config: runtimeToolFixtureConfig("image_generate", { happyPathOutputRequired: false }),
      }),
    ).rejects.toThrow("expected live happy-path tool call for image_generate");
  });

  it("requires live failure fixtures to produce failure-shaped tool output", async () => {
    const env = await makeEnv();
    await writeRuntimeToolTranscripts(
      env,
      "read",
      [
        transcriptToolCall("read", "happy", { path: "README.md" }),
        transcriptToolResult(
          "read",
          "happy",
          "README documents invalid requests, errors, and denied inputs.",
        ),
      ],
      [
        transcriptToolCall("read", "failure", { path: "/missing" }),
        transcriptToolResult("read", "failure", "README contents"),
      ],
    );

    await expect(runLiveRuntimeToolFixture(env)).rejects.toThrow(
      "expected live failure-path tool failure output for read",
    );
  });

  it("rejects failure-shaped live happy-path tool output", async () => {
    const env = await makeEnv();
    await writeRuntimeToolTranscripts(
      env,
      "read",
      [
        transcriptToolCall("read", "happy", { path: "README.md" }),
        transcriptToolResult("read", "happy", "ENOENT: no such file or directory", true),
      ],
      [
        transcriptToolCall("read", "failure", { path: "/missing" }),
        transcriptToolResult("read", "failure", "ENOENT: no such file or directory", true),
      ],
    );

    await expect(runLiveRuntimeToolFixture(env)).rejects.toThrow(
      "expected live happy-path successful tool output for read",
    );
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

    const details = await runNativePatchFixture(env, {
      runAgentPrompt: vi.fn(async (_env, params) => {
        promptEvidence.push({
          transcriptToolName: params.transcriptToolName,
          requireSuccessfulTranscriptToolResult: params.requireSuccessfulTranscriptToolResult,
        });
        return simulateRuntimePatchHappyTurn(_env, params);
      }),
    });

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
      runNativePatchFixture(env, {
        tools: ["apply_patch"],
        runAgentPrompt: vi.fn(async (_env, params) => {
          promptEvidence.push({
            transcriptToolName: params.transcriptToolName,
            requireSuccessfulTranscriptToolResult: params.requireSuccessfulTranscriptToolResult,
          });
          return simulateRuntimePatchHappyTurn(_env, params);
        }),
      }),
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

    await expect(runNativePatchFixture(env)).rejects.toThrow(
      "expected linked live apply_patch to add runtime-tool-fixture-patch.txt",
    );
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

    await expect(runNativePatchFixture(env)).resolves.toContain(
      "apply_patch live provider happy planned args",
    );

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

    await expect(runNativePatchFixture(env)).resolves.toContain(
      "apply_patch live provider happy planned args",
    );
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

    await expect(runNativePatchFixture(env)).rejects.toThrow(
      "expected live failure-path tool call for apply_patch",
    );

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

    await expect(runNativePatchFixture(env)).resolves.toContain(
      "apply_patch live provider happy planned args",
    );
  });

  it("rejects native patch transcripts that claim success without creating the workspace file", async () => {
    const env = await makeEnv();
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
    await writeCodexNativePatchEvidence(env);

    await expect(
      runNativePatchFixture(env, { runAgentPrompt: vi.fn(async () => ({})) }),
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

    await expect(runNativePatchFixture(env)).rejects.toThrow(
      "expected live apply_patch failure to explicitly reject the workspace boundary",
    );
  });

  it("rejects native Codex patch failures without a linked failure result", async () => {
    const env = await makeEnv();
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
    await writeCodexNativePatchEvidence(env, "apply_patch completed", {
      failureStructuredError: false,
    });

    await expect(runNativePatchFixture(env)).rejects.toThrow(
      "expected live failure-path tool failure output for apply_patch",
    );
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

    await expect(runNativePatchFixture(env)).rejects.toThrow(testCase.expectedError);
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

    await expect(runNativePatchFixture(env)).resolves.toContain(
      "apply_patch live provider happy planned args",
    );
  });

  it("fails closed and cleans up when a patch changes the outside-workspace sentinel", async () => {
    const env = await makeEnv();
    const sentinelPath = path.resolve(
      env.gateway.workspaceDir,
      "../runtime-tool-fixture-denied.txt",
    );

    await expect(
      runLiveRuntimeToolFixture(env, {
        toolName: "apply_patch",
        runAgentPrompt: vi.fn(async (_env, params) => {
          if (params.sessionKey.endsWith(":failure")) {
            expect(await fs.readFile(sentinelPath, "utf8")).toBe(
              "runtime-tool-fixture-denied-original\n",
            );
            await fs.writeFile(sentinelPath, "runtime patch outside the workspace\n", "utf8");
          }
          return simulateRuntimePatchHappyTurn(_env, params);
        }),
      }),
    ).rejects.toThrow("apply_patch modified or removed the outside-workspace sentinel");

    await expect(fs.access(sentinelPath)).rejects.toThrow();
  });

  it("fails closed when required native Codex patch execution has no linked transcript", async () => {
    const env = await makeEnv();
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
    await writeRuntimeToolTranscripts(
      env,
      "apply_patch",
      [{ role: "assistant", content: "The patch was applied." }],
      [{ role: "assistant", content: "The unsafe patch was rejected." }],
    );

    await expect(runNativePatchFixture(env)).rejects.toThrow(
      "expected live happy-path tool call for apply_patch",
    );
  });

  it.each([
    { label: "dynamically exposed", dynamicPatchExposed: true },
    { label: "native-only", dynamicPatchExposed: false },
  ])("verifies $label private-QA Codex patch calls without skipping them", async (testCase) => {
    const env = await makeEnv({ mock: { baseUrl: MOCK_BASE_URL } });
    const promptEvidence: Array<{
      requireSuccessfulTranscriptToolResult?: boolean;
      transcriptToolName?: string;
    }> = [];
    const details = await runMockRuntimeToolFixture({
      env,
      toolName: "apply_patch",
      requests: mockToolRequests({
        toolName: "apply_patch",
        happyArgs: { input: runtimePatchAddInput() },
        failureArgs: { input: runtimePatchUpdateInput() },
        happyOutput: "Successfully applied patch",
        failureOutput: "Error: Path escapes sandbox root",
        happyCallId: "private-qa-patch-happy",
        failureCallId: "private-qa-patch-failure",
      }),
      config: nativePatchFixtureConfig(),
      tools: testCase.dynamicPatchExposed ? ["apply_patch"] : [],
      forceCodex: true,
      runAgentPrompt: vi.fn(async (_env, params) => {
        promptEvidence.push({
          transcriptToolName: params.transcriptToolName,
          requireSuccessfulTranscriptToolResult: params.requireSuccessfulTranscriptToolResult,
        });
        return simulateRuntimePatchHappyTurn(_env, params);
      }),
    });

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
    const promptEvidence: Array<{
      requireSuccessfulTranscriptToolResult?: boolean;
      transcriptToolName?: string;
    }> = [];
    const requests = [
      {
        allInputText: "target=apply_patch",
        plannedToolCallId: "private-qa-patch-happy",
        plannedToolName: "apply_patch",
        plannedToolArgs: { input: runtimePatchAddInput() },
      },
      {
        allInputText: "target=apply_patch",
        toolOutputCallId: "unrelated-patch-call",
        toolOutput: "Successfully applied patch",
      },
    ];

    await expect(
      runMockRuntimeToolFixture({
        toolName: "apply_patch",
        requests,
        config: nativePatchFixtureConfig(),
        tools: ["apply_patch"],
        forceCodex: true,
        runAgentPrompt: vi.fn(async (_env, params) => {
          promptEvidence.push({
            transcriptToolName: params.transcriptToolName,
            requireSuccessfulTranscriptToolResult: params.requireSuccessfulTranscriptToolResult,
          });
          return simulateRuntimePatchHappyTurn(_env, params);
        }),
      }),
    ).rejects.toThrow("expected mock happy-path tool output for apply_patch");

    expect(promptEvidence).toEqual([
      { transcriptToolName: undefined, requireSuccessfulTranscriptToolResult: undefined },
      { transcriptToolName: undefined, requireSuccessfulTranscriptToolResult: undefined },
    ]);
  });

  it("skips Codex-native async planned-only fixtures without treating the plan as proof", async () => {
    await expect(
      runMockRuntimeToolFixture({
        toolName: "image_generate",
        requests: mockToolRequests({
          toolName: "image_generate",
          happyArgs: { prompt: "QA lighthouse runtime parity fixture" },
          failureArgs: { __qaFailureMode: "denied-input" },
          omitHappyOutput: true,
          failureOutput: "Error: denied-input",
        }),
        config: runtimeToolFixtureConfig("image_generate", {
          toolCoverage: {
            bucket: "codex-native-workspace",
            expectedLayer: "codex-native-workspace",
            reason: "Codex owns image generation natively in this fixture.",
          },
          happyPathOutputRequired: false,
        }),
        tools: [],
        forceCodex: true,
      }),
    ).rejects.toThrow("image_generate mock provider report-only");
  });

  it("requires mock runtime tool fixtures to produce tool output", async () => {
    const requests = [
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
    ];

    await expect(runMockRuntimeToolFixture({ requests })).rejects.toThrow(
      "expected mock happy-path tool output for read",
    );
  });

  it("skips async mock runtime tool fixtures when the happy path has no result", async () => {
    await expect(
      runMockRuntimeToolFixture({
        toolName: "image_generate",
        requests: mockToolRequests({
          toolName: "image_generate",
          happyArgs: { prompt: "QA lighthouse runtime parity fixture" },
          failureArgs: { __qaFailureMode: "denied-input" },
          omitHappyOutput: true,
          failureOutput: "Error: denied-input",
        }),
        config: runtimeToolFixtureConfig("image_generate", {
          happyPathOutputRequired: false,
        }),
      }),
    ).rejects.toThrow("planned call without a linked successful result");
  });

  it("accepts mock runtime tool fixtures only after planned calls return output", async () => {
    const details = await runMockRuntimeToolFixture({ requests: mockToolRequests({}) });

    expect(details).toContain("read mock provider happy planned args");
    expect(details).toContain("read mock provider failure planned args");
  });

  it("skips non-required mock fixtures when both paths are only planned", async () => {
    await expect(
      runMockRuntimeToolFixture({
        toolName: "image_generate",
        requests: mockToolRequests({
          toolName: "image_generate",
          happyArgs: { prompt: "QA lighthouse", filename: "runtime-tool-fixture" },
          failureArgs: { __qaFailureMode: "denied-input" },
          omitHappyOutput: true,
          omitFailureOutput: true,
        }),
        config: asyncImageFixtureConfig(),
      }),
    ).rejects.toThrow("image_generate mock provider report-only");
  });

  it("still rejects failed happy output for non-required mock fixtures", async () => {
    await expect(
      runMockRuntimeToolFixture({
        toolName: "image_generate",
        requests: mockToolRequests({
          toolName: "image_generate",
          happyArgs: { prompt: "QA lighthouse" },
          happyOutput: "Failed: provider rejected image request",
          failureArgs: { __qaFailureMode: "denied-input" },
          omitFailureOutput: true,
        }),
        config: asyncImageFixtureConfig(),
      }),
    ).rejects.toThrow("expected mock happy-path successful tool output for image_generate");
  });

  it("still rejects successful failure output for non-required mock fixtures", async () => {
    await expect(
      runMockRuntimeToolFixture({
        toolName: "image_generate",
        requests: mockToolRequests({
          toolName: "image_generate",
          happyArgs: { prompt: "QA lighthouse" },
          omitHappyOutput: true,
          failureArgs: { __qaFailureMode: "denied-input" },
          failureOutput: "Task queued for async image delivery",
        }),
        config: asyncImageFixtureConfig(),
      }),
    ).rejects.toThrow("expected mock failure-path tool failure output for image_generate");
  });

  it("rejects malformed report-only failure plans for non-required mock fixtures", async () => {
    await expect(
      runMockRuntimeToolFixture({
        toolName: "image_generate",
        requests: mockToolRequests({
          toolName: "image_generate",
          happyArgs: { prompt: "QA lighthouse" },
          failureArgs: { prompt: "not a denied-input failure" },
          omitHappyOutput: true,
          omitFailureOutput: true,
        }),
        config: asyncImageFixtureConfig(),
      }),
    ).rejects.toThrow("expected mock failure-path denied-input args for image_generate");
  });

  it("rejects malformed report-only happy plans for non-required mock fixtures", async () => {
    await expect(
      runMockRuntimeToolFixture({
        toolName: "image_generate",
        requests: mockToolRequests({
          toolName: "image_generate",
          happyArgs: {},
          failureArgs: { __qaFailureMode: "denied-input" },
          omitHappyOutput: true,
          omitFailureOutput: true,
        }),
        config: asyncImageFixtureConfig(),
      }),
    ).rejects.toThrow("expected mock happy-path prompt args for image_generate");
  });

  it("rejects failure-shaped mock happy-path tool output", async () => {
    await expect(
      runMockRuntimeToolFixture({
        requests: mockToolRequests({ happyOutput: "ENOENT: no such file or directory" }),
      }),
    ).rejects.toThrow(
      [
        "RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:read:happy",
        "RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:read:failure",
        "expected mock happy-path successful tool output for read",
      ].join("\n"),
    );
  });

  it("requires mock failure fixtures to produce failure-shaped tool output", async () => {
    await expect(
      runMockRuntimeToolFixture({
        requests: mockToolRequests({ failureOutput: "README contents" }),
      }),
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
    const details = await runMockRuntimeToolFixture({
      requests: mockToolRequests({
        happyOutput: "README documents error handling and missing-file behavior.",
      }),
    });

    expect(details).toContain("read mock provider happy planned args");
  });

  it("rejects unrelated tool output after a planned mock runtime tool call", async () => {
    await expect(
      runMockRuntimeToolFixture({
        requests: mockToolRequests({
          happyOutputCallId: "call-write-happy",
          happyOutput: "README contents from some other tool",
        }),
      }),
    ).rejects.toThrow("expected mock happy-path tool output for read");
  });

  it("rejects mismatched planned and output call ids on the same mock request", async () => {
    const requests = [
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
    ];

    await expect(runMockRuntimeToolFixture({ requests })).rejects.toThrow(
      "expected mock happy-path tool output for read",
    );
  });

  it("still fails required OpenClaw dynamic fixtures when the tool is absent", async () => {
    const env = await makeEnv();

    await expect(
      runLiveRuntimeToolFixture(env, { toolName: "web_search", tools: [] }),
    ).rejects.toThrow("web_search not present in effective tools");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
