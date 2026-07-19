/** Tests ACP turn terminal results and detached-task progress outcomes. */
import type { AcpRuntimeEvent } from "@openclaw/acp-core/runtime/types";
import { describe, expect, it, vi } from "vitest";
import {
  requireTaskByRunId,
  withAcpManagerTaskStateDir,
} from "../../../test/helpers/acp-manager-task-state.js";
import {
  AcpRuntimeError,
  AcpSessionManager,
  baseCfg,
  createRuntime,
  expectRecordFields,
  expectRejectedRecord,
  extractStatesFromUpserts,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockParentedAcpSessionEntries,
  mockCallArg,
  readySessionMeta,
  resetAcpSessionManagerForTests,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

describe("AcpSessionManager turn results", () => {
  installAcpSessionManagerTestLifecycle();

  it("uses startTurn terminal results instead of progress-only events for parented tasks", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const runtimeState = createRuntime();
      const closeStream = vi.fn(async () => {});
      runtimeState.runtime.startTurn = vi.fn((input) => ({
        requestId: input.requestId,
        events: (async function* () {
          yield {
            type: "text_delta" as const,
            stream: "output" as const,
            text: "Vou mapear o fluxo real primeiro...",
          };
        })(),
        result: Promise.resolve({
          status: "failed" as const,
          error: {
            code: "ACP_TURN_FAILED",
            message: "Codex ACP adapter exited before final output.",
          },
        }),
        cancel: vi.fn(async () => {}),
        closeStream,
      }));
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
        const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey;
        if (sessionKey === "agent:codex:acp:child-1") {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: {
              sessionId: "child-1",
              updatedAt: Date.now(),
              spawnedBy: "agent:quant:telegram:quant:direct:822430204",
              label: "Codex investigation",
            },
            acp: readySessionMeta(),
          };
        }
        if (sessionKey === "agent:quant:telegram:quant:direct:822430204") {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: {
              sessionId: "parent-1",
              updatedAt: Date.now(),
            },
          };
        }
        return null;
      });

      const events: string[] = [];
      const manager = new AcpSessionManager();
      await expect(
        manager.runTurn({
          provenance: "system",
          cfg: baseCfg,
          sessionKey: "agent:codex:acp:child-1",
          text: "Investigate and report back",
          mode: "prompt",
          requestId: "direct-parented-progress-only-run",
          onEvent: (event) => {
            events.push(event.type);
          },
        }),
      ).rejects.toMatchObject({
        code: "ACP_TURN_FAILED",
        message: "Codex ACP adapter exited before final output.",
      });

      expect(runtimeState.runTurn).not.toHaveBeenCalled();
      expect(closeStream).toHaveBeenCalledWith({ reason: "turn-result-failed" });
      expect(events).toEqual(["text_delta", "error"]);
      expectRecordFields(requireTaskByRunId("direct-parented-progress-only-run"), {
        runtime: "acp",
        ownerKey: "agent:quant:telegram:quant:direct:822430204",
        scopeKind: "session",
        childSessionKey: "agent:codex:acp:child-1",
        label: "Codex investigation",
        task: "Investigate and report back",
        status: "failed",
        progressSummary: "Vou mapear o fluxo real primeiro...",
        error: "AcpRuntimeError [ACP_TURN_FAILED]: Codex ACP adapter exited before final output.",
      });
    });
  });

  it("keeps valid startTurn text-only completions successful", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const runtimeState = createRuntime();
      runtimeState.runtime.startTurn = vi.fn((input) => ({
        requestId: input.requestId,
        events: (async function* () {
          yield {
            type: "text_delta" as const,
            stream: "output" as const,
            text: "Current directory is /tmp/openclaw.",
          };
        })(),
        result: Promise.resolve({
          status: "completed" as const,
          stopReason: "end_turn",
        }),
        cancel: vi.fn(async () => {}),
        closeStream: vi.fn(async () => {}),
      }));
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
        const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey;
        if (sessionKey === "agent:codex:acp:child-1") {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: {
              sessionId: "child-1",
              updatedAt: Date.now(),
              spawnedBy: "agent:quant:telegram:quant:direct:822430204",
              label: "Directory check",
            },
            acp: readySessionMeta(),
          };
        }
        if (sessionKey === "agent:quant:telegram:quant:direct:822430204") {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: {
              sessionId: "parent-1",
              updatedAt: Date.now(),
            },
          };
        }
        return null;
      });

      const events: string[] = [];
      const manager = new AcpSessionManager();
      await manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:child-1",
        text: "Print the current directory",
        mode: "prompt",
        requestId: "direct-parented-start-turn-text-run",
        onEvent: (event) => {
          events.push(event.type);
        },
      });

      expect(runtimeState.runTurn).not.toHaveBeenCalled();
      expect(events).toEqual(["text_delta", "done"]);
      expectRecordFields(requireTaskByRunId("direct-parented-start-turn-text-run"), {
        runtime: "acp",
        ownerKey: "agent:quant:telegram:quant:direct:822430204",
        scopeKind: "session",
        childSessionKey: "agent:codex:acp:child-1",
        label: "Directory check",
        task: "Print the current directory",
        status: "succeeded",
        progressSummary: "Current directory is /tmp/openclaw.",
      });
    });
  });

  it("keeps parented ACP turns successful when final output follows progress text", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const runtimeState = createRuntime();
      runtimeState.runtime.startTurn = vi.fn((input) => ({
        requestId: input.requestId,
        events: (async function* () {
          yield {
            type: "text_delta" as const,
            stream: "output" as const,
            text: "I'll inspect the repo now. ",
          };
          yield {
            type: "text_delta" as const,
            stream: "output" as const,
            text: "The crash is a missing null check in src/foo.ts.",
          };
        })(),
        result: Promise.resolve({
          status: "completed" as const,
          stopReason: "end_turn",
        }),
        cancel: vi.fn(async () => {}),
        closeStream: vi.fn(async () => {}),
      }));
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
        const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey;
        if (sessionKey === "agent:codex:acp:child-1") {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: {
              sessionId: "child-1",
              updatedAt: Date.now(),
              spawnedBy: "agent:quant:telegram:quant:direct:822430204",
              label: "Progress then final",
            },
            acp: readySessionMeta(),
          };
        }
        if (sessionKey === "agent:quant:telegram:quant:direct:822430204") {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: {
              sessionId: "parent-1",
              updatedAt: Date.now(),
            },
          };
        }
        return null;
      });

      const manager = new AcpSessionManager();
      await manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:child-1",
        text: "Inspect and report back",
        mode: "prompt",
        requestId: "direct-parented-progress-then-final-run",
      });

      const record = requireTaskByRunId("direct-parented-progress-then-final-run");
      expectRecordFields(record, {
        runtime: "acp",
        ownerKey: "agent:quant:telegram:quant:direct:822430204",
        scopeKind: "session",
        childSessionKey: "agent:codex:acp:child-1",
        status: "succeeded",
        progressSummary:
          "I'll inspect the repo now. The crash is a missing null check in src/foo.ts.",
      });
      expect(record.terminalOutcome).toBeUndefined();
      expect(record.terminalSummary).toBeUndefined();
    });
  });

  it("keeps parented ACP turns successful when final output follows a separator", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const runtimeState = createRuntime();
      runtimeState.runtime.startTurn = vi.fn((input) => ({
        requestId: input.requestId,
        events: (async function* () {
          yield {
            type: "text_delta" as const,
            stream: "output" as const,
            text: "I'll inspect the repo now: the crash is a missing null check in src/foo.ts.",
          };
        })(),
        result: Promise.resolve({
          status: "completed" as const,
          stopReason: "end_turn",
        }),
        cancel: vi.fn(async () => {}),
        closeStream: vi.fn(async () => {}),
      }));
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
        const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey;
        if (sessionKey === "agent:codex:acp:child-1") {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: {
              sessionId: "child-1",
              updatedAt: Date.now(),
              spawnedBy: "agent:quant:telegram:quant:direct:822430204",
              label: "Separator final",
            },
            acp: readySessionMeta(),
          };
        }
        if (sessionKey === "agent:quant:telegram:quant:direct:822430204") {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: {
              sessionId: "parent-1",
              updatedAt: Date.now(),
            },
          };
        }
        return null;
      });

      const manager = new AcpSessionManager();
      await manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:child-1",
        text: "Inspect and report back",
        mode: "prompt",
        requestId: "direct-parented-separator-final-run",
      });

      const record = requireTaskByRunId("direct-parented-separator-final-run");
      expectRecordFields(record, {
        runtime: "acp",
        ownerKey: "agent:quant:telegram:quant:direct:822430204",
        scopeKind: "session",
        childSessionKey: "agent:codex:acp:child-1",
        status: "succeeded",
        progressSummary:
          "I'll inspect the repo now: the crash is a missing null check in src/foo.ts.",
      });
      expect(record.terminalOutcome).toBeUndefined();
      expect(record.terminalSummary).toBeUndefined();
    });
  });

  it("keeps parented ACP turns blocked when progress text only adds follow-up planning", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const runtimeState = createRuntime();
      runtimeState.runtime.startTurn = vi.fn((input) => ({
        requestId: input.requestId,
        events: (async function* () {
          yield {
            type: "text_delta" as const,
            stream: "output" as const,
            text: "I'll inspect the repo now. Then I'll run tests and report back.",
          };
        })(),
        result: Promise.resolve({
          status: "completed" as const,
          stopReason: "end_turn",
        }),
        cancel: vi.fn(async () => {}),
        closeStream: vi.fn(async () => {}),
      }));
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
        const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey;
        if (sessionKey === "agent:codex:acp:child-1") {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: {
              sessionId: "child-1",
              updatedAt: Date.now(),
              spawnedBy: "agent:quant:telegram:quant:direct:822430204",
              label: "Follow-up planning",
            },
            acp: readySessionMeta(),
          };
        }
        if (sessionKey === "agent:quant:telegram:quant:direct:822430204") {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: {
              sessionId: "parent-1",
              updatedAt: Date.now(),
            },
          };
        }
        return null;
      });

      const manager = new AcpSessionManager();
      await manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:child-1",
        text: "Inspect and report back",
        mode: "prompt",
        requestId: "direct-parented-followup-planning-run",
      });

      expectRecordFields(requireTaskByRunId("direct-parented-followup-planning-run"), {
        runtime: "acp",
        ownerKey: "agent:quant:telegram:quant:direct:822430204",
        scopeKind: "session",
        childSessionKey: "agent:codex:acp:child-1",
        status: "succeeded",
        progressSummary: "I'll inspect the repo now. Then I'll run tests and report back.",
        terminalOutcome: "blocked",
        terminalSummary:
          "Required completion ended with progress-only text, not a final deliverable.",
      });
    });
  });

  it("marks completed parented ACP turns blocked when they only contain progress text", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const runtimeState = createRuntime();
      runtimeState.runtime.startTurn = vi.fn((input) => ({
        requestId: input.requestId,
        events: (async function* () {
          yield {
            type: "text_delta" as const,
            stream: "output" as const,
            text: "I'll inspect the repo now.",
          };
        })(),
        result: Promise.resolve({
          status: "completed" as const,
          stopReason: "end_turn",
        }),
        cancel: vi.fn(async () => {}),
        closeStream: vi.fn(async () => {}),
      }));
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
        const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey;
        if (sessionKey === "agent:codex:acp:child-1") {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: {
              sessionId: "child-1",
              updatedAt: Date.now(),
              spawnedBy: "agent:quant:telegram:quant:direct:822430204",
              label: "Progress only",
            },
            acp: readySessionMeta(),
          };
        }
        if (sessionKey === "agent:quant:telegram:quant:direct:822430204") {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: {
              sessionId: "parent-1",
              updatedAt: Date.now(),
            },
          };
        }
        return null;
      });

      const events: string[] = [];
      const manager = new AcpSessionManager();
      await manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:child-1",
        text: "Inspect and report back",
        mode: "prompt",
        requestId: "direct-parented-progress-completed-run",
        onEvent: (event) => {
          events.push(event.type);
        },
      });

      expect(events).toEqual(["text_delta", "done"]);
      expectRecordFields(requireTaskByRunId("direct-parented-progress-completed-run"), {
        runtime: "acp",
        ownerKey: "agent:quant:telegram:quant:direct:822430204",
        scopeKind: "session",
        childSessionKey: "agent:codex:acp:child-1",
        status: "succeeded",
        progressSummary: "I'll inspect the repo now.",
        terminalOutcome: "blocked",
        terminalSummary:
          "Required completion ended with progress-only text, not a final deliverable.",
      });
    });
  });

  it("marks completed parented ACP turns blocked when final output is missing", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const runtimeState = createRuntime();
      runtimeState.runtime.startTurn = vi.fn((input) => ({
        requestId: input.requestId,
        events: (async function* () {})(),
        result: Promise.resolve({
          status: "completed" as const,
          stopReason: "end_turn",
        }),
        cancel: vi.fn(async () => {}),
        closeStream: vi.fn(async () => {}),
      }));
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
        const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey;
        if (sessionKey === "agent:codex:acp:child-1") {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: {
              sessionId: "child-1",
              updatedAt: Date.now(),
              spawnedBy: "agent:quant:telegram:quant:direct:822430204",
              label: "Missing final",
            },
            acp: readySessionMeta(),
          };
        }
        if (sessionKey === "agent:quant:telegram:quant:direct:822430204") {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: {
              sessionId: "parent-1",
              updatedAt: Date.now(),
            },
          };
        }
        return null;
      });

      const events: string[] = [];
      const manager = new AcpSessionManager();
      await manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:child-1",
        text: "Produce a final result",
        mode: "prompt",
        requestId: "direct-parented-empty-completed-run",
        onEvent: (event) => {
          events.push(event.type);
        },
      });

      expect(events).toEqual(["done"]);
      expectRecordFields(requireTaskByRunId("direct-parented-empty-completed-run"), {
        runtime: "acp",
        ownerKey: "agent:quant:telegram:quant:direct:822430204",
        scopeKind: "session",
        childSessionKey: "agent:codex:acp:child-1",
        status: "succeeded",
        terminalOutcome: "blocked",
        terminalSummary: "Required completion did not produce a final deliverable.",
      });
    });
  });

  it("closes completed startTurn streams after draining queued output", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const runtimeState = createRuntime();
      let closed = false;
      const closeStream = vi.fn(async () => {
        closed = true;
      });
      runtimeState.runtime.startTurn = vi.fn((input) => ({
        requestId: input.requestId,
        events: (async function* () {
          await Promise.resolve();
          if (closed) {
            return;
          }
          yield {
            type: "text_delta" as const,
            stream: "output" as const,
            text: "completed progress",
          };
          for (;;) {
            if (closed) {
              return;
            }
            await new Promise((resolve) => {
              setTimeout(resolve, 1);
            });
          }
        })(),
        result: Promise.resolve({
          status: "completed" as const,
          stopReason: "end_turn",
        }),
        cancel: vi.fn(async () => {}),
        closeStream,
      }));
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
        const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey;
        if (sessionKey === "agent:codex:acp:child-1") {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: {
              sessionId: "child-1",
              updatedAt: Date.now(),
              spawnedBy: "agent:quant:telegram:quant:direct:822430204",
              label: "Completed drain",
            },
            acp: readySessionMeta(),
          };
        }
        if (sessionKey === "agent:quant:telegram:quant:direct:822430204") {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: {
              sessionId: "parent-1",
              updatedAt: Date.now(),
            },
          };
        }
        return null;
      });

      const events: string[] = [];
      const manager = new AcpSessionManager();
      await manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:child-1",
        text: "Investigate and report back",
        mode: "prompt",
        requestId: "direct-parented-completed-drain-run",
        onEvent: (event) => {
          events.push(event.type);
        },
      });

      expect(closeStream).toHaveBeenCalledWith({ reason: "turn-result-completed" });
      expect(events).toEqual(["text_delta", "done"]);
      expectRecordFields(requireTaskByRunId("direct-parented-completed-drain-run"), {
        status: "succeeded",
        progressSummary: "completed progress",
      });
    });
  });

  it("keeps startTurn cancelled results as non-error terminal turns", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const runtimeState = createRuntime();
      const closeStream = vi.fn(async () => {});
      runtimeState.runtime.startTurn = vi.fn((input) => ({
        requestId: input.requestId,
        events: (async function* () {
          yield { type: "text_delta" as const, stream: "output" as const, text: "stopping" };
        })(),
        result: Promise.resolve({
          status: "cancelled" as const,
        }),
        cancel: vi.fn(async () => {}),
        closeStream,
      }));
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      mockParentedAcpSessionEntries({
        childSessionKey: "agent:codex:acp:child-1",
        parentSessionKey: "agent:main:main",
      });

      const events: AcpRuntimeEvent[] = [];
      const manager = new AcpSessionManager();
      await manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:child-1",
        text: "long task",
        mode: "prompt",
        requestId: "run-1",
        onEvent: (event) => {
          events.push(event);
        },
      });

      expect(runtimeState.runTurn).not.toHaveBeenCalled();
      expect(closeStream).toHaveBeenCalledWith({ reason: "turn-result-cancelled" });
      expect(events.map((event) => event.type)).toEqual(["text_delta", "done"]);
      expect(events.at(-1)).toEqual({ type: "done", status: "cancelled" });
      expectRecordFields(requireTaskByRunId("run-1"), {
        ownerKey: "agent:main:main",
        childSessionKey: "agent:codex:acp:child-1",
        status: "cancelled",
      });
      const states = extractStatesFromUpserts();
      expect(states).toContain("running");
      expect(states).toContain("idle");
      expect(states).not.toContain("error");
    });
  });

  it("fails immediately when startTurn events fail before terminal result settles", async () => {
    const runtimeState = createRuntime();
    const closeStream = vi.fn(async () => {});
    runtimeState.runtime.startTurn = vi.fn((input) => ({
      requestId: input.requestId,
      events: (async function* () {
        yield { type: "text_delta" as const, stream: "output" as const, text: "partial" };
        throw new AcpRuntimeError("ACP_TURN_FAILED", "event stream disconnected");
      })(),
      result: new Promise<never>(() => {}),
      cancel: vi.fn(async () => {}),
      closeStream,
    }));
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });

    const manager = new AcpSessionManager();
    await expect(
      manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-1",
        text: "do work",
        mode: "prompt",
        requestId: "run-1",
      }),
    ).rejects.toMatchObject({
      code: "ACP_TURN_FAILED",
      message: "event stream disconnected",
    });
    expect(closeStream).toHaveBeenCalledWith({ reason: "turn-events-error" });
  });

  it("drains queued startTurn output before closing a failed terminal result", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const runtimeState = createRuntime();
      let closed = false;
      const closeStream = vi.fn(async () => {
        closed = true;
      });
      runtimeState.runtime.startTurn = vi.fn((input) => ({
        requestId: input.requestId,
        events: (async function* () {
          await Promise.resolve();
          if (closed) {
            return;
          }
          yield {
            type: "text_delta" as const,
            stream: "output" as const,
            text: "partial progress before failure",
          };
          for (;;) {
            if (closed) {
              return;
            }
            await new Promise((resolve) => {
              setTimeout(resolve, 1);
            });
          }
        })(),
        result: Promise.resolve({
          status: "failed" as const,
          error: {
            code: "ACP_TURN_FAILED",
            message: "Codex ACP adapter failed after partial output.",
          },
        }),
        cancel: vi.fn(async () => {}),
        closeStream,
      }));
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
        const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey;
        if (sessionKey === "agent:codex:acp:child-1") {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: {
              sessionId: "child-1",
              updatedAt: Date.now(),
              spawnedBy: "agent:quant:telegram:quant:direct:822430204",
              label: "Drain progress",
            },
            acp: readySessionMeta(),
          };
        }
        if (sessionKey === "agent:quant:telegram:quant:direct:822430204") {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: {
              sessionId: "parent-1",
              updatedAt: Date.now(),
            },
          };
        }
        return null;
      });

      const manager = new AcpSessionManager();
      await expect(
        manager.runTurn({
          provenance: "system",
          cfg: baseCfg,
          sessionKey: "agent:codex:acp:child-1",
          text: "Investigate and report back",
          mode: "prompt",
          requestId: "direct-parented-drain-progress-run",
        }),
      ).rejects.toMatchObject({
        code: "ACP_TURN_FAILED",
        message: "Codex ACP adapter failed after partial output.",
      });

      expect(closeStream).toHaveBeenCalledWith({ reason: "turn-result-failed" });
      expectRecordFields(requireTaskByRunId("direct-parented-drain-progress-run"), {
        status: "failed",
        progressSummary: "partial progress before failure",
      });
    });
  });

  it("rejects streams that end without a terminal done event", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });
    runtimeState.runTurn.mockImplementation(async function* () {
      yield { type: "text_delta" as const, text: "partial output" };
    });

    const manager = new AcpSessionManager();
    await expect(
      manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-1",
        text: "do work",
        mode: "prompt",
        requestId: "run-1",
      }),
    ).rejects.toMatchObject({
      code: "ACP_TURN_FAILED",
      message: "ACP turn ended without a terminal done event.",
    });

    const states = extractStatesFromUpserts();
    expect(states).toContain("running");
    expect(states).toContain("error");
    expect(states.at(-1)).toBe("error");
  });

  it("marks the session as errored when runtime ensure fails before turn start", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockRejectedValue(new Error("acpx exited with code 1"));
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: {
        ...readySessionMeta(),
        state: "running",
      },
    });

    const manager = new AcpSessionManager();
    await expectRejectedRecord(
      manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-1",
        text: "do work",
        mode: "prompt",
        requestId: "run-1",
      }),
      {
        code: "ACP_SESSION_INIT_FAILED",
        message: "acpx exited with code 1",
      },
    );

    const states = extractStatesFromUpserts();
    expect(states).not.toContain("running");
    expect(states.at(-1)).toBe("error");
  });

  it("retries once with a fresh runtime handle after early acpx exits", async () => {
    for (const message of ["acpx exited with code 1", "acpx exited with signal SIGTERM"]) {
      hoisted.upsertAcpSessionMetaMock.mockClear();
      const runtimeState = createRuntime();
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      hoisted.readAcpSessionEntryMock.mockReturnValue({
        sessionKey: "agent:codex:acp:session-1",
        storeSessionKey: "agent:codex:acp:session-1",
        acp: readySessionMeta(),
      });
      runtimeState.runTurn
        .mockImplementationOnce(async function* () {
          yield {
            type: "error" as const,
            message,
          };
        })
        .mockImplementationOnce(async function* () {
          yield { type: "done" as const };
        });

      const manager = new AcpSessionManager();
      await expect(
        manager.runTurn({
          provenance: "system",
          cfg: baseCfg,
          sessionKey: "agent:codex:acp:session-1",
          text: "do work",
          mode: "prompt",
          requestId: "run-1",
        }),
        message,
      ).resolves.toBeUndefined();

      expect(runtimeState.ensureSession, message).toHaveBeenCalledTimes(2);
      expect(runtimeState.runTurn, message).toHaveBeenCalledTimes(2);
      const states = extractStatesFromUpserts();
      expect(states, message).toContain("running");
      expect(states, message).toContain("idle");
      expect(states, message).not.toContain("error");
      resetAcpSessionManagerForTests();
    }
  });

  // Drives a thread-bound persistent ACP session whose first turn fails because
  // the backend can no longer resume the stale session id, then a clean second
  // turn. Returns observers so each case can assert whether the manager
  // discarded the stale identity and retried fresh (#87830).
  function setupStaleResumeScenario(firstTurn: () => AsyncIterable<AcpRuntimeEvent>) {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:claude:acp:binding:discord:default:retry-no-session";
    let currentMeta: SessionAcpMeta = {
      ...readySessionMeta({ agent: "claude" }),
      runtimeSessionName: sessionKey,
      identity: {
        state: "resolved",
        source: "status",
        acpxSessionId: "acpx-sid-stale",
        lastUpdatedAt: Date.now(),
      },
    };
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return { sessionKey: key, storeSessionKey: key, acp: currentMeta };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const next = params.mutate(currentMeta, { acp: currentMeta });
      if (next) {
        currentMeta = next;
      }
      return { sessionId: "session-1", updatedAt: Date.now(), acp: currentMeta };
    });
    runtimeState.ensureSession.mockImplementation(async (inputUnknown: unknown) => {
      const input = inputUnknown as {
        sessionKey: string;
        mode: "persistent" | "oneshot";
        resumeSessionId?: string;
      };
      return {
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: `${input.sessionKey}:${input.mode}:runtime`,
        backendSessionId: input.resumeSessionId ? "acpx-sid-stale" : "acpx-sid-fresh",
      };
    });
    runtimeState.getStatus.mockResolvedValue({
      summary: "status=alive",
      backendSessionId: "acpx-sid-fresh",
      details: { status: "alive" },
    });
    runtimeState.runTurn
      .mockImplementationOnce(firstTurn)
      .mockImplementationOnce(async function* () {
        yield { type: "done" as const };
      });
    const manager = new AcpSessionManager();
    const runTurn = () =>
      manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey,
        text: "do work",
        mode: "prompt",
        requestId: "run-no-session",
      });
    return { runtimeState, sessionKey, runTurn, getMeta: () => currentMeta };
  }

  function expectFreshRetry(scenario: ReturnType<typeof setupStaleResumeScenario>) {
    expect(scenario.runtimeState.prepareFreshSession).toHaveBeenCalledWith({
      sessionKey: scenario.sessionKey,
    });
    expect(scenario.runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    expectRecordFields(mockCallArg(scenario.runtimeState.ensureSession), {
      sessionKey: scenario.sessionKey,
      resumeSessionId: "acpx-sid-stale",
    });
    expect(mockCallArg(scenario.runtimeState.ensureSession, 1).resumeSessionId).toBeUndefined();
    expect(scenario.getMeta().identity?.acpxSessionId).toBe("acpx-sid-fresh");
    expect(scenario.getMeta().identity?.state).toBe("resolved");
    const states = extractStatesFromUpserts();
    expect(states).toContain("running");
    expect(states).toContain("idle");
    expect(states).not.toContain("error");
  }

  // The structured SESSION_RESUME_REQUIRED detail code drives recovery
  // regardless of the backend's human-readable reason. Claude reports
  // "Resource not found"; Kiro reports "Internal error" (RequestError -32603) —
  // both must discard the stale persistent id and retry fresh (#87830).
  it.each([
    ["Resource not found", "Resource not found: acpx-sid-stale"],
    ["Internal error (Kiro RequestError -32603)", "Internal error"],
  ])(
    "retries with a fresh persistent session on a resume-required error: %s",
    async (_label, reason) => {
      const scenario = setupStaleResumeScenario(async function* () {
        yield {
          type: "error" as const,
          code: "NO_SESSION",
          detailCode: "SESSION_RESUME_REQUIRED",
          message: `Persistent ACP session acpx-sid-stale could not be resumed: ${reason}`,
        };
      });
      await expect(scenario.runTurn()).resolves.toBeUndefined();
      expectFreshRetry(scenario);
    },
  );

  it("recovers when the resume-required error is wrapped as a thrown cause", async () => {
    const scenario = setupStaleResumeScenario(
      // eslint-disable-next-line require-yield -- an async generator that only throws is a valid empty stream.
      async function* () {
        const error = new Error(
          "Persistent ACP session acpx-sid-stale could not be resumed: Internal error",
        ) as Error & { detailCode?: string };
        error.detailCode = "SESSION_RESUME_REQUIRED";
        throw error;
      },
    );
    await expect(scenario.runTurn()).resolves.toBeUndefined();
    expectFreshRetry(scenario);
  });

  it.each([
    ["bare internal error", "Internal error"],
    ["closed app-server client", "codex app-server client is closed"],
    ["closed query", "query closed before response received"],
  ])(
    "retries a transient pre-output turn failure without discarding the persistent session: %s",
    async (_label, message) => {
      const scenario = setupStaleResumeScenario(async function* () {
        yield {
          type: "error" as const,
          code: "ACP_TURN_FAILED",
          message,
        };
      });
      await expect(scenario.runTurn()).resolves.toBeUndefined();
      expect(scenario.runtimeState.prepareFreshSession).not.toHaveBeenCalled();
      expect(scenario.runtimeState.ensureSession).toHaveBeenCalledTimes(2);
      expect(mockCallArg(scenario.runtimeState.ensureSession, 1).resumeSessionId).toBe(
        "acpx-sid-stale",
      );
      const states = extractStatesFromUpserts();
      expect(states).toContain("running");
      expect(states).toContain("idle");
      expect(states).not.toContain("error");
    },
  );

  it("retries a transient turn failure thrown before any output", async () => {
    const scenario = setupStaleResumeScenario(async function* () {
      yield { type: "status" as const, text: "starting" };
      throw new Error("query closed before response received");
    });
    await expect(scenario.runTurn()).resolves.toBeUndefined();
    expect(scenario.runtimeState.prepareFreshSession).not.toHaveBeenCalled();
    expect(scenario.runtimeState.ensureSession).toHaveBeenCalledTimes(2);
  });

  it("does not retry a transient turn failure after output was seen", async () => {
    const scenario = setupStaleResumeScenario(async function* () {
      yield { type: "text_delta" as const, stream: "output" as const, text: "partial" };
      yield {
        type: "error" as const,
        code: "ACP_TURN_FAILED",
        message: "Internal error",
      };
    });
    await expect(scenario.runTurn()).rejects.toThrow("Internal error");
    expect(scenario.runtimeState.prepareFreshSession).not.toHaveBeenCalled();
    expect(scenario.runtimeState.ensureSession).toHaveBeenCalledTimes(1);
  });

  it("does not retry a transient turn failure more than once", async () => {
    const failingTurn = async function* () {
      yield {
        type: "error" as const,
        code: "ACP_TURN_FAILED",
        message: "Internal error",
      };
    };
    const scenario = setupStaleResumeScenario(failingTurn);
    scenario.runtimeState.runTurn.mockReset();
    scenario.runtimeState.runTurn.mockImplementation(failingTurn);
    await expect(scenario.runTurn()).rejects.toThrow("Internal error");
    expect(scenario.runtimeState.runTurn).toHaveBeenCalledTimes(2);
    expect(scenario.runtimeState.ensureSession).toHaveBeenCalledTimes(2);
  });

  it("does not retry an enriched turn failure that is not a transient shape", async () => {
    const scenario = setupStaleResumeScenario(async function* () {
      yield {
        type: "error" as const,
        code: "ACP_TURN_FAILED",
        message: "Internal error: stream error: unexpected status 401 Unauthorized",
      };
    });
    await expect(scenario.runTurn()).rejects.toThrow();
    expect(scenario.runtimeState.prepareFreshSession).not.toHaveBeenCalled();
    expect(scenario.runtimeState.ensureSession).toHaveBeenCalledTimes(1);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
