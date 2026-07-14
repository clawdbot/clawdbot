// Verifies persisted tool results are redacted/capped and can be transformed by hooks.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { describe, expect, it, afterEach, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import { deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";

type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
type PersistedToolResultMessage = ToolResultMessage & { details: Record<string, unknown> };

const EMPTY_PLUGIN_SCHEMA = { type: "object", additionalProperties: false, properties: {} };
const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
let tempDirs: string[] = [];

function writeTempPlugin(params: { dir: string; id: string; body: string }): string {
  // Temp plugin manifests allow testing real hook loading without bundled plugins.
  const pluginDir = path.join(params.dir, params.id);
  fs.mkdirSync(pluginDir, { recursive: true });
  const file = path.join(pluginDir, `${params.id}.mjs`);
  fs.writeFileSync(file, params.body, "utf-8");
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: params.id,
        configSchema: EMPTY_PLUGIN_SCHEMA,
      },
      null,
      2,
    ),
    "utf-8",
  );
  return file;
}

function appendToolCallAndResult(sm: ReturnType<typeof SessionManager.inMemory>) {
  const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
  appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
  } as AgentMessage);

  appendMessage({
    role: "toolResult",
    toolCallId: "call_1",
    isError: false,
    content: [{ type: "text", text: "ok" }],
    details: { big: "x".repeat(10_000) },
  } as ToolResultMessage);
}

function appendToolResultWithTail(
  sm: ReturnType<typeof SessionManager.inMemory>,
  tail: string,
): void {
  const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
  appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
  } as AgentMessage);
  appendMessage({
    role: "toolResult",
    toolCallId: "call_1",
    isError: false,
    content: [{ type: "text", text: "visible output stays small" }],
    details: { status: "completed", tail },
  } as ToolResultMessage);
}

function getPersistedToolResult(sm: ReturnType<typeof SessionManager.inMemory>) {
  const messages = sm
    .getEntries()
    .filter((e) => e.type === "message")
    .map((e) => (e as { message: AgentMessage }).message);

  return messages.find((message): message is ToolResultMessage => message.role === "toolResult");
}

function hasRecordDetails(message: ToolResultMessage): message is PersistedToolResultMessage {
  return (
    typeof message.details === "object" &&
    message.details !== null &&
    !Array.isArray(message.details)
  );
}

function requirePersistedToolResultMessage(sm: ReturnType<typeof SessionManager.inMemory>) {
  const toolResult = getPersistedToolResult(sm);
  if (!toolResult) {
    throw new Error("expected persisted toolResult message");
  }
  return toolResult;
}

function requirePersistedToolResult(sm: ReturnType<typeof SessionManager.inMemory>) {
  const toolResult = requirePersistedToolResultMessage(sm);
  if (!hasRecordDetails(toolResult)) {
    throw new Error("expected persisted toolResult message with object details");
  }
  return toolResult;
}

function requireToolResultText(message: ToolResultMessage): string {
  const text = message.content.find((block) => block.type === "text")?.text;
  if (text === undefined) {
    throw new Error("expected persisted toolResult text content");
  }
  return text;
}

function initializeTempPlugin(params: { tmpPrefix: string; id: string; body: string }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), params.tmpPrefix));
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
  const plugin = writeTempPlugin({
    dir: tmp,
    id: params.id,
    body: params.body,
  });
  const registry = loadOpenClawPlugins({
    cache: false,
    workspaceDir: tmp,
    config: {
      plugins: {
        load: { paths: [plugin] },
        allow: [params.id],
      },
    },
  });
  initializeGlobalHookRunner(registry);
}

function expectPersistedToolResultTextCapped(sm: ReturnType<typeof SessionManager.inMemory>) {
  const toolResult = requirePersistedToolResult(sm);
  const text = requireToolResultText(toolResult);
  expect(text.length).toBeLessThanOrEqual(120);
  expect(text).toContain("truncated");
}

function expectPersistedToolResultDetailsCapped(sm: ReturnType<typeof SessionManager.inMemory>) {
  // Large details are summarized before persistence to keep transcript files bounded.
  const toolResult = requirePersistedToolResult(sm);
  const details = toolResult.details;
  expect(details.persistedDetailsTruncated).toBe(true);
  expect(details.aggregated).toBeUndefined();
  expect(Buffer.byteLength(JSON.stringify(details), "utf-8")).toBeLessThan(8_192);
}

afterEach(() => {
  resetGlobalHookRunner();
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
  if (originalConfigPath === undefined) {
    deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
  } else {
    setTestEnvValue("OPENCLAW_CONFIG_PATH", originalConfigPath);
  }
  for (const dir of tempDirs) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

describe("tool_result_persist hook", () => {
  it("does not modify persisted toolResult messages when no hook is registered", () => {
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });
    appendToolCallAndResult(sm);
    const toolResult = requirePersistedToolResult(sm);
    expect(toolResult.role).toBe("toolResult");
    expect(toolResult.details.persistedDetailsTruncated).toBe(true);
    expect(toolResult.details.originalDetailKeys).toEqual(["big"]);
    expect(typeof toolResult.details.originalDetailsBytesAtLeast).toBe("number");
    expect(toolResult.details.originalDetailsBytesAtLeast).toBeGreaterThan(8_192);
  });

  it("preserves result state values when capping oversized details", () => {
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "lookup", arguments: {} }],
    } as AgentMessage);
    appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      isError: false,
      content: [{ type: "text", text: "visible output stays small" }],
      details: {
        success: true,
        disabled: false,
        unavailable: false,
        error: null,
        payload: "x".repeat(10_000),
      },
    } as ToolResultMessage);

    const details = requirePersistedToolResult(sm).details;
    expect(details.persistedDetailsTruncated).toBe(true);
    expect(details.success).toBe(true);
    expect(details.disabled).toBe(false);
    expect(details.unavailable).toBe(false);
    expect(details.error).toBeUndefined();
  });

  it("redacts small toolResult details before persistence", () => {
    const tokenValue = "abcdefghijklmnopqrstuvwx1234567890";
    const bearerValue = "bearerdiagnosticvalue1234567890";
    const adjacentLongGithubToken = `ghp_${"a".repeat(5_000)}`;
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
    } as AgentMessage);
    appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      isError: false,
      content: [{ type: "text", text: "visible output stays small" }],
      details: {
        status: "completed",
        token: tokenValue,
        GITHUB_TOKEN: tokenValue,
        github_token: tokenValue,
        openai_api_key: tokenValue,
        card_number: 4242424242424242,
        cvc: 123,
        authToken: [tokenValue],
        aggregated: `GITHUB_TOKEN=${tokenValue}`,
        adjacentLongGithubToken: `${"x".repeat(1_000)}${adjacentLongGithubToken} z`,
        nested: {
          apiKey: { value: bearerValue },
          stdout: `Authorization: Bearer ${bearerValue}`,
          items: [`curl --token ${tokenValue} https://example.test`],
        },
      },
    } as ToolResultMessage);

    const toolResult = requirePersistedToolResult(sm);
    const serialized = JSON.stringify(toolResult.details);
    expect(requireToolResultText(toolResult)).toBe("visible output stays small");
    expect(serialized).toContain("GITHUB_TOKEN=");
    expect(serialized).toContain("Bearer");
    expect(serialized).toContain("…");
    expect(serialized).not.toContain(tokenValue);
    expect(serialized).not.toContain(bearerValue);
    expect(serialized).not.toContain(adjacentLongGithubToken);
    expect(serialized).not.toContain("a".repeat(100));
    expect(serialized).not.toContain("4242424242424242");
  });

  it("applies in-memory redaction config to persisted details", () => {
    const customSecret = "customsecret=abcdef1234567890ghij";
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
      config: {
        logging: {
          redactPatterns: [String.raw`customsecret=([^\s]+)`],
        },
      },
    });
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
    } as AgentMessage);
    appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      isError: false,
      content: [{ type: "text", text: customSecret }],
      details: {
        diagnostic: customSecret,
      },
    } as ToolResultMessage);

    const toolResult = requirePersistedToolResult(sm);
    const serialized = JSON.stringify(toolResult);
    expect(serialized).toContain("customsecret=abcdef…ghij");
    expect(serialized).not.toContain(customSecret);
  });

  it("keeps sensitive parent keys when custom value patterns match the key probe", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-redact-config-"));
    tempDirs.push(tempDir);
    const configPath = path.join(tempDir, "openclaw.json");
    setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
    fs.writeFileSync(
      configPath,
      JSON.stringify({ logging: { redactPatterns: ["/[a-z0-9]{30,}/g"] } }),
      "utf-8",
    );
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
    } as AgentMessage);
    appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      isError: false,
      content: [{ type: "text", text: "visible output stays small" }],
      details: {
        token: { value: "shortsecret" },
      },
    } as ToolResultMessage);

    const toolResult = requirePersistedToolResult(sm);
    const serialized = JSON.stringify(toolResult.details);
    expect(serialized).toContain("***");
    expect(serialized).not.toContain("shortsecret");
  });

  it("redacts secret-bearing keys and too-deep detail branches before persistence", () => {
    const tokenValue = "abcdefghijklmnopqrstuvwx1234567890";
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });
    let deepDetails: Record<string, unknown> = { token: tokenValue };
    for (let index = 0; index < 10; index += 1) {
      deepDetails = { child: deepDetails };
    }
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
    } as AgentMessage);
    appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      isError: false,
      content: [{ type: "text", text: "visible output stays small" }],
      details: {
        [`https://example.test/callback?token=${tokenValue}`]: "ok",
        deepDetails,
      },
    } as ToolResultMessage);

    const toolResult = requirePersistedToolResult(sm);
    const serialized = JSON.stringify(toolResult.details);
    expect(serialized).toContain("token=");
    expect(serialized).toContain("***");
    expect(serialized).toContain("max depth exceeded");
    expect(serialized).not.toContain(tokenValue);
  });

  it("caps oversized toolResult details before persistence", () => {
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
    } as AgentMessage);
    appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      isError: false,
      content: [{ type: "text", text: "visible output stays small" }],
      details: {
        status: "completed",
        sessionId: "exec-1",
        aggregated: "x".repeat(120_000),
        tail: "t".repeat(6_000),
        sessions: [
          {
            sessionId: "proc-1",
            status: "completed",
            command: "node noisy-script.js ".repeat(2_000),
            aggregated: "a".repeat(80_000),
            tail: "z".repeat(8_000),
          },
        ],
      },
    } as ToolResultMessage);

    const toolResult = requirePersistedToolResult(sm);
    expect(requireToolResultText(toolResult)).toBe("visible output stays small");
    expectPersistedToolResultDetailsCapped(sm);
  });

  const redactedScanBoundaryTail = () => {
    const placeholders = Array.from({ length: 5 }, () => `ghp_${"a".repeat(140)}`).join(" ");
    return `${placeholders}${"x".repeat(1_999 - placeholders.length)}😀${"z".repeat(9_000)}`;
  };

  it.each([
    {
      name: "retained-prefix surrogate boundary",
      tail: `${"a".repeat(1_487)}😀${"b".repeat(9_000)}`,
    },
    { name: "redaction-scan surrogate boundary", tail: redactedScanBoundaryTail() },
    { name: "ASCII negative control", tail: "a".repeat(10_000) },
  ])("keeps $name well formed", ({ tail }) => {
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });
    appendToolResultWithTail(sm, tail);

    const persistedTail = requirePersistedToolResult(sm).details.tail as string;
    expect(persistedTail).toContain("boundary overlap omitted");
    expect(persistedTail).not.toMatch(LONE_SURROGATE_RE);
  });

  it("redacts summarized oversized toolResult details before persistence", () => {
    const tokenValue = "abcdefghijklmnopqrstuvwx1234567890";
    const boundaryGhToken = `ghp_${"a".repeat(36)}`;
    const leadingTailToken = "a".repeat(5_000);
    const omittedTailToken = "b".repeat(5_000);
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
    } as AgentMessage);
    appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      isError: false,
      content: [{ type: "text", text: "visible output stays small" }],
      details: {
        status: { state: "completed", token: tokenValue },
        sessionId: "exec-1",
        [`https://example.test/callback?token=${tokenValue}`]: "ok",
        aggregated: "x".repeat(120_000),
        tail: `GITHUB_TOKEN=${tokenValue} ${"x".repeat(
          1_940,
        )} ${boundaryGhToken} GITHUB_TOKEN=${leadingTailToken} {"token":"${omittedTailToken}"}`,
        sessions: [
          {
            sessionId: "proc-1",
            status: { state: "completed", token: tokenValue },
            command: `${"x".repeat(490)} --token ${tokenValue} ${"y".repeat(6_000)}`,
            aggregated: "a".repeat(80_000),
            tail: "z".repeat(8_000),
          },
        ],
      },
    } as ToolResultMessage);

    const toolResult = requirePersistedToolResult(sm);
    const serialized = JSON.stringify(toolResult.details);
    expect(requireToolResultText(toolResult)).toBe("visible output stays small");
    expect(toolResult.details.persistedDetailsTruncated).toBe(true);
    expect(serialized).toContain("token=***");
    expect(serialized).toContain("partial secret span omitted");
    expect(serialized).toContain("boundary overlap omitted");
    expect(serialized).not.toContain(tokenValue);
    expect(serialized).not.toContain(boundaryGhToken.slice(0, 12));
    expect(serialized).not.toContain("a".repeat(100));
    expect(serialized).not.toContain("b".repeat(100));
  });

  it("redacts retained structured fields in fallback oversized details summaries", () => {
    const tokenValue = "fallback-token-abcdefghijklmnopqrstuv";
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
    } as AgentMessage);
    appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      isError: false,
      content: [{ type: "text", text: "visible output stays small" }],
      details: {
        status: { state: "completed", token: tokenValue },
        sessionId: "exec-1",
        cwd: "/tmp/".concat("workspace/".repeat(400)),
        name: "oversized fallback command ".repeat(200),
        fullOutputPath: "/tmp/".concat("output/".repeat(400)),
        spilledChars: 2_000_000,
        spillTruncated: true,
        aggregated: "x".repeat(120_000),
        tail: "tail ".repeat(800),
        sessions: Array.from({ length: 10 }, (_, i) => ({
          sessionId: `proc-${i}`,
          status: "completed",
          command: `node script-${i}.js ${"x".repeat(6_000)}`,
        })),
      },
    } as ToolResultMessage);

    const toolResult = requirePersistedToolResult(sm);
    const details = toolResult.details;
    const serialized = JSON.stringify(details);
    expect(details.persistedDetailsTruncated).toBe(true);
    expect(details.finalDetailsTruncated).toBe(true);
    expect(details.status).toMatchObject({ token: "***" });
    expect(details.spilledChars).toBe(2_000_000);
    expect(details.spillTruncated).toBe(true);
    expect(serialized).not.toContain(tokenValue);
  });

  it("does not persist lookahead text after redaction shrinks an oversized detail prefix", () => {
    const tokenValue = "abcdefghijklmnopqrstuvwx1234567890";
    const postBoundarySecret = "UNREDACTED_AFTER_LIMIT_SECRET";
    const shrinkPrefix = `${Array.from({ length: 20 }, () => `GITHUB_TOKEN=${tokenValue}`).join(
      " ",
    )} `;
    const tail = `${shrinkPrefix}${"x".repeat(
      2_300 - shrinkPrefix.length,
    )}${postBoundarySecret}${"z".repeat(5_000)}`;
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
    } as AgentMessage);
    appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      isError: false,
      content: [{ type: "text", text: "visible output stays small" }],
      details: {
        status: "completed",
        aggregated: "x".repeat(120_000),
        tail,
      },
    } as ToolResultMessage);

    const toolResult = requirePersistedToolResult(sm);
    const serialized = JSON.stringify(toolResult.details);
    expect(toolResult.details.persistedDetailsTruncated).toBe(true);
    expect(serialized).toContain("partial secret span omitted");
    expect(serialized).not.toContain(tokenValue);
    expect(serialized).not.toContain(postBoundarySecret);
  });

  it("fails closed for partially scanned oversized structured secret values", () => {
    const longSecret = "r".repeat(10_000);
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
    } as AgentMessage);
    appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      isError: false,
      content: [{ type: "text", text: "visible output stays small" }],
      details: {
        status: "completed",
        tail: `${"x".repeat(1_000)}{"token":"${longSecret}${"z".repeat(1_000)}`,
      },
    } as ToolResultMessage);

    const toolResult = requirePersistedToolResult(sm);
    const serialized = JSON.stringify(toolResult.details);
    expect(serialized).toContain("partial secret span omitted");
    expect(serialized).not.toContain("r".repeat(100));
  });

  it("caps oversized toolResult details without serializing the original payload", () => {
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    const oversizedDetails = {
      status: "completed",
      sessionId: "exec-large",
      aggregated: "x".repeat(200_000),
      sessions: [
        {
          sessionId: "proc-large",
          command: "node noisy-script.js ".repeat(2_000),
          tail: "z".repeat(20_000),
        },
      ],
    };
    const originalStringify = JSON.stringify;
    const stringifySpy = vi.spyOn(JSON, "stringify").mockImplementation((value, ...args) => {
      if (value === oversizedDetails) {
        throw new Error("unbounded original details stringify");
      }
      return originalStringify(value, ...args);
    });

    try {
      appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
      } as AgentMessage);
      appendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        isError: false,
        content: [{ type: "text", text: "visible output stays small" }],
        details: oversizedDetails,
      } as ToolResultMessage);
    } finally {
      stringifySpy.mockRestore();
    }

    const toolResult = requirePersistedToolResult(sm);
    expect(requireToolResultText(toolResult)).toBe("visible output stays small");
    expectPersistedToolResultDetailsCapped(sm);
    expect(stringifySpy).not.toHaveBeenCalledWith(oversizedDetails);
  });

  it("caps wide toolResult details without materializing every entry up front", () => {
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    const wideDetails: Record<string, unknown> = {
      status: "completed",
      sessionId: "exec-wide",
    };
    for (let index = 0; index < 20_000; index += 1) {
      wideDetails[`debug_${index}`] = `value-${index}`;
    }
    const originalEntries = Object.entries;
    const originalKeys = Object.keys;
    const entriesSpy = vi.spyOn(Object, "entries").mockImplementation((value) => {
      if (value === wideDetails) {
        throw new Error("wide details entries materialized");
      }
      return originalEntries(value);
    });
    const keysSpy = vi.spyOn(Object, "keys").mockImplementation((value) => {
      if (value === wideDetails) {
        throw new Error("wide details keys materialized");
      }
      return originalKeys(value);
    });

    try {
      appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
      } as AgentMessage);
      appendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        isError: false,
        content: [{ type: "text", text: "visible output stays small" }],
        details: wideDetails,
      } as ToolResultMessage);
    } finally {
      entriesSpy.mockRestore();
      keysSpy.mockRestore();
    }

    const toolResult = requirePersistedToolResult(sm);
    const details = toolResult.details;
    expect(details.persistedDetailsTruncated).toBe(true);
    expect(details.originalDetailKeys).toContain("status");
    expect(details.originalDetailKeys).toContain("sessionId");
    expect(details.originalDetailKeys).toContain("debug_0");
  });

  it("falls back to a compact summary when sanitized details still exceed the cap", () => {
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
    } as AgentMessage);
    appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      isError: false,
      content: [{ type: "text", text: "visible output stays small" }],
      details: {
        status: "completed".repeat(250),
        sessionId: "exec-oversized",
        success: false,
        error: "upstream unavailable",
        cwd: "/tmp/very-long-working-directory".repeat(250),
        name: "noisy process".repeat(250),
        fullOutputPath: "/tmp/output.log".repeat(250),
        truncation: "truncated".repeat(250),
        tail: "t".repeat(20_000),
        aggregated: "a".repeat(120_000),
        sessions: Array.from({ length: 10 }, (_, index) => ({
          sessionId: `proc-${index}`,
          status: "completed".repeat(100),
          cwd: "/tmp/session".repeat(100),
          name: "child process".repeat(100),
          command: "node noisy-script.js ".repeat(200),
          aggregated: "x".repeat(50_000),
          tail: "z".repeat(10_000),
        })),
      },
    } as ToolResultMessage);

    const toolResult = requirePersistedToolResult(sm);
    const details = toolResult.details;
    expect(details.persistedDetailsTruncated).toBe(true);
    expect(details.finalDetailsTruncated).toBe(true);
    expect(details.aggregated).toBeUndefined();
    expect(details.tail).toBeUndefined();
    expect(details.success).toBe(false);
    expect(details.error).toBe("upstream unavailable");
    expect(Buffer.byteLength(JSON.stringify(details), "utf-8")).toBeLessThan(8_192);
  });

  it("loads tool_result_persist hooks without breaking persistence", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-toolpersist-"));
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";

    const pluginA = writeTempPlugin({
      dir: tmp,
      id: "persist-a",
      body: `export default { id: "persist-a", register(api) {
  api.on("tool_result_persist", (event, ctx) => {
    const msg = event.message;
    // Example: remove large diagnostic payloads before persistence.
    const { details: _details, ...rest } = msg;
    return { message: { ...rest, persistOrder: ["a"], agentSeen: ctx.agentId ?? null } };
  }, { priority: 10 });
} };`,
    });

    const pluginB = writeTempPlugin({
      dir: tmp,
      id: "persist-b",
      body: `export default { id: "persist-b", register(api) {
  api.on("tool_result_persist", (event) => {
    const prior = (event.message && event.message.persistOrder) ? event.message.persistOrder : [];
    return { message: { ...event.message, persistOrder: [...prior, "b"] } };
  }, { priority: 5 });
} };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: tmp,
      config: {
        plugins: {
          load: { paths: [pluginA, pluginB] },
          allow: ["persist-a", "persist-b"],
        },
      },
    });
    initializeGlobalHookRunner(registry);

    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });

    appendToolCallAndResult(sm);
    const toolResult = requirePersistedToolResultMessage(sm);

    // Hook registration should preserve a valid toolResult message shape.
    expect(toolResult.role).toBe("toolResult");
    expect(toolResult.toolCallId).toBe("call_1");
    expect(Array.isArray(toolResult.content)).toBe(true);
  });

  it("reapplies the cap after tool_result_persist expands a tool result", () => {
    initializeTempPlugin({
      tmpPrefix: "openclaw-toolpersist-expand-",
      id: "persist-expand",
      body: `export default { id: "persist-expand", register(api) {
  api.on("tool_result_persist", (event) => {
    return {
      message: {
        ...event.message,
        content: [{ type: "text", text: "y".repeat(5000) }],
      },
    };
	  }, { priority: 10 });
	} };`,
    });

    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
      contextWindowTokens: 100,
    });

    appendToolCallAndResult(sm);
    expectPersistedToolResultTextCapped(sm);
  });

  it("reapplies the details cap after tool_result_persist expands details", () => {
    initializeTempPlugin({
      tmpPrefix: "openclaw-toolpersist-details-expand-",
      id: "persist-details-expand",
      body: `export default { id: "persist-details-expand", register(api) {
  api.on("tool_result_persist", (event) => {
    return {
      message: {
        ...event.message,
        details: {
          status: "completed",
          aggregated: "x".repeat(150000),
          sessions: [{ sessionId: "proc-1", command: "y".repeat(50000), tail: "z".repeat(10000) }],
        },
      },
    };
  }, { priority: 10 });
} };`,
    });

    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });

    appendToolCallAndResult(sm);
    expectPersistedToolResultDetailsCapped(sm);
  });

  it("reapplies the details cap after redaction expands hook details", () => {
    const deepItems = Array.from({ length: 2_000 }, () => ({}));
    const hookDetails = { a: { b: { c: { d: { e: { f: { g: deepItems } } } } } } };
    initializeTempPlugin({
      tmpPrefix: "openclaw-toolpersist-details-redaction-expand-",
      id: "persist-details-redaction-expand",
      body: `export default { id: "persist-details-redaction-expand", register(api) {
  api.on("tool_result_persist", (event) => {
    return { message: { ...event.message, details: ${JSON.stringify(hookDetails)} } };
  }, { priority: 10 });
} };`,
    });

    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });

    appendToolCallAndResult(sm);
    expectPersistedToolResultDetailsCapped(sm);
  });
});

describe("before_message_write hook", () => {
  it("continues persistence when a before_message_write hook throws", () => {
    initializeTempPlugin({
      tmpPrefix: "openclaw-before-write-",
      id: "before-write-throws",
      body: `export default { id: "before-write-throws", register(api) {
  api.on("before_message_write", () => {
    throw new Error("boom");
	  }, { priority: 10 });
	} };`,
    });

    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    appendMessage({
      role: "user",
      content: "hello",
      timestamp: Date.now(),
    } as AgentMessage);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
  });

  it("reapplies the cap after before_message_write expands a tool result", () => {
    initializeTempPlugin({
      tmpPrefix: "openclaw-before-write-expand-",
      id: "before-write-expand",
      body: `export default { id: "before-write-expand", register(api) {
  api.on("before_message_write", (event) => {
    if (event.message?.role !== "toolResult") return;
    return {
      message: {
        ...event.message,
        content: [{ type: "text", text: "z".repeat(5000) }],
      },
    };
	  }, { priority: 10 });
	} };`,
    });

    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
      contextWindowTokens: 100,
    });

    appendToolCallAndResult(sm);
    expectPersistedToolResultTextCapped(sm);
  });
});
