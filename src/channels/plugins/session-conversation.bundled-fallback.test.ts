import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";

const fallbackState = vi.hoisted(() => ({
  activeDirName: null as string | null,
  loadCalls: 0,
  resolveSessionConversation: null as
    | ((params: { kind: "group" | "channel"; rawId: string }) => {
        id: string;
        threadId?: string | null;
        baseConversationId?: string | null;
        parentConversationCandidates?: string[];
      } | null)
    | null,
}));

vi.mock("../../plugin-sdk/facade-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../plugin-sdk/facade-runtime.js")>(
    "../../plugin-sdk/facade-runtime.js",
  );
  return {
    ...actual,
    tryLoadActivatedBundledPluginPublicSurfaceModuleSync: ({ dirName }: { dirName: string }) => {
      fallbackState.loadCalls += 1;
      return dirName === fallbackState.activeDirName && fallbackState.resolveSessionConversation
        ? { resolveSessionConversation: fallbackState.resolveSessionConversation }
        : null;
    },
  };
});

import { resolveSessionConversationRef, resolveSessionThreadInfo } from "./session-conversation.js";

type ResolveSessionConversation = NonNullable<typeof fallbackState.resolveSessionConversation>;

function enableBundledFallback(
  dirName: string,
  resolveSessionConversation: ResolveSessionConversation,
) {
  fallbackState.activeDirName = dirName;
  fallbackState.resolveSessionConversation = resolveSessionConversation;
  setRuntimeConfigSnapshot({
    plugins: {
      entries: {
        [dirName]: {
          enabled: true,
        },
      },
    },
  });
}

function enableThreadedFallback() {
  enableBundledFallback("mock-threaded", ({ rawId }) => {
    const [conversationId, threadId] = rawId.split(":topic:");
    return {
      id: conversationId,
      threadId,
      baseConversationId: conversationId,
      parentConversationCandidates: [conversationId],
    };
  });
}

describe("session conversation bundled fallback", () => {
  beforeEach(() => {
    fallbackState.activeDirName = null;
    fallbackState.loadCalls = 0;
    fallbackState.resolveSessionConversation = null;
    resetPluginRuntimeStateForTest();
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  it("delegates pre-bootstrap thread parsing to the active bundled channel plugin", () => {
    enableThreadedFallback();

    expect(resolveSessionConversationRef("agent:main:mock-threaded:group:room:topic:42")).toEqual({
      channel: "mock-threaded",
      kind: "group",
      rawId: "room:topic:42",
      id: "room",
      threadId: "42",
      baseSessionKey: "agent:main:mock-threaded:group:room",
      baseConversationId: "room",
      parentConversationCandidates: ["room"],
    });
  });

  it("can skip bundled fallback probing for hot generic-only callers", () => {
    enableThreadedFallback();

    expect(
      resolveSessionConversationRef("agent:main:mock-threaded:group:room:topic:42", {
        bundledFallback: false,
      }),
    ).toEqual({
      channel: "mock-threaded",
      kind: "group",
      rawId: "room:topic:42",
      id: "room:topic:42",
      threadId: undefined,
      baseSessionKey: "agent:main:mock-threaded:group:room:topic:42",
      baseConversationId: "room:topic:42",
      parentConversationCandidates: [],
    });
    expect(
      resolveSessionThreadInfo("agent:main:mock-threaded:group:room:topic:42", {
        bundledFallback: false,
      }),
    ).toEqual({
      baseSessionKey: "agent:main:mock-threaded:group:room:topic:42",
      threadId: undefined,
    });
  });

  it("uses explicit bundled parent candidates before registry bootstrap", () => {
    enableBundledFallback("mock-parent", ({ rawId }) => ({
      id: rawId,
      baseConversationId: "room",
      parentConversationCandidates: ["room:topic:root", "room"],
    }));

    expect(
      resolveSessionConversationRef("agent:main:mock-parent:group:room:topic:root:sender:user"),
    ).toEqual({
      channel: "mock-parent",
      kind: "group",
      rawId: "room:topic:root:sender:user",
      id: "room:topic:root:sender:user",
      threadId: undefined,
      baseSessionKey: "agent:main:mock-parent:group:room:topic:root:sender:user",
      baseConversationId: "room",
      parentConversationCandidates: ["room:topic:root", "room"],
    });
  });

  it("reuses the bundled fallback loader result across repeated calls", () => {
    enableThreadedFallback();

    expect(resolveSessionConversationRef("agent:main:mock-threaded:group:room:topic:42")).toEqual(
      expect.objectContaining({
        channel: "mock-threaded",
        id: "room",
        threadId: "42",
      }),
    );
    expect(resolveSessionConversationRef("agent:main:mock-threaded:group:room:topic:43")).toEqual(
      expect.objectContaining({
        channel: "mock-threaded",
        id: "room",
        threadId: "43",
      }),
    );
    expect(fallbackState.loadCalls).toBe(1);
  });
});
