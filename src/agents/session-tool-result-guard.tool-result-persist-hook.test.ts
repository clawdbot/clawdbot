import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, afterEach, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";

const EMPTY_PLUGIN_SCHEMA = { type: "object", additionalProperties: false, properties: {} };
const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

function writeTempPlugin(params: { dir: string; id: string; body: string }): string {
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
  } as any);
}

function getPersistedToolResult(sm: ReturnType<typeof SessionManager.inMemory>) {
  const messages = sm
    .getEntries()
    .filter((e) => e.type === "message")
    .map((e) => (e as { message: AgentMessage }).message);

  return messages.find((m) => (m as any).role === "toolResult") as any;
}

function requirePersistedToolResult(sm: ReturnType<typeof SessionManager.inMemory>) {
  const toolResult = getPersistedToolResult(sm);
  if (!toolResult) {
    throw new Error("expected persisted toolResult message");
  }
  return toolResult;
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
  const text = toolResult.content.find((block: { type: string }) => block.type === "text")?.text;
  expect(typeof text).toBe("string");
  expect(text.length).toBeLessThanOrEqual(120);
  expect(text).toContain("truncated");
}

function expectPersistedToolResultDetailsCapped(sm: ReturnType<typeof SessionManager.inMemory>) {
  const toolResult = requirePersistedToolResult(sm);
  const details = toolResult.details as Record<string, unknown>;
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
    } as any);

    const toolResult = getPersistedToolResult(sm);
    expect(toolResult.content[0]?.text).toBe("visible output stays small");
    expectPersistedToolResultDetailsCapped(sm);
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
      } as any);
    } finally {
      stringifySpy.mockRestore();
    }

    const toolResult = getPersistedToolResult(sm);
    expect(toolResult.content[0]?.text).toBe("visible output stays small");
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
      } as any);
    } finally {
      entriesSpy.mockRestore();
      keysSpy.mockRestore();
    }

    const toolResult = getPersistedToolResult(sm);
    const details = toolResult.details as Record<string, unknown>;
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
    } as any);

    const toolResult = getPersistedToolResult(sm);
    const details = toolResult.details as Record<string, unknown>;
    expect(details.persistedDetailsTruncated).toBe(true);
    expect(details.finalDetailsTruncated).toBe(true);
    expect(details.aggregated).toBeUndefined();
    expect(details.tail).toBeUndefined();
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
    const toolResult = requirePersistedToolResult(sm);

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
