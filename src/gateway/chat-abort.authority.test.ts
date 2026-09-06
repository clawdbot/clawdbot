import { beforeEach, expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
  validateAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { abortChatRunById, registerChatAbortController, type ChatAbortOps } from "./chat-abort.js";
import type { ChatAbortControllerEntry } from "./chat-abort.types.js";
import { createChatRunState } from "./server-chat-state.js";

beforeEach(() => {
  resetAgentRunRegistryForTest();
});

function createAuthorityAbortFixture(runId: string) {
  const sessionKey = "agent:main:authority";
  const operationalRunInstance = createOperationalRunInstanceRef(runId);
  const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
  const registration = registerChatAbortController({
    chatAbortControllers,
    runId,
    sessionId: `session-${runId}`,
    sessionKey,
    timeoutMs: 60_000,
    operationalRunInstance,
  });
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  registration.bindAgentRunDelegatedAuthority(authority);
  const ops: ChatAbortOps = {
    chatAbortControllers,
    chatRunState: createChatRunState(),
    removeChatRun: vi.fn(() => undefined),
    agentRunSeq: new Map(),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
  };
  return { authority, operationalRunInstance, ops, registration, runId, sessionKey };
}

it("binds delegated authority only to the exact operational instance object", () => {
  const { authority, operationalRunInstance, registration } =
    createAuthorityAbortFixture("run-exact-authority");

  expect(registration.entry?.agentRunDelegatedAuthority).toBe(authority);
  expect(registration.entry?.operationalRunInstance).toBe(operationalRunInstance);
  expect(() =>
    registration.bindAgentRunDelegatedAuthority({
      ...authority,
      operationalRunInstance: Object.freeze({ ...operationalRunInstance }),
    }),
  ).toThrow("does not belong to this controller registration");

  registration.cleanup();
  expect(validateAgentRunDelegatedAuthority(authority)).toBe(false);
});

it("leaves sessionless authority with the outer admission owner", () => {
  const runId = "run-sessionless-authority";
  const operationalRunInstance = createOperationalRunInstanceRef(runId);
  const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
  const registration = registerChatAbortController({
    chatAbortControllers,
    runId,
    sessionId: `session-${runId}`,
    timeoutMs: 60_000,
    operationalRunInstance,
  });
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  const unrelatedInstance = createOperationalRunInstanceRef("run-unrelated-authority");
  const unrelatedAuthority = claimAgentRunDelegatedAuthority(unrelatedInstance);

  expect(registration.registered).toBe(false);
  expect(chatAbortControllers).toHaveLength(0);
  expect(() => registration.bindAgentRunDelegatedAuthority(authority)).toThrow(
    "does not belong to this controller registration",
  );
  expect(() => registration.bindAgentRunDelegatedAuthority(unrelatedAuthority)).toThrow(
    "does not belong to this controller registration",
  );

  registration.cleanup();
  expect(validateAgentRunDelegatedAuthority(authority)).toBe(true);
  expect(validateAgentRunDelegatedAuthority(unrelatedAuthority)).toBe(true);
  expect(releaseAgentRunDelegatedAuthority(authority)).toBe(true);
  expect(releaseAgentRunDelegatedAuthority(unrelatedAuthority)).toBe(true);
});

it("revokes exact delegated authority before abort callbacks and controller listeners", () => {
  const { authority, ops, registration, runId, sessionKey } =
    createAuthorityAbortFixture("run-authority-abort");
  const entry = registration.entry!;
  ops.onRunAborted = vi.fn(() => {
    expect(validateAgentRunDelegatedAuthority(authority)).toBe(false);
    expect(entry.controller.signal.aborted).toBe(false);
  });

  expect(abortChatRunById(ops, { runId, sessionKey, stopReason: "user" })).toEqual({
    aborted: true,
  });
  expect(ops.onRunAborted).toHaveBeenCalledOnce();
  expect(entry.controller.signal.aborted).toBe(true);
});

it("does not revoke a same-id successor from a stale abort controller", () => {
  const { ops, runId, sessionKey } = createAuthorityAbortFixture("run-authority-successor");
  const successorInstance = createOperationalRunInstanceRef(runId);
  const successor = claimAgentRunDelegatedAuthority(successorInstance);

  expect(abortChatRunById(ops, { runId, sessionKey, stopReason: "stale" })).toEqual({
    aborted: true,
  });
  expect(validateAgentRunDelegatedAuthority(successor)).toBe(true);
  expect(releaseAgentRunDelegatedAuthority(successor)).toBe(true);
});
