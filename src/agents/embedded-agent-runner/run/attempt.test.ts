// Broad helper coverage for runEmbeddedAttempt prompt, stream, and tool seams.
import { describe, expect, it, vi } from "vitest";
import { streamSimple } from "../../../llm/stream.js";

vi.mock("../context-engine-capabilities.js", () => ({
  resolveContextEngineCapabilities: async () => ({ llm: undefined }),
}));
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import type { OpenClawConfig } from "../../../config/config.js";
import { addSession } from "../../bash-process-registry.js";
import { createProcessSessionFixture } from "../../bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "../../bash-process-registry.test-support.js";
import { wrapPluginSystemContextSection } from "../../hook-system-context-boundary.js";
import { buildAgentSystemPrompt } from "../../system-prompt.js";
import type { NormalizedUsage } from "../../usage.js";
import {
  resolveEmbeddedAgentBaseStreamFn,
  resolveEmbeddedAgentStreamFn,
} from "../stream-resolution.js";
import { buildContextEnginePromptCacheInfo } from "./attempt.context-engine-helpers.js";
import {
  buildAfterTurnRuntimeContext,
  buildAfterTurnRuntimeContextFromUsage,
  mergeOrphanedTrailingUserPrompt,
  prependSystemPromptAddition,
  resolveAttemptFsWorkspaceOnly,
  resolvePromptBuildHookResult,
  resolvePromptModeForSession,
  shouldWarnOnOrphanedUserRepair,
} from "./attempt.prompt-helpers.js";
import { composeSystemPromptWithHookContext } from "./attempt.thread-helpers.js";
import { wrapStreamFnRepairMalformedToolCallArguments } from "./attempt.tool-call-argument-repair.js";
import {
  wrapStreamFnSanitizeMalformedToolCalls,
  wrapStreamFnTrimToolCallNames,
} from "./attempt.tool-call-normalization.js";
import { buildEmbeddedAttemptToolRunContext } from "./attempt.tool-run-context.js";

type FakeWrappedStream = {
  result: () => Promise<unknown>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
};

function createFakeStream(params: {
  events: unknown[];
  resultMessage: unknown;
}): FakeWrappedStream {
  // Minimal stream compatible with wrappers that decorate result and iteration
  // without needing a real provider stream.
  return {
    async result() {
      return params.resultMessage;
    },
    [Symbol.asyncIterator]() {
      return (async function* () {
        for (const event of params.events) {
          yield event;
        }
      })();
    },
  };
}

async function invokeWrappedTestStream(
  wrap: (
    baseFn: (...args: never[]) => unknown,
  ) => (...args: never[]) => FakeWrappedStream | Promise<FakeWrappedStream>,
  baseFn: (...args: never[]) => unknown,
): Promise<FakeWrappedStream> {
  // Helper keeps wrapper tests focused on mutated stream behavior.
  const wrappedFn = wrap(baseFn);
  return await Promise.resolve(wrappedFn({} as never, {} as never, {} as never));
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireContentItem(content: unknown[], index = 0) {
  return requireRecord(content[index], `content item ${index}`);
}

function wrappedPluginSystemContext(text: string): string {
  return wrapPluginSystemContextSection(text) ?? "";
}

function expectSingleTextContent(content: unknown[], textFragment: string) {
  expect(content).toHaveLength(1);
  const item = requireContentItem(content);
  expect(item.type).toBe("text");
  expect(item.text).toContain(textFragment);
}

function expectSingleToolCallContent(content: unknown[], name: string) {
  expect(content).toHaveLength(1);
  const item = requireContentItem(content);
  expect(item.type).toBe("toolCall");
  expect(item.name).toBe(name);
}

function firstBaseContext(baseFn: ReturnType<typeof vi.fn>): { messages: unknown[] } {
  // Wrapper tests assert the context passed to the underlying stream function.
  const call = baseFn.mock.calls.at(0);
  if (!call) {
    throw new Error("expected base stream call");
  }
  return call[1] as { messages: unknown[] };
}

describe("buildEmbeddedAttemptToolRunContext", () => {
  it("carries runtime toolsAllow into coding tool construction", () => {
    const context = buildEmbeddedAttemptToolRunContext({
      trigger: "manual",
      jobId: "job-1",
      memoryFlushWritePath: "memory/log.md",
      toolsAllow: ["memory_search", "memory_get"],
    });
    expect(context.trigger).toBe("manual");
    expect(context.jobId).toBe("job-1");
    expect(context.memoryFlushWritePath).toBe("memory/log.md");
    expect(context.runtimeToolAllowlist).toEqual(["memory_search", "memory_get"]);
  });
});

describe("resolvePromptBuildHookResult", () => {
  function createBeforeAgentStartOnlyHookRunner() {
    return {
      hasHooks: vi.fn(
        (
          hookName:
            | "agent_turn_prepare"
            | "heartbeat_prompt_contribution"
            | "before_prompt_build"
            | "before_agent_start",
        ) => hookName === "before_agent_start",
      ),
      runBeforePromptBuild: vi.fn(async () => undefined),
      runBeforeAgentStart: vi.fn(async () => ({ prependContext: "from-hook" })),
    };
  }

  it("reuses precomputed before_agent_start result without invoking hook again", async () => {
    const hookRunner = createBeforeAgentStartOnlyHookRunner();
    const result = await resolvePromptBuildHookResult({
      config: {},
      prompt: "hello",
      messages: [],
      hookCtx: {},
      hookRunner,
      beforeAgentStartResult: { prependContext: "from-cache", systemPrompt: "agent-start-system" },
    });

    expect(hookRunner.runBeforeAgentStart).not.toHaveBeenCalled();
    expect(result).toEqual({
      prependContext: "from-cache",
      appendContext: undefined,
      systemPrompt: "agent-start-system",
      prependSystemContext: undefined,
      appendSystemContext: undefined,
    });
  });

  it("calls before_agent_start hook when precomputed result is absent", async () => {
    const hookRunner = createBeforeAgentStartOnlyHookRunner();
    const messages = [{ role: "user", content: "ctx" }];
    const result = await resolvePromptBuildHookResult({
      config: {},
      prompt: "hello",
      messages,
      hookCtx: {},
      hookRunner,
    });

    expect(hookRunner.runBeforeAgentStart).toHaveBeenCalledTimes(1);
    expect(hookRunner.runBeforeAgentStart).toHaveBeenCalledWith({ prompt: "hello", messages }, {});
    expect(result.prependContext).toBe("from-hook");
  });

  it("merges prompt-build and before_agent_start context fields in deterministic order", async () => {
    // Prompt-build hook context comes before before_agent_start context so plugin
    // injections are replayed in stable order.
    const hookRunner = {
      hasHooks: vi.fn(() => true),
      runBeforePromptBuild: vi.fn(async () => ({
        prependContext: "prompt context",
        appendContext: "prompt append context",
        prependSystemContext: "prompt prepend",
        appendSystemContext: "prompt append",
      })),
      runBeforeAgentStart: vi.fn(async () => ({
        prependContext: "agent start context",
        appendContext: "agent start append context",
        prependSystemContext: "agent start prepend",
        appendSystemContext: "agent start append",
      })),
    };

    const result = await resolvePromptBuildHookResult({
      config: {},
      prompt: "hello",
      messages: [],
      hookCtx: {},
      hookRunner,
    });

    expect(result.prependContext).toBe("prompt context\n\nagent start context");
    expect(result.appendContext).toBe("prompt append context\n\nagent start append context");
    expect(result.prependSystemContext).toBe(
      `${wrappedPluginSystemContext("prompt prepend")}\n\n${wrappedPluginSystemContext("agent start prepend")}`,
    );
    expect(result.appendSystemContext).toBe(
      `${wrappedPluginSystemContext("prompt append")}\n\n${wrappedPluginSystemContext("agent start append")}`,
    );
  });

  it("applies heartbeat prompt contributions only during heartbeat turns", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "heartbeat_prompt_contribution"),
      runHeartbeatPromptContribution: vi.fn(async () => ({
        prependContext: "heartbeat prepend",
        appendContext: "heartbeat append",
      })),
      runBeforePromptBuild: vi.fn(async () => undefined),
      runBeforeAgentStart: vi.fn(async () => undefined),
    };

    const heartbeatResult = await resolvePromptBuildHookResult({
      config: {},
      prompt: "hello",
      messages: [],
      hookCtx: { trigger: "heartbeat", sessionKey: "agent:main:main" },
      hookRunner,
    });

    expect(hookRunner.runHeartbeatPromptContribution).toHaveBeenCalledTimes(1);
    expect(heartbeatResult.prependContext).toBe("heartbeat prepend");
    expect(heartbeatResult.appendContext).toBe("heartbeat append");

    hookRunner.runHeartbeatPromptContribution.mockClear();
    const userResult = await resolvePromptBuildHookResult({
      config: {},
      prompt: "hello",
      messages: [],
      hookCtx: { trigger: "user", sessionKey: "agent:main:main" },
      hookRunner,
    });

    expect(hookRunner.runHeartbeatPromptContribution).not.toHaveBeenCalled();
    expect(userResult.prependContext).toBeUndefined();
    expect(userResult.appendContext).toBeUndefined();
  });
});

describe("composeSystemPromptWithHookContext", () => {
  it("returns undefined when no hook system context is provided", () => {
    expect(composeSystemPromptWithHookContext({ baseSystemPrompt: "base" })).toBeUndefined();
  });

  it("builds prepend/base/append system prompt order", () => {
    expect(
      composeSystemPromptWithHookContext({
        baseSystemPrompt: "  base system  ",
        prependSystemContext: wrappedPluginSystemContext("  prepend  "),
        appendSystemContext: wrappedPluginSystemContext("  append  "),
      }),
    ).toBe(
      `${wrappedPluginSystemContext("  prepend")}\n\nbase system\n\n${wrappedPluginSystemContext("  append")}`,
    );
  });

  it("normalizes hook system context block line endings and trailing whitespace", () => {
    expect(
      composeSystemPromptWithHookContext({
        baseSystemPrompt: "  base system  ",
        prependSystemContext: wrappedPluginSystemContext("  prepend line  \r\nsecond line\t\r\n"),
        appendSystemContext: wrappedPluginSystemContext("  append  \t\r\n"),
      }),
    ).toBe(
      `${wrappedPluginSystemContext("  prepend line\nsecond line")}\n\nbase system\n\n${wrappedPluginSystemContext("  append")}`,
    );
  });

  it("avoids blank separators when base system prompt is empty", () => {
    expect(
      composeSystemPromptWithHookContext({
        baseSystemPrompt: "   ",
        appendSystemContext: wrappedPluginSystemContext("  append only  "),
      }),
    ).toBe(wrappedPluginSystemContext("  append only"));
  });

  it("keeps bootstrap truncation notices in the system prompt instead of the user prompt", () => {
    const baseSystemPrompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      contextFiles: [{ path: "AGENTS.md", content: "Follow AGENTS guidance." }],
      toolNames: ["read"],
      bootstrapTruncationNotice:
        "[Bootstrap truncation warning]\nSome workspace bootstrap files were truncated before Project Context injection.\nTreat Project Context as partial and read the relevant files directly if details seem missing.",
    });
    const composedSystemPrompt = composeSystemPromptWithHookContext({
      baseSystemPrompt,
      appendSystemContext: "hook system context",
    });

    expect(composedSystemPrompt).toContain("[Bootstrap truncation warning]");
    expect(composedSystemPrompt).toContain("Treat Project Context as partial");
    expect(composedSystemPrompt).toContain("hook system context");
    expect("hello").not.toContain("[Bootstrap truncation warning]");
  });
});

describe("resolvePromptModeForSession", () => {
  it("uses minimal mode for subagent sessions", () => {
    expect(resolvePromptModeForSession("agent:main:subagent:child")).toBe("minimal");
  });

  it("uses minimal mode for cron sessions", () => {
    expect(resolvePromptModeForSession("agent:main:cron:job-1")).toBe("minimal");
    expect(resolvePromptModeForSession("agent:main:cron:job-1:run:run-abc")).toBe("minimal");
  });

  it("uses full mode for regular and undefined sessions", () => {
    expect(resolvePromptModeForSession(undefined)).toBe("full");
    expect(resolvePromptModeForSession("agent:main")).toBe("full");
    expect(resolvePromptModeForSession("agent:main:thread:abc")).toBe("full");
  });
});

describe("shouldWarnOnOrphanedUserRepair", () => {
  it("warns for user and manual runs", () => {
    expect(shouldWarnOnOrphanedUserRepair("user")).toBe(true);
    expect(shouldWarnOnOrphanedUserRepair("manual")).toBe(true);
  });

  it("does not warn for background triggers", () => {
    expect(shouldWarnOnOrphanedUserRepair("heartbeat")).toBe(false);
    expect(shouldWarnOnOrphanedUserRepair("cron")).toBe(false);
    expect(shouldWarnOnOrphanedUserRepair("memory")).toBe(false);
    expect(shouldWarnOnOrphanedUserRepair("overflow")).toBe(false);
  });
});

describe("mergeOrphanedTrailingUserPrompt", () => {
  it("merges an orphaned user leaf into the next user-triggered prompt when missing", () => {
    expect(
      mergeOrphanedTrailingUserPrompt({
        prompt: "newest inbound message",
        trigger: "user",
        leafMessage: {
          content: [{ type: "text", text: "older active-turn message" }],
        } as never,
      }),
    ).toEqual({
      merged: true,
      removeLeaf: true,
      prompt:
        "[Queued user message from a previous active turn; preserved as context only. Continue with the active prompt below.]\n" +
        "older active-turn message\n\nnewest inbound message",
    });
  });

  it("drops stale internal orphan context when a fresh prompt is present", () => {
    expect(
      mergeOrphanedTrailingUserPrompt({
        prompt: "newest inbound message",
        trigger: "user",
        leafMessage: {
          content: "NO_REPLY stale subagent completion",
          provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
        },
      }),
    ).toEqual({
      merged: false,
      removeLeaf: true,
      prompt: "newest inbound message",
    });
  });

  it("preserves user-directed inter-session orphan context", () => {
    expect(
      mergeOrphanedTrailingUserPrompt({
        prompt: "newest inbound message",
        trigger: "user",
        leafMessage: {
          content: "forwarded user request",
          provenance: { kind: "inter_session", sourceTool: "sessions_send" },
        },
      }),
    ).toEqual({
      merged: true,
      removeLeaf: true,
      prompt:
        "[Queued user message from a previous active turn; preserved as context only. Continue with the active prompt below.]\n" +
        "forwarded user request\n\nnewest inbound message",
    });
  });

  it("does not duplicate orphaned user text already present in the next prompt", () => {
    expect(
      mergeOrphanedTrailingUserPrompt({
        prompt: "summary\nolder active-turn message\nnewest inbound message",
        trigger: "user",
        leafMessage: {
          content: "older active-turn message",
        } as never,
      }),
    ).toEqual({
      merged: false,
      removeLeaf: true,
      prompt: "summary\nolder active-turn message\nnewest inbound message",
    });
  });

  it("does not treat short orphan text as duplicate from a substring match", () => {
    expect(
      mergeOrphanedTrailingUserPrompt({
        prompt: "please inspect this token",
        trigger: "user",
        leafMessage: {
          content: "ok",
        } as never,
      }),
    ).toEqual({
      merged: true,
      removeLeaf: true,
      prompt:
        "[Queued user message from a previous active turn; preserved as context only. Continue with the active prompt below.]\n" +
        "ok\n\nplease inspect this token",
    });
  });

  it("preserves structured orphaned user content before removing the leaf", () => {
    expect(
      mergeOrphanedTrailingUserPrompt({
        prompt: "newest inbound message",
        trigger: "user",
        leafMessage: {
          content: [
            { type: "text", text: "please inspect this" },
            { type: "image_url", image_url: { url: "https://example.test/cat.png" } },
            { type: "input_audio", audio_url: "https://example.test/cat.wav" },
          ],
        } as never,
      }),
    ).toEqual({
      merged: true,
      removeLeaf: true,
      prompt:
        "[Queued user message from a previous active turn; preserved as context only. Continue with the active prompt below.]\n" +
        "please inspect this\n" +
        "[image_url] https://example.test/cat.png\n" +
        "[input_audio] https://example.test/cat.wav\n\n" +
        "newest inbound message",
    });
  });

  it("summarizes inline structured media without embedding data URIs", () => {
    const dataUri = `data:image/png;base64,${"a".repeat(4096)}`;

    const result = mergeOrphanedTrailingUserPrompt({
      prompt: "newest inbound message",
      trigger: "user",
      leafMessage: {
        content: [
          { type: "text", text: "please inspect this inline image" },
          { type: "image_url", image_url: { url: dataUri } },
        ],
      } as never,
    });

    expect(result.merged).toBe(true);
    expect(result.removeLeaf).toBe(true);
    expect(result.prompt).toContain("please inspect this inline image");
    expect(result.prompt).toContain("[image_url] inline data URI (image/png, 4118 chars)");
    expect(result.prompt).not.toContain("base64");
    expect(result.prompt).not.toContain("aaaa");
  });

  it("summarizes unknown structured data before JSON serialization", () => {
    const dataUri = `data:image/png;base64,${"a".repeat(10_000)}`;
    const result = mergeOrphanedTrailingUserPrompt({
      prompt: "newest inbound message",
      trigger: "user",
      leafMessage: {
        content: [
          {
            type: "unknown_content",
            nested: {
              inline: dataUri,
              longText: "b".repeat(2_000),
            },
          },
        ],
      } as never,
    });

    expect(result.merged).toBe(true);
    expect(result.removeLeaf).toBe(true);
    expect(result.prompt).toContain("[value] inline data URI (image/png, 10022 chars)");
    expect(result.prompt).toContain("bbbb");
    expect(result.prompt).toContain("(2000 chars)");
    expect(result.prompt).not.toContain("base64");
    expect(result.prompt).not.toContain("aaaa");
  });

  it("removes an empty orphaned user leaf to prevent consecutive user turns", () => {
    expect(
      mergeOrphanedTrailingUserPrompt({
        prompt: "newest inbound message",
        trigger: "user",
        leafMessage: {
          content: [],
        } as never,
      }),
    ).toEqual({
      merged: false,
      removeLeaf: true,
      prompt: "newest inbound message",
    });
  });

  it("merges orphan prompt text for non-user triggers without warning policy changes", () => {
    expect(
      mergeOrphanedTrailingUserPrompt({
        prompt: "HEARTBEAT_OK",
        trigger: "heartbeat",
        leafMessage: {
          content: "older active-turn message",
        } as never,
      }),
    ).toEqual({
      merged: true,
      removeLeaf: true,
      prompt:
        "[Queued user message from a previous active turn; preserved as context only. Continue with the active prompt below.]\n" +
        "older active-turn message\n\nHEARTBEAT_OK",
    });
  });
});

describe("resolveEmbeddedAgentStreamFn", () => {
  it("reuses the session's original base stream across later wrapper mutations", () => {
    const baseStreamFn = vi.fn();
    const wrapperStreamFn = vi.fn();
    const session = {
      agent: {
        streamFn: baseStreamFn,
      },
    };

    expect(resolveEmbeddedAgentBaseStreamFn({ session })).toBe(baseStreamFn);
    session.agent.streamFn = wrapperStreamFn;
    expect(resolveEmbeddedAgentBaseStreamFn({ session })).toBe(baseStreamFn);
  });

  it("injects authStorage api keys into provider-owned stream functions", async () => {
    const providerStreamFn = vi.fn(async (_model, _context, options) => options);
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      providerStreamFn,
      sessionId: "session-1",
      model: {
        api: "openai-completions",
        provider: "demo-provider",
        id: "demo-model",
      } as never,
      authProfileId: "demo-provider:oauth",
      authStorage: {
        getApiKey: vi.fn(async () => "demo-runtime-key"),
      },
    });

    const streamOptions = await streamFn(
      { provider: "demo-provider", id: "demo-model" } as never,
      {} as never,
      {},
    );
    expect(requireRecord(streamOptions, "stream options").apiKey).toBe("demo-runtime-key");
    expect(requireRecord(streamOptions, "stream options").authProfileId).toBe(
      "demo-provider:oauth",
    );
    expect(providerStreamFn).toHaveBeenCalledTimes(1);
  });

  it("strips the internal cache boundary before provider-owned stream calls", async () => {
    const providerStreamFn = vi.fn(async (_model, context) => context);
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      providerStreamFn,
      sessionId: "session-1",
      model: {
        api: "openai-completions",
        provider: "demo-provider",
        id: "demo-model",
      } as never,
    });

    const context = await streamFn(
      { provider: "demo-provider", id: "demo-model" } as never,
      {
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
      } as never,
      {},
    );
    expect(requireRecord(context, "stream context").systemPrompt).toBe(
      "Stable prefix\nDynamic suffix",
    );
    expect(providerStreamFn).toHaveBeenCalledTimes(1);
  });
  it("routes supported default streamSimple fallbacks through boundary-aware transports", () => {
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      sessionId: "session-1",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
      } as never,
    });

    expect(streamFn).not.toBe(streamSimple);
  });

  it("keeps explicit custom currentStreamFn values unchanged", () => {
    const currentStreamFn = vi.fn();
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: currentStreamFn as never,
      sessionId: "session-1",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
      } as never,
    });

    expect(streamFn).toBe(currentStreamFn);
  });

  it("routes runtime-auth custom currentStreamFn values through boundary-aware transports", async () => {
    const currentStreamFn = vi.fn();
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: currentStreamFn as never,
      sessionId: "session-1",
      model: {
        api: "anthropic-messages",
        provider: "cloudflare-ai-gateway",
        id: "claude-sonnet-4-6",
        baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic",
        maxTokens: 1024,
        contextWindow: 200_000,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      } as never,
      resolvedApiKey: "sk-ant-test",
    });

    expect(streamFn).not.toBe(currentStreamFn);
  });
});

describe("resolveAttemptFsWorkspaceOnly", () => {
  it("uses global tools.fs.workspaceOnly when agent has no override", () => {
    const cfg: OpenClawConfig = {
      tools: {
        fs: { workspaceOnly: true },
      },
    };

    expect(
      resolveAttemptFsWorkspaceOnly({
        config: cfg,
        sessionAgentId: "main",
      }),
    ).toBe(true);
  });

  it("prefers agent-specific tools.fs.workspaceOnly override", () => {
    const cfg: OpenClawConfig = {
      tools: {
        fs: { workspaceOnly: true },
      },
      agents: {
        list: [
          {
            id: "main",
            tools: {
              fs: { workspaceOnly: false },
            },
          },
        ],
      },
    };

    expect(
      resolveAttemptFsWorkspaceOnly({
        config: cfg,
        sessionAgentId: "main",
      }),
    ).toBe(false);
  });
});

describe("wrapStreamFnTrimToolCallNames", () => {
  async function invokeWrappedStream(
    baseFn: (...args: never[]) => unknown,
    allowedToolNames?: Set<string>,
    guardOptions?: { unknownToolThreshold?: number },
  ) {
    return await invokeWrappedTestStream(
      (innerBaseFn) =>
        wrapStreamFnTrimToolCallNames(innerBaseFn as never, allowedToolNames, guardOptions),
      baseFn,
    );
  }

  function createEventStream(params: {
    event: unknown;
    finalToolCall: { type: string; name: string };
  }) {
    const finalMessage = { role: "assistant", content: [params.finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({ events: [params.event], resultMessage: finalMessage }),
    );
    return { baseFn, finalMessage };
  }

  it("trims whitespace from live streamed tool call names and final result message", async () => {
    const partialToolCall = { type: "toolCall", name: " read " };
    const messageToolCall = { type: "toolCall", name: " exec " };
    const finalToolCall = { type: "toolCall", name: " write " };
    const event = {
      type: "toolcall_delta",
      partial: { role: "assistant", content: [partialToolCall] },
      message: { role: "assistant", content: [messageToolCall] },
    };
    const { baseFn, finalMessage } = createEventStream({ event, finalToolCall });

    const stream = await invokeWrappedStream(baseFn);

    const seenEvents: unknown[] = [];
    for await (const item of stream) {
      seenEvents.push(item);
    }
    const result = await stream.result();

    expect(seenEvents).toHaveLength(1);
    expect(partialToolCall.name).toBe("read");
    expect(messageToolCall.name).toBe("exec");
    expect(finalToolCall.name).toBe("write");
    expect(result).toBe(finalMessage);
    expect(baseFn).toHaveBeenCalledTimes(1);
  });

  it("supports async stream functions that return a promise", async () => {
    const finalToolCall = { type: "toolCall", name: " browser " };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(async () =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    const result = await stream.result();

    expect(finalToolCall.name).toBe("browser");
    expect(result).toBe(finalMessage);
    expect(baseFn).toHaveBeenCalledTimes(1);
  });
  it("normalizes common tool aliases when the canonical name is allowed", async () => {
    const finalToolCall = { type: "toolCall", name: " BASH " };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["exec"]));
    const result = await stream.result();

    expect(finalToolCall.name).toBe("exec");
    expect(result).toBe(finalMessage);
  });

  it("maps provider-prefixed tool names to allowed canonical tools", async () => {
    const partialToolCall = { type: "toolCall", name: " functions.read " };
    const messageToolCall = { type: "toolCall", name: " functions.write " };
    const finalToolCall = { type: "toolCall", name: " tools/exec " };
    const event = {
      type: "toolcall_delta",
      partial: { role: "assistant", content: [partialToolCall] },
      message: { role: "assistant", content: [messageToolCall] },
    };
    const { baseFn } = createEventStream({ event, finalToolCall });

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write", "exec"]));

    for await (const item of stream) {
      void item;
      // drain
    }
    await stream.result();

    expect(partialToolCall.name).toBe("read");
    expect(messageToolCall.name).toBe("write");
    expect(finalToolCall.name).toBe("exec");
  });

  it("normalizes toolUse and functionCall names before dispatch", async () => {
    const partialToolCall = { type: "toolUse", name: " functions.read " };
    const messageToolCall = { type: "functionCall", name: " functions.exec " };
    const finalToolCall = { type: "toolUse", name: " tools/write " };
    const event = {
      type: "toolcall_delta",
      partial: { role: "assistant", content: [partialToolCall] },
      message: { role: "assistant", content: [messageToolCall] },
    };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [event],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write", "exec"]));

    for await (const item of stream) {
      void item;
      // drain
    }
    const result = await stream.result();

    expect(partialToolCall.name).toBe("read");
    expect(messageToolCall.name).toBe("exec");
    expect(finalToolCall.name).toBe("write");
    expect(result).toBe(finalMessage);
  });

  it("preserves multi-segment tool suffixes when dropping provider prefixes", async () => {
    const finalToolCall = { type: "toolCall", name: " functions.graph.search " };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["graph.search", "search"]));
    const result = await stream.result();

    expect(finalToolCall.name).toBe("graph.search");
    expect(result).toBe(finalMessage);
  });

  it("rewrites repeated unavailable tool calls into plain assistant text after the threshold", async () => {
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: {
          role: "assistant",
          content: [{ type: "toolCall", name: " exec ", arguments: { command: "echo eleven" } }],
        },
      }),
    );
    const wrappedFn = wrapStreamFnTrimToolCallNames(baseFn as never, new Set(["read"]), {
      unknownToolThreshold: 10,
    });

    for (let i = 0; i < 10; i += 1) {
      const stream = await Promise.resolve(wrappedFn({} as never, {} as never, {} as never));
      const result = await stream.result();
      const message = requireRecord(result, "result message");
      expect(message.role).toBe("assistant");
      expectSingleToolCallContent(message.content as unknown[], "exec");
    }

    const blockedStream = await Promise.resolve(wrappedFn({} as never, {} as never, {} as never));
    const blockedResult = (await blockedStream.result()) as {
      role: string;
      content: Array<{ type: string; text?: string }>;
    };

    expect(blockedResult.role).toBe("assistant");
    expectSingleTextContent(blockedResult.content, '"exec"');
  });

  it("leaves repeated unavailable tool calls alone when the unknown-tool guard is disabled", async () => {
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: {
          role: "assistant",
          content: [{ type: "toolCall", name: " exec ", arguments: { command: "echo eleven" } }],
        },
      }),
    );
    const wrappedFn = wrapStreamFnTrimToolCallNames(baseFn as never, new Set(["read"]));

    for (let i = 0; i < 11; i += 1) {
      const stream = await Promise.resolve(wrappedFn({} as never, {} as never, {} as never));
      const result = await stream.result();
      const message = requireRecord(result, "result message");
      expect(message.role).toBe("assistant");
      expectSingleToolCallContent(message.content as unknown[], "exec");
    }
  });

  it("does not count partial tool-call deltas as separate unavailable-tool retries", async () => {
    const partialToolCall = { type: "toolCall", name: " exec " };
    const messageToolCall = { type: "toolCall", name: " exec " };
    const finalToolCall = { type: "toolCall", name: " exec " };
    const event = {
      type: "toolcall_delta",
      partial: { role: "assistant", content: [partialToolCall] },
      message: { role: "assistant", content: [messageToolCall] },
    };
    const { baseFn } = createEventStream({ event, finalToolCall });

    const stream = await invokeWrappedStream(baseFn, new Set(["read"]), {
      unknownToolThreshold: 1,
    });

    for await (const item of stream) {
      void item;
      // drain
    }
    const result = (await stream.result()) as {
      content: Array<{ type: string; text?: string; name?: string }>;
    };

    expect(partialToolCall.name).toBe("exec");
    expect(messageToolCall.name).toBe("exec");
    expectSingleToolCallContent(result.content, "exec");
  });

  it("does not reset the unavailable-tool streak on partial-only stream chunks", async () => {
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            type: "toolcall_delta",
            partial: { role: "assistant", content: [{ type: "toolCall", name: " exec " }] },
          },
        ],
        resultMessage: {
          role: "assistant",
          content: [{ type: "toolCall", name: " exec ", arguments: { command: "echo retry" } }],
        },
      }),
    );
    const wrappedFn = wrapStreamFnTrimToolCallNames(baseFn as never, new Set(["read"]), {
      unknownToolThreshold: 1,
    });

    const firstStream = await Promise.resolve(wrappedFn({} as never, {} as never, {} as never));
    await firstStream.result();

    const secondStream = await Promise.resolve(wrappedFn({} as never, {} as never, {} as never));
    for await (const ignoredItem of secondStream) {
      void ignoredItem;
      // drain
    }
    const secondResult = (await secondStream.result()) as {
      role: string;
      content: Array<{ type: string; text?: string; name?: string }>;
    };

    expect(secondResult.role).toBe("assistant");
    expectSingleTextContent(secondResult.content, '"exec"');
  });

  it("counts the final unknown-tool retry when streamed messages omit the tool name", async () => {
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            type: "toolcall_delta",
            message: { role: "assistant", content: [{ type: "toolCall", name: "" }] },
          },
        ],
        resultMessage: {
          role: "assistant",
          content: [{ type: "toolCall", name: " exec ", arguments: { command: "echo retry" } }],
        },
      }),
    );
    const wrappedFn = wrapStreamFnTrimToolCallNames(baseFn as never, new Set(["read"]), {
      unknownToolThreshold: 1,
    });

    const firstStream = await Promise.resolve(wrappedFn({} as never, {} as never, {} as never));
    await firstStream.result();

    const secondStream = await Promise.resolve(wrappedFn({} as never, {} as never, {} as never));
    for await (const ignoredItem of secondStream) {
      void ignoredItem;
      // drain
    }
    const secondResult = (await secondStream.result()) as {
      role: string;
      content: Array<{ type: string; text?: string; name?: string }>;
    };

    expect(secondResult.role).toBe("assistant");
    expectSingleTextContent(secondResult.content, '"exec"');
  });

  it("resets a provisional streamed unknown-tool retry when later chunks resolve to an allowed tool", async () => {
    const baseFn = vi
      .fn()
      .mockImplementationOnce(() =>
        createFakeStream({
          events: [
            {
              type: "toolcall_delta",
              message: { role: "assistant", content: [{ type: "toolCall", name: " ex " }] },
            },
            {
              type: "toolcall_delta",
              message: { role: "assistant", content: [{ type: "toolCall", name: " exec " }] },
            },
          ],
          resultMessage: {
            role: "assistant",
            content: [{ type: "toolCall", name: " exec ", arguments: { command: "echo ok" } }],
          },
        }),
      )
      .mockImplementationOnce(() =>
        createFakeStream({
          events: [],
          resultMessage: {
            role: "assistant",
            content: [{ type: "toolCall", name: " ex ", arguments: { command: "echo retry" } }],
          },
        }),
      );
    const wrappedFn = wrapStreamFnTrimToolCallNames(baseFn as never, new Set(["exec"]), {
      unknownToolThreshold: 1,
    });

    const firstStream = await Promise.resolve(wrappedFn({} as never, {} as never, {} as never));
    for await (const ignoredItem of firstStream) {
      void ignoredItem;
      // drain
    }
    await firstStream.result();

    const secondStream = await Promise.resolve(wrappedFn({} as never, {} as never, {} as never));
    const secondResult = (await secondStream.result()) as {
      role: string;
      content: Array<{ type: string; text?: string; name?: string }>;
    };

    expect(secondResult.role).toBe("assistant");
    expectSingleToolCallContent(secondResult.content, "ex");
  });

  it("keeps processing later streamed messages after one streamed unknown-tool retry was counted", async () => {
    const baseFn = vi
      .fn()
      .mockImplementationOnce(() =>
        createFakeStream({
          events: [
            {
              type: "toolcall_delta",
              message: { role: "assistant", content: [{ type: "toolCall", name: " re " }] },
            },
            {
              type: "toolcall_delta",
              message: { role: "assistant", content: [{ type: "toolCall", name: " read " }] },
            },
          ],
          resultMessage: {
            role: "assistant",
            content: [{ type: "text", text: "resolved to allowed tool" }],
          },
        }),
      )
      .mockImplementationOnce(() =>
        createFakeStream({
          events: [],
          resultMessage: {
            role: "assistant",
            content: [{ type: "toolCall", name: " re ", arguments: { command: "echo retry" } }],
          },
        }),
      );
    const wrappedFn = wrapStreamFnTrimToolCallNames(baseFn as never, new Set(["read"]), {
      unknownToolThreshold: 1,
    });

    const firstStream = await Promise.resolve(wrappedFn({} as never, {} as never, {} as never));
    for await (const ignoredItem of firstStream) {
      void ignoredItem;
      // drain
    }
    await firstStream.result();

    const secondStream = await Promise.resolve(wrappedFn({} as never, {} as never, {} as never));
    const secondResult = (await secondStream.result()) as {
      role: string;
      content: Array<{ type: string; text?: string; name?: string }>;
    };

    expect(secondResult.role).toBe("assistant");
    expectSingleToolCallContent(secondResult.content, "re");
  });

  it("resets a stale unknown-tool streak when a streamed message mixes allowed and unknown tools", async () => {
    const baseFn = vi
      .fn()
      .mockImplementationOnce(() =>
        createFakeStream({
          events: [],
          resultMessage: {
            role: "assistant",
            content: [{ type: "toolCall", name: " ex ", arguments: { command: "echo first" } }],
          },
        }),
      )
      .mockImplementationOnce(() =>
        createFakeStream({
          events: [
            {
              type: "toolcall_delta",
              message: {
                role: "assistant",
                content: [
                  { type: "toolCall", name: " exec ", arguments: { command: "echo allowed" } },
                  { type: "toolCall", name: " ex ", arguments: { command: "echo provisional" } },
                ],
              },
            },
          ],
          resultMessage: {
            role: "assistant",
            content: [{ type: "toolCall", name: " exec ", arguments: { command: "echo ok" } }],
          },
        }),
      )
      .mockImplementationOnce(() =>
        createFakeStream({
          events: [],
          resultMessage: {
            role: "assistant",
            content: [{ type: "toolCall", name: " ex ", arguments: { command: "echo retry" } }],
          },
        }),
      );
    const wrappedFn = wrapStreamFnTrimToolCallNames(baseFn as never, new Set(["exec"]), {
      unknownToolThreshold: 1,
    });

    const firstStream = await Promise.resolve(wrappedFn({} as never, {} as never, {} as never));
    await firstStream.result();

    const secondStream = await Promise.resolve(wrappedFn({} as never, {} as never, {} as never));
    for await (const ignoredItem of secondStream) {
      void ignoredItem;
      // drain
    }
    await secondStream.result();

    const thirdStream = await Promise.resolve(wrappedFn({} as never, {} as never, {} as never));
    const thirdResult = (await thirdStream.result()) as {
      role: string;
      content: Array<{ type: string; text?: string; name?: string }>;
    };

    expect(thirdResult.role).toBe("assistant");
    expectSingleToolCallContent(thirdResult.content, "ex");
  });

  it("infers tool names from malformed toolCallId variants when allowlist is present", async () => {
    const partialToolCall = { type: "toolCall", id: "functions.read:0", name: "" };
    const finalToolCallA = { type: "toolCall", id: "functionsread3", name: "" };
    const finalToolCallB: { type: string; id: string; name?: string } = {
      type: "toolCall",
      id: "functionswrite4",
    };
    const finalToolCallC = { type: "functionCall", id: "functions.exec2", name: "" };
    const event = {
      type: "toolcall_delta",
      partial: { role: "assistant", content: [partialToolCall] },
    };
    const finalMessage = {
      role: "assistant",
      content: [finalToolCallA, finalToolCallB, finalToolCallC],
    };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [event],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write", "exec"]));
    for await (const item of stream) {
      void item;
      // drain
    }
    const result = await stream.result();

    expect(partialToolCall.name).toBe("read");
    expect(finalToolCallA.name).toBe("read");
    expect(finalToolCallB.name).toBe("write");
    expect(finalToolCallC.name).toBe("exec");
    expect(result).toBe(finalMessage);
  });

  it("does not infer names from malformed toolCallId when allowlist is absent", async () => {
    const finalToolCall: { type: string; id: string; name?: string } = {
      type: "toolCall",
      id: "functionsread3",
    };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    await stream.result();

    expect(finalToolCall.name).toBeUndefined();
  });

  it("infers malformed non-blank tool names before dispatch", async () => {
    const partialToolCall = { type: "toolCall", id: "functionsread3", name: "functionsread3" };
    const finalToolCall = { type: "toolCall", id: "functionsread3", name: "functionsread3" };
    const event = {
      type: "toolcall_delta",
      partial: { role: "assistant", content: [partialToolCall] },
    };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [event],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    for await (const item of stream) {
      void item;
      // drain
    }
    await stream.result();

    expect(partialToolCall.name).toBe("read");
    expect(finalToolCall.name).toBe("read");
  });

  it("recovers malformed non-blank names when id is missing", async () => {
    const finalToolCall = { type: "toolCall", name: "functionsread3" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("read");
  });

  it("recovers canonical tool names from canonical ids when name is empty", async () => {
    const finalToolCall = { type: "toolCall", id: "read", name: "" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("read");
  });

  it("recovers tool names from ids when name is whitespace-only", async () => {
    const finalToolCall = { type: "toolCall", id: "functionswrite4", name: "   " };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("write");
  });

  it("stops final blank tool names before dispatch and still assigns fallback ids", async () => {
    const finalToolCall = { type: "toolCall", id: "", name: "" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    const result = (await stream.result()) as {
      content: Array<{ type: string; text?: string }>;
    };

    expectSingleTextContent(result.content, '"blank tool name"');
    expect(finalToolCall.name).toBe("");
    expect(finalToolCall.id).toMatch(/^call_[0-9a-f]{24}$/);
  });

  it("assigns fallback ids when both name and id are missing", async () => {
    const finalToolCall: { type: string; name?: string; id?: string } = { type: "toolCall" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBeUndefined();
    expect(finalToolCall.id).toMatch(/^call_[0-9a-f]{24}$/);
  });

  it("does not reuse fallback ids across assistant response streams", async () => {
    const ids: string[] = [];
    for (let responseIndex = 0; responseIndex < 2; responseIndex += 1) {
      const finalToolCall: { type: string; name: string; id?: string } = {
        type: "toolCall",
        name: "read",
      };
      const baseFn = vi.fn(() =>
        createFakeStream({
          events: [],
          resultMessage: { role: "assistant", content: [finalToolCall] },
        }),
      );
      const stream = await invokeWrappedStream(baseFn, new Set(["read"]));
      await stream.result();
      if (!finalToolCall.id) {
        throw new Error("missing fallback tool call id");
      }
      ids.push(finalToolCall.id);
    }

    expect(ids[0]).toMatch(/^call_[0-9a-f]{24}$/);
    expect(ids[1]).toMatch(/^call_[0-9a-f]{24}$/);
    expect(ids[1]).not.toBe(ids[0]);
  });

  it("prefers explicit canonical names over conflicting canonical ids", async () => {
    const finalToolCall = { type: "toolCall", id: "write", name: "read" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("read");
    expect(finalToolCall.id).toBe("write");
  });

  it("prefers explicit trimmed canonical names over conflicting malformed ids", async () => {
    const finalToolCall = { type: "toolCall", id: "functionswrite4", name: " read " };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("read");
  });

  it("does not rewrite composite names that mention multiple tools", async () => {
    const finalToolCall = { type: "toolCall", id: "functionsread3", name: "read write" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("read write");
  });

  it("fails closed for malformed non-blank names that are ambiguous", async () => {
    const finalToolCall = { type: "toolCall", id: "functions.exec2", name: "functions.exec2" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["exec", "exec2"]));
    await stream.result();

    expect(finalToolCall.name).toBe("functions.exec2");
  });

  it("matches malformed ids case-insensitively across common separators", async () => {
    const finalToolCall = { type: "toolCall", id: "Functions.Read_7", name: "" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("read");
  });
  it("does not override explicit non-blank tool names with inferred ids", async () => {
    const finalToolCall = { type: "toolCall", id: "functionswrite4", name: "someOtherTool" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("someOtherTool");
  });

  it("fails closed when malformed ids could map to multiple allowlisted tools", async () => {
    const finalToolCall = { type: "toolCall", id: "functions.exec2", name: "" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["exec", "exec2"]));
    const result = (await stream.result()) as {
      content: Array<{ type: string; text?: string }>;
    };

    expectSingleTextContent(result.content, '"blank tool name"');
    expect(finalToolCall.name).toBe("");
  });
  it("leaves provisional blank streamed names recoverable while stopping final blank dispatch", async () => {
    const partialToolCall = { type: "toolCall", name: "   " };
    const finalToolCall = { type: "toolCall", name: "\t  " };
    const event = {
      type: "toolcall_delta",
      partial: { role: "assistant", content: [partialToolCall] },
    };
    const { baseFn } = createEventStream({ event, finalToolCall });

    const stream = await invokeWrappedStream(baseFn);

    for await (const item of stream) {
      void item;
      // drain
    }
    const result = (await stream.result()) as {
      content: Array<{ type: string; text?: string }>;
    };

    expectSingleTextContent(result.content, '"blank tool name"');
    expect(partialToolCall.name).toBe("   ");
    expect(finalToolCall.name).toBe("\t  ");
    expect(baseFn).toHaveBeenCalledTimes(1);
  });

  it("does not turn blank model output into a callable _blank tool", async () => {
    const finalToolCall = { type: "toolCall", id: "call_1", name: "", arguments: {} };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["_blank"]));
    const result = (await stream.result()) as {
      content: Array<{ type: string; text?: string }>;
    };

    expectSingleTextContent(result.content, '"blank tool name"');
    expect(finalToolCall.name).toBe("");
  });

  it("assigns fallback ids to missing/blank tool call ids in streamed and final messages", async () => {
    const partialToolCall = { type: "toolCall", name: " read ", id: "   " };
    const finalToolCallA = { type: "toolCall", name: " exec ", id: "" };
    const finalToolCallB: { type: string; name: string; id?: string } = {
      type: "toolCall",
      name: " write ",
    };
    const event = {
      type: "toolcall_delta",
      partial: { role: "assistant", content: [partialToolCall] },
    };
    const finalMessage = { role: "assistant", content: [finalToolCallA, finalToolCallB] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [event],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const item of stream) {
      void item;
      // drain
    }
    const result = await stream.result();

    expect(partialToolCall.name).toBe("read");
    expect(partialToolCall.id).toMatch(/^call_[0-9a-f]{24}$/);
    expect(finalToolCallA.name).toBe("exec");
    expect(finalToolCallA.id).toBe(partialToolCall.id);
    expect(finalToolCallB.name).toBe("write");
    expect(finalToolCallB.id).toMatch(/^call_[0-9a-f]{24}$/);
    expect(finalToolCallB.id).not.toBe(finalToolCallA.id);
    expect(result).toBe(finalMessage);
  });

  it("trims surrounding whitespace on tool call ids", async () => {
    const finalToolCall = { type: "toolCall", name: " read ", id: "  call_42  " };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    await stream.result();

    expect(finalToolCall.name).toBe("read");
    expect(finalToolCall.id).toBe("call_42");
  });

  it("reassigns duplicate tool call ids within a message to unique fallbacks", async () => {
    const finalToolCallA = { type: "toolCall", name: " read ", id: "  edit:22  " };
    const finalToolCallB = { type: "toolCall", name: " write ", id: "edit:22" };
    const finalMessage = { role: "assistant", content: [finalToolCallA, finalToolCallB] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    await stream.result();

    expect(finalToolCallA.name).toBe("read");
    expect(finalToolCallB.name).toBe("write");
    expect(finalToolCallA.id).toBe("edit:22");
    expect(finalToolCallB.id).toMatch(/^call_[0-9a-f]{24}$/);
  });
});

describe("wrapStreamFnSanitizeMalformedToolCalls", () => {
  it("drops malformed assistant tool calls from outbound context before provider replay", async () => {
    const messages = [
      {
        role: "assistant",
        stopReason: "error",
        content: [{ type: "toolCall", name: "read", arguments: {} }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]), {
      validateAnthropicTurns: true,
      preserveSignatures: true,
      dropThinkingBlocks: false,
    } as never);
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn);
    expect(seenContext.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ]);
    expect(seenContext.messages).not.toBe(messages);
  });

  it("preserves outbound context when all assistant tool calls are valid", async () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]), {
      validateAnthropicTurns: true,
      preserveSignatures: true,
      dropThinkingBlocks: false,
    } as never);
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn);
    expect(seenContext.messages).toBe(messages);
  });

  it("preserves deferred directory tool calls allowed only for replay", async () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_hidden", name: "hidden_catalog_tool", arguments: {} },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_hidden",
        content: [{ type: "toolResult", result: { ok: true } }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(
      baseFn as never,
      new Set(["tool_describe", "tool_call", "hidden_catalog_tool"]),
      {
        validateAnthropicTurns: true,
        preserveSignatures: true,
        dropThinkingBlocks: false,
      } as never,
    );
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn);
    expect(seenContext.messages).toBe(messages);
  });

  it("strips trailing assistant prefill turns for Anthropic outbound replay", async () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "earlier question" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "stale assistant answer" }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]), {
      validateAnthropicTurns: true,
      preserveSignatures: true,
      dropThinkingBlocks: false,
    } as never);
    const stream = wrapped(
      { api: "anthropic-messages" } as never,
      { messages } as never,
      {} as never,
    ) as FakeWrappedStream | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn);
    expect(seenContext.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "earlier question" }],
      },
    ]);
    expect(seenContext.messages).not.toBe(messages);
  });

  it("strips trailing assistant prefill turns for Gemini outbound replay", async () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "earlier question" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "stale model answer" }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]), {
      validateGeminiTurns: true,
      preserveSignatures: true,
      dropThinkingBlocks: false,
    } as never);
    const stream = wrapped(
      { api: "google-generative-ai" } as never,
      { messages } as never,
      {} as never,
    ) as FakeWrappedStream | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn);
    expect(seenContext.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "earlier question" }],
      },
    ]);
    expect(seenContext.messages).not.toBe(messages);
  });

  it("drops signed thinking turns when sibling replay tool calls are not allowlisted", async () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
          { type: "toolCall", id: "toolu_legacy", name: "gateway", arguments: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]), {
      validateAnthropicTurns: true,
      preserveSignatures: true,
      dropThinkingBlocks: false,
    } as never);
    const stream = wrapped(
      { api: "anthropic-messages" } as never,
      { messages } as never,
      {} as never,
    ) as FakeWrappedStream | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn);
    expect(seenContext.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ]);
  });

  it("drops signed thinking turns for bedrock claude replay when sibling tool calls are not replay-safe", async () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
          { type: "toolCall", id: "toolu_legacy", name: "gateway", arguments: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]), {
      validateAnthropicTurns: true,
      preserveSignatures: true,
      dropThinkingBlocks: false,
    } as never);
    const stream = wrapped(
      { api: "bedrock-converse-stream" } as never,
      { messages } as never,
      {} as never,
    ) as FakeWrappedStream | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn);
    expect(seenContext.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ]);
  });

  it("drops signed thinking turns when sibling replay tool calls reuse an id", async () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
          { type: "toolCall", id: "call_1", name: "read", arguments: {} },
          { type: "functionCall", id: "call_1", name: "read", arguments: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]), {
      validateAnthropicTurns: true,
      preserveSignatures: true,
      dropThinkingBlocks: false,
    } as never);
    const stream = wrapped(
      { api: "anthropic-messages" } as never,
      { messages } as never,
      {} as never,
    ) as FakeWrappedStream | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn);
    expect(seenContext.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ]);
  });

  it("keeps signed thinking turns that reuse a mutable earlier tool id", async () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        content: [{ type: "text", text: "mutable result" }],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
          { type: "toolUse", id: "call_1", name: "read", input: {} },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        content: [{ type: "text", text: "signed result" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]), {
      validateAnthropicTurns: true,
      preserveSignatures: true,
      dropThinkingBlocks: false,
    } as never);
    const stream = wrapped(
      { api: "anthropic-messages" } as never,
      { messages } as never,
      {} as never,
    ) as FakeWrappedStream | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn);
    expect(seenContext.messages).toBe(messages);
  });

  it("drops signed thinking reused ids when their real result is displaced", async () => {
    const firstAssistant = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
    };
    const firstResult = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "mutable result" }],
    };
    const userMessage = {
      role: "user",
      content: [{ type: "text", text: "retry" }],
    };
    const messages = [
      firstAssistant,
      firstResult,
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
          { type: "toolUse", id: "call_1", name: "read", input: {} },
        ],
      },
      userMessage,
      {
        role: "toolResult",
        toolCallId: "call_1",
        content: [{ type: "text", text: "signed result" }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]), {
      validateAnthropicTurns: true,
      preserveSignatures: true,
      dropThinkingBlocks: false,
    } as never);
    const stream = wrapped(
      { api: "anthropic-messages" } as never,
      { messages } as never,
      {} as never,
    ) as FakeWrappedStream | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn);
    expect(seenContext.messages).toEqual([firstAssistant, firstResult, userMessage]);
  });

  it("drops signed thinking turns with inline sessions_spawn attachments when the result is missing", async () => {
    const attachmentContent = "SIGNED_THINKING_INLINE_ATTACHMENT";
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
          {
            type: "toolUse",
            id: "call_1",
            name: "sessions_spawn",
            input: {
              task: "inspect attachment",
              attachments: [{ name: "snapshot.txt", content: attachmentContent }],
            },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(
      baseFn as never,
      new Set(["sessions_spawn"]),
      {
        validateAnthropicTurns: true,
        preserveSignatures: true,
        dropThinkingBlocks: false,
      } as never,
    );
    const stream = wrapped(
      { api: "anthropic-messages" } as never,
      { messages } as never,
      {} as never,
    ) as FakeWrappedStream | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn);
    expect(seenContext.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ]);
  });

  it("drops signed thinking turns with non-content attachment payload fields when the result is missing", async () => {
    const attachmentContent = "SIGNED_THINKING_NESTED_ATTACHMENT";
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
          {
            type: "toolUse",
            id: "call_1",
            name: "sessions_spawn",
            input: {
              task: "inspect attachment",
              attachments: [
                {
                  name: "snapshot.txt",
                  mimeType: "text/plain",
                  data: attachmentContent,
                },
              ],
            },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(
      baseFn as never,
      new Set(["sessions_spawn"]),
      {
        validateAnthropicTurns: true,
        preserveSignatures: true,
        dropThinkingBlocks: false,
      } as never,
    );
    const stream = wrapped(
      { api: "anthropic-messages" } as never,
      { messages } as never,
      {} as never,
    ) as FakeWrappedStream | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn);
    expect(seenContext.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ]);
  });

  it("keeps signed thinking turns with sessions_spawn attachments when the tool result is present", async () => {
    const attachmentContent = "SIGNED_THINKING_PAIRED_ATTACHMENT";
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
          {
            type: "toolUse",
            id: "call_1",
            name: "sessions_spawn",
            input: {
              task: "inspect attachment",
              attachments: [{ name: "snapshot.txt", content: attachmentContent }],
            },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "sessions_spawn",
        content: [{ type: "text", text: "done" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(
      baseFn as never,
      new Set(["sessions_spawn"]),
      {
        validateAnthropicTurns: true,
        preserveSignatures: true,
        dropThinkingBlocks: false,
      } as never,
    );
    const stream = wrapped(
      { api: "anthropic-messages" } as never,
      { messages } as never,
      {} as never,
    ) as FakeWrappedStream | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn);
    expect(seenContext.messages).toBe(messages);
  });

  it("keeps mutable thinking turns outside anthropic replay-only preservation", async () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
          { type: "toolCall", id: "call_1", name: " read ", arguments: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]), {
      validateAnthropicTurns: true,
    } as never);
    const stream = wrapped(
      { api: "openai-completions" } as never,
      { messages } as never,
      {} as never,
    ) as FakeWrappedStream | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn);
    expect(seenContext.messages).toHaveLength(3);
    expect(seenContext.messages[0]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
        { type: "toolCall", id: "call_1", name: "read", arguments: {} },
      ],
    });
    const repairedToolResult = requireRecord(seenContext.messages[1], "repaired tool result");
    expect(repairedToolResult.role).toBe("toolResult");
    expect(repairedToolResult.toolCallId).toBe("call_1");
    expect(repairedToolResult.toolName).toBe("read");
    expect(repairedToolResult.content).toEqual([
      {
        type: "text",
        text: "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.",
      },
    ]);
    expect(repairedToolResult.isError).toBe(true);
    expect(repairedToolResult.timestamp).toBeTypeOf("number");
    expect(seenContext.messages[2]).toEqual({
      role: "user",
      content: [{ type: "text", text: "retry" }],
    });
  });

  it("preserves sessions_spawn attachment payloads on replay", async () => {
    const attachmentContent = "INLINE_ATTACHMENT_PAYLOAD";
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolUse",
            id: "call_1",
            name: "  SESSIONS_SPAWN  ",
            input: {
              task: "inspect attachment",
              attachments: [{ name: "snapshot.txt", content: attachmentContent }],
            },
          },
        ],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(
      baseFn as never,
      new Set(["sessions_spawn"]),
      { validateAnthropicTurns: true } as never,
    );
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn) as {
      messages: Array<{ content?: Array<Record<string, unknown>> }>;
    };
    const toolCall = seenContext.messages[0]?.content?.[0] as {
      name?: string;
      input?: { attachments?: Array<{ content?: string }> };
    };
    expect(toolCall.name).toBe("sessions_spawn");
    expect(toolCall.input?.attachments?.[0]?.content).toBe(attachmentContent);
  });

  it("keeps non-Anthropic thinking turns mutable when Anthropic replay validation is off", async () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
          { type: "toolCall", id: "call_read", name: " read ", arguments: { path: "README.md" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]));
    const stream = wrapped(
      { api: "google-gemini" } as never,
      { messages } as never,
      {} as never,
    ) as FakeWrappedStream | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn) as {
      messages: Array<{ content?: unknown[] }>;
    };
    expect(seenContext.messages[0]?.content).toEqual([
      { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
      { type: "toolCall", id: "call_read", name: "read", arguments: { path: "README.md" } },
    ]);
  });

  it("preserves allowlisted tool names that contain punctuation", async () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "call_1", name: "admin.export", input: { scope: "all" } }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(
      baseFn as never,
      new Set(["admin.export"]),
    );
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn);
    expect(seenContext.messages).toBe(messages);
  });

  it("normalizes provider-prefixed replayed tool names before provider replay", async () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "call_1", name: "functions.read", input: { path: "." } }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]));
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn) as {
      messages: Array<{ content?: Array<{ name?: string }> }>;
    };
    expect(seenContext.messages[0]?.content?.[0]?.name).toBe("read");
  });

  it("canonicalizes mixed-case allowlisted tool names on replay", async () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "readfile", arguments: {} }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["ReadFile"]));
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn) as {
      messages: Array<{ content?: Array<{ name?: string }> }>;
    };
    expect(seenContext.messages[0]?.content?.[0]?.name).toBe("ReadFile");
  });

  it("recovers blank replayed tool names from their ids", async () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "functionswrite4", name: "   ", arguments: {} }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["write"]));
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn) as {
      messages: Array<{ content?: Array<{ name?: string }> }>;
    };
    expect(seenContext.messages[0]?.content?.[0]?.name).toBe("write");
  });

  it("drops replayed blank tool names that cannot be recovered from ids", async () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "   ", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "",
        content: [{ type: "text", text: "stale result" }],
        isError: true,
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never);
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn);
    expect(seenContext.messages).toStrictEqual([]);
  });

  it("recovers mangled replayed tool names before dropping the call", async () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "functionsread3", arguments: {} }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]));
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn) as {
      messages: Array<{ content?: Array<{ name?: string }> }>;
    };
    expect(seenContext.messages[0]?.content?.[0]?.name).toBe("read");
  });

  it("drops orphaned tool results after replay sanitization removes a tool-call turn", async () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "read", arguments: {} }],
        stopReason: "error",
      },
      {
        role: "toolResult",
        toolCallId: "call_missing",
        toolName: "read",
        content: [{ type: "text", text: "stale result" }],
        isError: false,
      },
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]));
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn) as {
      messages: Array<{ role?: string }>;
    };
    expect(seenContext.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ]);
  });

  it("drops replayed tool calls that are no longer allowlisted", async () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "write", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "write",
        content: [{ type: "text", text: "stale result" }],
        isError: false,
      },
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]));
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn) as {
      messages: Array<{ role?: string }>;
    };
    expect(seenContext.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ]);
  });
  it("drops replayed tool names that are no longer allowlisted", async () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "call_1", name: "unknown_tool", input: { path: "." } }],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "unknown_tool",
        content: [{ type: "text", text: "stale result" }],
        isError: false,
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]));
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn);
    expect(seenContext.messages).toStrictEqual([]);
  });

  it("drops ambiguous mangled replay names instead of guessing a tool", async () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "functions.exec2", arguments: {} }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(
      baseFn as never,
      new Set(["exec", "exec2"]),
    );
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn);
    expect(seenContext.messages).toStrictEqual([]);
  });

  it("preserves matching tool results for retained errored assistant turns", async () => {
    const messages = [
      {
        role: "assistant",
        stopReason: "error",
        content: [
          { type: "toolCall", id: "call_1", name: "read", arguments: {} },
          { type: "toolCall", name: "read", arguments: {} },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "kept result" }],
        isError: false,
      },
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]));
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn);
    expect(seenContext.messages).toEqual([
      {
        role: "assistant",
        stopReason: "error",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "kept result" }],
        isError: false,
      },
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ]);
  });

  it("revalidates turn ordering after dropping an assistant replay turn", async () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "first" }],
      },
      {
        role: "assistant",
        stopReason: "error",
        content: [{ type: "toolCall", name: "read", arguments: {} }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "second" }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]), {
      validateGeminiTurns: false,
      validateAnthropicTurns: true,
      preserveSignatures: false,
      dropThinkingBlocks: false,
    });
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn) as {
      messages: Array<{ role?: string; content?: unknown[] }>;
    };
    expect(seenContext.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    ]);
  });

  it("drops orphaned Anthropic user tool_result blocks after replay sanitization", async () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "partial response" },
          { type: "toolUse", name: "read", input: { path: "." } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "toolResult", toolUseId: "call_1", content: [{ type: "text", text: "stale" }] },
          { type: "text", text: "retry" },
        ],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]), {
      validateGeminiTurns: false,
      validateAnthropicTurns: true,
      preserveSignatures: false,
      dropThinkingBlocks: false,
    });
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn) as {
      messages: Array<{ role?: string; content?: unknown[] }>;
    };
    expect(seenContext.messages).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "partial response" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ]);
  });

  it("drops embedded Anthropic user tool_result blocks when signed-thinking replay must stay provider-owned", async () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
          { type: "toolUse", id: "call_1", name: "read", input: { path: "." } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "toolResult",
            toolUseId: "call_1",
            content: [{ type: "text", text: "embedded result" }],
          },
          { type: "text", text: "retry" },
        ],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]), {
      validateGeminiTurns: false,
      validateAnthropicTurns: true,
      preserveSignatures: true,
      dropThinkingBlocks: false,
    });
    const stream = wrapped(
      { api: "anthropic-messages" } as never,
      { messages } as never,
      {} as never,
    ) as FakeWrappedStream | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn) as {
      messages: Array<{ role?: string; content?: unknown[] }>;
    };
    expect(seenContext.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ]);
  });

  it("preserves embedded Anthropic user tool_result blocks for non-thinking turns even when immutable replay is enabled", async () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "call_1", name: "read", input: { path: "." } }],
      },
      {
        role: "user",
        content: [
          {
            type: "toolResult",
            toolUseId: "call_1",
            content: [{ type: "text", text: "kept result" }],
          },
          { type: "text", text: "retry" },
        ],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]), {
      validateGeminiTurns: false,
      validateAnthropicTurns: true,
      preserveSignatures: true,
      dropThinkingBlocks: false,
    });
    const stream = wrapped(
      { api: "anthropic-messages" } as never,
      { messages } as never,
      {} as never,
    ) as FakeWrappedStream | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn) as {
      messages: Array<{ role?: string; content?: unknown[] }>;
    };
    expect(seenContext.messages).toEqual(messages);
  });

  it.each(["toolCall", "functionCall"] as const)(
    "preserves matching Anthropic user tool_result blocks after %s replay turns",
    async (toolCallType) => {
      const messages = [
        {
          role: "assistant",
          content: [{ type: toolCallType, id: "call_1", name: "read", arguments: {} }],
        },
        {
          role: "user",
          content: [
            {
              type: "toolResult",
              toolUseId: "call_1",
              content: [{ type: "text", text: "kept result" }],
            },
            { type: "text", text: "retry" },
          ],
        },
      ];
      const baseFn = vi.fn((_model, _context) =>
        createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
      );

      const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]), {
        validateGeminiTurns: false,
        validateAnthropicTurns: true,
        preserveSignatures: false,
        dropThinkingBlocks: false,
      });
      const stream = wrapped({} as never, { messages } as never, {} as never) as
        | FakeWrappedStream
        | Promise<FakeWrappedStream>;
      await Promise.resolve(stream);

      expect(baseFn).toHaveBeenCalledTimes(1);
      const seenContext = firstBaseContext(baseFn) as {
        messages: Array<{ role?: string; content?: unknown[] }>;
      };
      expect(seenContext.messages).toEqual(messages);
    },
  );

  it("drops orphaned Anthropic user tool_result blocks after dropping an assistant replay turn", async () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "first" }],
      },
      {
        role: "assistant",
        stopReason: "error",
        content: [{ type: "toolUse", name: "read", input: { path: "." } }],
      },
      {
        role: "user",
        content: [
          { type: "toolResult", toolUseId: "call_1", content: [{ type: "text", text: "stale" }] },
          { type: "text", text: "second" },
        ],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]), {
      validateGeminiTurns: false,
      validateAnthropicTurns: true,
      preserveSignatures: false,
      dropThinkingBlocks: false,
    });
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = firstBaseContext(baseFn) as {
      messages: Array<{ role?: string; content?: unknown[] }>;
    };
    expect(seenContext.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    ]);
  });
});

describe("wrapStreamFnRepairMalformedToolCallArguments", () => {
  async function invokeWrappedStream(baseFn: (...args: never[]) => unknown) {
    return await invokeWrappedTestStream(
      (innerBaseFn) => wrapStreamFnRepairMalformedToolCallArguments(innerBaseFn as never),
      baseFn,
    );
  }

  it("repairs anthropic-compatible tool arguments when trailing junk follows valid JSON", async () => {
    const partialToolCall = { type: "toolCall", name: "read", arguments: {} };
    const streamedToolCall = { type: "toolCall", name: "read", arguments: {} };
    const endMessageToolCall = { type: "toolCall", name: "read", arguments: {} };
    const finalToolCall = { type: "toolCall", name: "read", arguments: {} };
    const partialMessage = { role: "assistant", content: [partialToolCall] };
    const endMessage = { role: "assistant", content: [endMessageToolCall] };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: '{"path":"/tmp/report.txt"}',
            partial: partialMessage,
          },
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: "xx",
            partial: partialMessage,
          },
          {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: streamedToolCall,
            partial: partialMessage,
            message: endMessage,
          },
        ],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const item of stream) {
      void item;
      // drain
    }
    const result = await stream.result();

    expect(partialToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(streamedToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(endMessageToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(finalToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(result).toBe(finalMessage);
  });

  it("repairs tool arguments when malformed tool-call preamble appears before JSON", async () => {
    const partialToolCall = { type: "toolCall", name: "write", arguments: {} };
    const streamedToolCall = { type: "toolCall", name: "write", arguments: {} };
    const endMessageToolCall = { type: "toolCall", name: "write", arguments: {} };
    const finalToolCall = { type: "toolCall", name: "write", arguments: {} };
    const partialMessage = { role: "assistant", content: [partialToolCall] };
    const endMessage = { role: "assistant", content: [endMessageToolCall] };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: '.functions.write:8  \n{"path":"/tmp/report.txt"}',
            partial: partialMessage,
          },
          {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: streamedToolCall,
            partial: partialMessage,
            message: endMessage,
          },
        ],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const item of stream) {
      void item;
      // drain
    }
    const result = await stream.result();

    expect(partialToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(streamedToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(endMessageToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(finalToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(result).toBe(finalMessage);
  });
  it("preserves anthropic-compatible tool arguments when the streamed JSON is already valid", async () => {
    const partialToolCall = { type: "toolCall", name: "read", arguments: {} };
    const streamedToolCall = { type: "toolCall", name: "read", arguments: {} };
    const endMessageToolCall = { type: "toolCall", name: "read", arguments: {} };
    const finalToolCall = { type: "toolCall", name: "read", arguments: {} };
    const partialMessage = { role: "assistant", content: [partialToolCall] };
    const endMessage = { role: "assistant", content: [endMessageToolCall] };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: '{"path":"/tmp/report.txt"',
            partial: partialMessage,
          },
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: "}",
            partial: partialMessage,
          },
          {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: streamedToolCall,
            partial: partialMessage,
            message: endMessage,
          },
        ],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const item of stream) {
      void item;
      // drain
    }
    const result = await stream.result();

    expect(partialToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(streamedToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(endMessageToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(finalToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(result).toBe(finalMessage);
  });

  it("does not repair tool arguments when leading text is not tool-call metadata", async () => {
    const partialToolCall = { type: "toolCall", name: "read", arguments: {} };
    const streamedToolCall = { type: "toolCall", name: "read", arguments: {} };
    const partialMessage = { role: "assistant", content: [partialToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: 'please use {"path":"/tmp/report.txt"}',
            partial: partialMessage,
          },
          {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: streamedToolCall,
            partial: partialMessage,
          },
        ],
        resultMessage: { role: "assistant", content: [partialToolCall] },
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const item of stream) {
      void item;
      // drain
    }

    expect(partialToolCall.arguments).toStrictEqual({});
    expect(streamedToolCall.arguments).toStrictEqual({});
  });

  it("keeps incomplete partial JSON unchanged until a complete object exists", async () => {
    const partialToolCall = { type: "toolCall", name: "read", arguments: {} };
    const partialMessage = { role: "assistant", content: [partialToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: '{"path":"/tmp',
            partial: partialMessage,
          },
        ],
        resultMessage: { role: "assistant", content: [partialToolCall] },
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const item of stream) {
      void item;
      // drain
    }

    expect(partialToolCall.arguments).toStrictEqual({});
  });

  it("does not repair tool arguments when trailing junk exceeds the Kimi-specific allowance", async () => {
    const partialToolCall = { type: "toolCall", name: "read", arguments: {} };
    const streamedToolCall = { type: "toolCall", name: "read", arguments: {} };
    const partialMessage = { role: "assistant", content: [partialToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: '{"path":"/tmp/report.txt"}oops',
            partial: partialMessage,
          },
          {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: streamedToolCall,
            partial: partialMessage,
          },
        ],
        resultMessage: { role: "assistant", content: [partialToolCall] },
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const item of stream) {
      void item;
      // drain
    }

    expect(partialToolCall.arguments).toStrictEqual({});
    expect(streamedToolCall.arguments).toStrictEqual({});
  });

  it("clears a cached repair when later deltas make the trailing suffix invalid", async () => {
    const partialToolCall = { type: "toolCall", name: "read", arguments: {} };
    const streamedToolCall = { type: "toolCall", name: "read", arguments: {} };
    const partialMessage = { role: "assistant", content: [partialToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: '{"path":"/tmp/report.txt"}',
            partial: partialMessage,
          },
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: "x",
            partial: partialMessage,
          },
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: "yzq",
            partial: partialMessage,
          },
          {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: streamedToolCall,
            partial: partialMessage,
          },
        ],
        resultMessage: { role: "assistant", content: [partialToolCall] },
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const item of stream) {
      void item;
      // drain
    }

    expect(partialToolCall.arguments).toStrictEqual({});
    expect(streamedToolCall.arguments).toStrictEqual({});
  });

  it("clears a cached repair when a later delta adds a single oversized trailing suffix", async () => {
    const partialToolCall = { type: "toolCall", name: "read", arguments: {} };
    const streamedToolCall = { type: "toolCall", name: "read", arguments: {} };
    const partialMessage = { role: "assistant", content: [partialToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: '{"path":"/tmp/report.txt"}',
            partial: partialMessage,
          },
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: "oops",
            partial: partialMessage,
          },
          {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: streamedToolCall,
            partial: partialMessage,
          },
        ],
        resultMessage: { role: "assistant", content: [partialToolCall] },
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const item of stream) {
      void item;
      // drain
    }

    expect(partialToolCall.arguments).toStrictEqual({});
    expect(streamedToolCall.arguments).toStrictEqual({});
  });

  it("preserves preexisting tool arguments when later reevaluation fails", async () => {
    const partialToolCall = {
      type: "toolCall",
      name: "read",
      arguments: { path: "/etc/hosts" },
    };
    const streamedToolCall = { type: "toolCall", name: "read", arguments: {} };
    const partialMessage = { role: "assistant", content: [partialToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: "}",
            partial: partialMessage,
          },
          {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: streamedToolCall,
            partial: partialMessage,
          },
        ],
        resultMessage: { role: "assistant", content: [partialToolCall] },
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const item of stream) {
      void item;
      // drain
    }

    expect(partialToolCall.arguments).toEqual({ path: "/etc/hosts" });
    expect(streamedToolCall.arguments).toStrictEqual({});
  });
});

describe("prependSystemPromptAddition", () => {
  it("prepends context-engine addition to the system prompt", () => {
    const result = prependSystemPromptAddition({
      systemPrompt: "base system",
      systemPromptAddition: "extra behavior",
    });

    expect(result).toBe("extra behavior\n\nbase system");
  });

  it("returns the original system prompt when no addition is provided", () => {
    const result = prependSystemPromptAddition({
      systemPrompt: "base system",
    });

    expect(result).toBe("base system");
  });
});

describe("buildAfterTurnRuntimeContext", () => {
  it("preserves sessionId-scoped active process sessions for after-turn context", () => {
    resetProcessRegistryForTests();
    try {
      const active = createProcessSessionFixture({
        id: "sess-session-id",
        command: "sleep 600",
        backgrounded: true,
        pid: 1234,
      });
      active.scopeKey = "session-123";
      addSession(active);
      const other = createProcessSessionFixture({
        id: "sess-other",
        command: "sleep 600",
        backgrounded: true,
      });
      other.scopeKey = "agent:main";
      addSession(other);

      const legacy = buildAfterTurnRuntimeContext({
        attempt: {
          sessionId: "session-123",
          config: {} as OpenClawConfig,
          skillsSnapshot: undefined,
          provider: "openai",
          modelId: "gpt-5.4",
          thinkLevel: "off",
          reasoningLevel: "on",
          extraSystemPrompt: "extra",
          ownerNumbers: ["+15555550123"],
        },
        workspaceDir: "/tmp/workspace",
        agentDir: "/tmp/agent",
        activeAgentId: "main",
      });

      const activeProcessSessions = legacy.activeProcessSessions as
        | Array<{ sessionId?: string; command?: string; pid?: number }>
        | undefined;
      expect(activeProcessSessions).toHaveLength(1);
      const activeSession = requireRecord(activeProcessSessions?.[0], "active process session");
      expect(activeSession.sessionId).toBe("sess-session-id");
      expect(activeSession.command).toBe("sleep 600");
      expect(activeSession.pid).toBe(1234);
      expect(activeProcessSessions?.some((session) => session.sessionId === "sess-other")).toBe(
        false,
      );
      expect(legacy.transcriptStorage).toEqual({ kind: "sqlite" });
    } finally {
      resetProcessRegistryForTests();
    }
  });

  it("uses primary model when compaction.model is not set", () => {
    const runtimeAuthPlan = {
      providerForAuth: "openai",
      authProfileProviderForAuth: "openai",
      harnessAuthProvider: "openai",
      forwardedAuthProfileId: "openai:p1",
      forwardedAuthProfileSource: "user" as const,
      modelRoute: {
        provider: "openai",
        modelId: "gpt-5.4",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authRequirement: "subscription" as const,
        requestTransportOverrides: "none" as const,
      },
    };
    const legacy = buildAfterTurnRuntimeContext({
      attempt: {
        sessionKey: "agent:main:session:abc",
        messageChannel: "slack",
        messageProvider: "slack",
        agentAccountId: "acct-1",
        authProfileId: "openai:p1",
        authProfileIdSource: "user",
        runtimePlan: { auth: runtimeAuthPlan } as never,
        config: {} as OpenClawConfig,
        skillsSnapshot: undefined,
        provider: "openai",
        modelId: "gpt-5.4",
        thinkLevel: "off",
        reasoningLevel: "on",
        extraSystemPrompt: "extra",
        ownerNumbers: ["+15555550123"],
      },
      workspaceDir: "/tmp/workspace",
      cwd: "/tmp/task-repo",
      agentDir: "/tmp/agent",
    });

    expect(legacy.provider).toBe("openai");
    expect(legacy.model).toBe("gpt-5.4");
    expect(legacy.authProfileIdSource).toBe("user");
    expect(legacy.runtimeAuthPlan).toBe(runtimeAuthPlan);
  });

  it("keeps the primary model for a locked after-turn runtime context", () => {
    const runtimeContext = buildAfterTurnRuntimeContext({
      attempt: {
        sessionKey: "agent:main:session:locked",
        config: {
          agents: { defaults: { compaction: { model: "anthropic/claude-opus-4-6" } } },
        } as OpenClawConfig,
        skillsSnapshot: undefined,
        provider: "openai",
        modelId: "gpt-5.5",
        agentHarnessId: "openclaw",
        modelSelectionLocked: true,
        thinkLevel: "off",
      },
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
    });

    expect(runtimeContext.modelSelectionLocked).toBe(true);
    expect(runtimeContext.provider).toBe("openai");
    expect(runtimeContext.model).toBe("gpt-5.5");
  });

  it("publishes the storage-neutral session target in runtime context", () => {
    const sessionTarget = {
      agentId: "main",
      sessionId: "session-abc",
      sessionKey: "agent:main:session:abc",
      storePath: "/tmp/state/agents/main/sessions/sessions.json",
      threadId: 42,
    };

    const runtimeContext = buildAfterTurnRuntimeContext({
      attempt: {
        sessionId: "ignored-session-id",
        sessionKey: "agent:main:fallback",
        sessionTarget,
        config: {} as OpenClawConfig,
        skillsSnapshot: undefined,
        provider: "openai",
        modelId: "gpt-5.4",
        thinkLevel: "off",
        reasoningLevel: "on",
      },
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
      activeAgentId: "main",
    });

    expect(runtimeContext.transcriptStorage).toEqual({ kind: "sqlite" });
    expect(runtimeContext.sessionTarget).toEqual(sessionTarget);
  });
  it("resolves compaction.model override in runtime context so all context engines use the correct model", () => {
    const legacy = buildAfterTurnRuntimeContext({
      attempt: {
        sessionKey: "agent:main:session:abc",
        messageChannel: "slack",
        messageProvider: "slack",
        agentAccountId: "acct-1",
        authProfileId: "openai:p1",
        config: {
          agents: {
            defaults: {
              models: {
                "openrouter/anthropic/claude-sonnet-4-5": {
                  alias: "summary",
                },
              },
              compaction: {
                model: "summary",
              },
            },
          },
        } as OpenClawConfig,
        skillsSnapshot: undefined,
        provider: "openai",
        modelId: "gpt-5.4",
        thinkLevel: "off",
        reasoningLevel: "on",
        extraSystemPrompt: "extra",
        ownerNumbers: ["+15555550123"],
      },
      workspaceDir: "/tmp/workspace",
      cwd: "/tmp/task-repo",
      agentDir: "/tmp/agent",
    });

    // Resolve aliases before handing runtime context to any context engine;
    // otherwise third-party engines can dispatch the bare alias as a model id.
    expect(legacy.provider).toBe("openrouter");
    expect(legacy.model).toBe("anthropic/claude-sonnet-4-5");
    // Auth profile dropped because provider changed from openai to openrouter.
    expect(legacy.authProfileId).toBeUndefined();
  });
  it("includes resolved auth profile fields for context-engine afterTurn compaction", () => {
    const promptCache = buildContextEnginePromptCacheInfo({
      lastCallUsage: {
        input: 10,
        output: 5,
        cacheRead: 40,
        cacheWrite: 2,
        total: 57,
      },
    });
    const legacy = buildAfterTurnRuntimeContext({
      attempt: {
        sessionKey: "agent:main:session:abc",
        messageChannel: "slack",
        messageProvider: "slack",
        agentAccountId: "acct-1",
        authProfileId: "openai:p1",
        config: { plugins: { slots: { contextEngine: "lossless-claw" } } } as OpenClawConfig,
        skillsSnapshot: undefined,
        provider: "openai",
        modelId: "gpt-5.4",
        thinkLevel: "off",
        reasoningLevel: "on",
        extraSystemPrompt: "extra",
        ownerNumbers: ["+15555550123"],
      },
      workspaceDir: "/tmp/workspace",
      cwd: "/tmp/task-repo",
      agentDir: "/tmp/agent",
      tokenBudget: 1050000,
      currentTokenCount: 52,
      promptCache,
    });

    expect(legacy.authProfileId).toBe("openai:p1");
    expect(legacy.provider).toBe("openai");
    expect(legacy.model).toBe("gpt-5.4");
    expect(legacy.workspaceDir).toBe("/tmp/workspace");
    expect(legacy.cwd).toBe("/tmp/task-repo");
    expect(legacy.agentDir).toBe("/tmp/agent");
    expect(legacy.tokenBudget).toBe(1050000);
    expect(legacy.currentTokenCount).toBe(52);
    expect(legacy.promptCache?.lastCallUsage?.total).toBe(57);
  });

  it("derives afterTurn token count from the current assistant usage snapshot", () => {
    const lastCallUsage = {
      input: 10,
      output: 5,
      cacheRead: 40,
      cacheWrite: 2,
      contextUsage: {
        state: "available",
        promptTokens: 23,
        totalTokens: 28,
      },
      total: 57,
    } satisfies NormalizedUsage;
    const promptCache = buildContextEnginePromptCacheInfo({ lastCallUsage });
    const legacy = buildAfterTurnRuntimeContextFromUsage({
      attempt: {
        sessionKey: "agent:main:session:abc",
        messageChannel: "slack",
        messageProvider: "slack",
        agentAccountId: "acct-1",
        authProfileId: "openai:p1",
        config: { plugins: { slots: { contextEngine: "lossless-claw" } } } as OpenClawConfig,
        skillsSnapshot: undefined,
        provider: "openai",
        modelId: "gpt-5.4",
        thinkLevel: "off",
        reasoningLevel: "on",
        extraSystemPrompt: "extra",
        ownerNumbers: ["+15555550123"],
      },
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
      tokenBudget: 1050000,
      lastCallUsage,
      promptCache,
    });

    expect(legacy.currentTokenCount).toBe(23);
    expect(legacy.promptCache?.lastCallUsage?.total).toBe(57);
  });

  it("preserves sender and channel routing context for scoped compaction discovery", () => {
    const legacy = buildAfterTurnRuntimeContext({
      attempt: {
        sessionKey: "agent:main:session:abc",
        messageChannel: "slack",
        messageProvider: "slack",
        agentAccountId: "acct-1",
        currentChannelId: "C123",
        currentThreadTs: "thread-9",
        currentMessageId: "msg-42",
        authProfileId: "openai:p1",
        config: {} as OpenClawConfig,
        skillsSnapshot: undefined,
        senderId: "user-123",
        provider: "openai",
        modelId: "gpt-5.4",
        thinkLevel: "off",
        reasoningLevel: "on",
        extraSystemPrompt: "extra",
        ownerNumbers: ["+15555550123"],
      },
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
    });

    expect(legacy.senderId).toBe("user-123");
    expect(legacy.currentChannelId).toBe("C123");
    expect(legacy.currentThreadTs).toBe("thread-9");
    expect(legacy.currentMessageId).toBe("msg-42");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
