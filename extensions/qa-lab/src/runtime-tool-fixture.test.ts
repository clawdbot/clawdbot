// Qa Lab tests cover runtime tool fixture plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runRuntimeToolFixture } from "./runtime-tool-fixture.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

const tempRoots: string[] = [];

async function makeEnv(overrides: Partial<QaSuiteRuntimeEnv> = {}): Promise<QaSuiteRuntimeEnv> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-tool-fixture-"));
  tempRoots.push(workspaceDir);
  return {
    repoRoot: workspaceDir,
    providerMode: "mock-openai",
    primaryModel: "openai/gpt-5.6-luna",
    alternateModel: "openai/gpt-5.6-luna",
    mock: null,
    cfg: {},
    transport: {} as QaSuiteRuntimeEnv["transport"],
    gateway: {
      baseUrl: "http://127.0.0.1:1",
      tempRoot: workspaceDir,
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
  const sessionsDir = path.join(env.gateway.tempRoot, "state", "agents", "qa", "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  const sessionId = sessionKey.replace(/[^a-z0-9]+/giu, "-");
  const storePath = path.join(sessionsDir, "sessions.json");
  let store: Record<string, unknown> = {};
  try {
    store = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  store[sessionKey] = { sessionId, sessionFile: `${sessionId}.jsonl` };
  await fs.writeFile(storePath, JSON.stringify(store), "utf8");
  await fs.writeFile(
    path.join(sessionsDir, `${sessionId}.jsonl`),
    messages.map((message) => JSON.stringify({ message })).join("\n"),
    "utf8",
  );
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

async function runMockRuntimeToolFixtureWithOutputs(params: {
  toolName: string;
  happyArgs: Record<string, unknown>;
  failureArgs: Record<string, unknown>;
  happyOutput: string;
  failureOutput: string;
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
    .mockResolvedValueOnce([])
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
      runAgentPrompt: vi.fn(async () => ({})),
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
    const createdKeys: string[] = [];
    const promptKeys: string[] = [];
    const readEffectiveTools = vi.fn(async (_env, sessionKey: string) => {
      expect(sessionKey).toBe("agent:qa:runtime-tool:read:happy");
      return new Set(["read"]);
    });

    await runRuntimeToolFixture(
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

  it("allows async live runtime tool fixtures to prove the happy path with the planned call", async () => {
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

    const details = await runRuntimeToolFixture(
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
    );

    expect(details).toContain(
      "image_generate live provider happy direct output not required for this async fixture",
    );
    expect(details).toContain("image_generate live provider failure planned args");
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
        content: "README contents",
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

  it("does not fail Codex-native fixtures solely because OpenClaw dynamic exposure is absent", async () => {
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
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          allInputText: "target=read",
          plannedToolName: "read",
          plannedToolArgs: { path: "README.md" },
        },
      ]);

    const details = await runRuntimeToolFixture(
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
        runAgentPrompt: vi.fn(async () => ({})),
        fetchJson,
        ensureImageGenerationConfigured: vi.fn(),
      },
    );

    expect(details).toContain("codex-native-workspace read");
    expect(details).toContain("OpenClaw dynamic exposure is intentionally omitted");
    expect(details).toContain("mock provider happy planned args (diagnostic only)");
  });

  it("reports Codex-native async planned-only happy fixtures without dereferencing missing output", async () => {
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
      .mockResolvedValueOnce([])
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

    const details = await runRuntimeToolFixture(
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
    );

    expect(details).toContain("codex-native-workspace image_generate");
    expect(details).toContain('"prompt":"QA lighthouse runtime parity fixture"');
    expect(details).toContain('"__qaFailureMode":"denied-input"');
  });

  it("requires mock runtime tool fixtures to produce tool output", async () => {
    const env = await makeEnv({
      mock: { baseUrl: "http://127.0.0.1:9999" },
    });
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce([])
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

  it("allows async mock runtime tool fixtures to prove the happy path with the planned call", async () => {
    const env = await makeEnv({
      mock: { baseUrl: "http://127.0.0.1:9999" },
    });
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce([])
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

    const details = await runRuntimeToolFixture(
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
    );

    expect(details).toContain(
      "image_generate mock provider happy direct output not required for this async fixture",
    );
    expect(details).toContain('"prompt":"QA lighthouse runtime parity fixture"');
    expect(details).toContain('"__qaFailureMode":"denied-input"');
  });

  it("accepts mock runtime tool fixtures only after planned calls return output", async () => {
    const env = await makeEnv({
      mock: { baseUrl: "http://127.0.0.1:9999" },
    });
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce([])
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

  it("accepts non-required mock fixtures when both paths are planned without direct output", async () => {
    const env = await makeEnv({
      mock: { baseUrl: "http://127.0.0.1:9999" },
    });
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce([])
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

    const details = await runRuntimeToolFixture(
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
    );

    expect(details).toContain("image_generate mock provider report-only");
    expect(details).toContain("image_generate mock provider happy planned args");
    expect(details).toContain("image_generate mock provider failure planned args");
  });

  it("still rejects failed happy output for non-required mock fixtures", async () => {
    const env = await makeEnv({
      mock: { baseUrl: "http://127.0.0.1:9999" },
    });
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce([])
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
      .mockResolvedValueOnce([])
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
      .mockResolvedValueOnce([])
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
      .mockResolvedValueOnce([])
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
      .mockResolvedValueOnce([])
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
    ).rejects.toThrow("expected mock happy-path successful tool output for read");
  });

  it("requires mock failure fixtures to produce failure-shaped tool output", async () => {
    const env = await makeEnv({
      mock: { baseUrl: "http://127.0.0.1:9999" },
    });
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce([])
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
      .mockResolvedValueOnce([])
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
      .mockResolvedValueOnce([])
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
      .mockResolvedValueOnce([])
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
