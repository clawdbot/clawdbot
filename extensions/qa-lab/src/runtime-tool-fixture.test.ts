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
    primaryModel: "openai/gpt-5.5",
    alternateModel: "openai/gpt-5.5",
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
