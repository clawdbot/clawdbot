import type { AgentSideConnection, SessionUpdate } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { AcpEventLedger } from "./event-ledger.js";
import { AcpTranslatorSessionUpdates } from "./translator.session-updates.js";

function createLedger(): AcpEventLedger {
  return {
    startSession: vi.fn(async () => {}),
    recordUserPrompt: vi.fn(async () => {}),
    recordUpdate: vi.fn(async () => {}),
    markIncomplete: vi.fn(async () => {}),
    readReplay: vi.fn(async () => ({ complete: true, events: [] })),
    readReplayBySessionId: vi.fn(async () => ({ complete: true, events: [] })),
    readReplayBySessionKey: vi.fn(async () => ({ complete: true, events: [] })),
  };
}

function createUpdates(params: {
  ledger: AcpEventLedger;
  sessionUpdate?: AgentSideConnection["sessionUpdate"];
}) {
  return new AcpTranslatorSessionUpdates({
    connection: {
      sessionUpdate: params.sessionUpdate ?? vi.fn(async () => {}),
    },
    eventLedger: params.ledger,
    getAvailableCommands: async () => [],
    log: () => {},
  });
}

const update: SessionUpdate = {
  sessionUpdate: "available_commands_update",
  availableCommands: [],
};

describe("AcpTranslatorSessionUpdates", () => {
  it("blocks ledger reads and writes after shutdown starts", async () => {
    const ledger = createLedger();
    const sessionUpdate = vi.fn(async () => {});
    const updates = createUpdates({ ledger, sessionUpdate });
    updates.stop();

    await updates.startLedgerSession(
      { sessionId: "session-1", sessionKey: "agent:main:session-1", cwd: "/tmp" },
      { complete: true },
    );
    await updates.recordUserPrompt(
      { sessionId: "session-1", sessionKey: "agent:main:session-1" },
      "run-1",
      [],
    );
    await updates.emit({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      record: true,
      update,
    });

    await expect(
      updates.readLedgerReplay({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
      }),
    ).resolves.toEqual({ complete: false, events: [] });
    await expect(updates.readLedgerReplayBySessionId("session-1")).resolves.toEqual({
      complete: false,
      events: [],
    });
    await expect(updates.readLedgerReplayBySessionKey("agent:main:session-1")).resolves.toEqual({
      complete: false,
      events: [],
    });

    expect(sessionUpdate).not.toHaveBeenCalled();
    for (const method of Object.values(ledger)) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it("does not record an update that resumes after shutdown starts", async () => {
    let resolveSessionUpdate!: () => void;
    const pendingSessionUpdate = new Promise<void>((resolve) => {
      resolveSessionUpdate = resolve;
    });
    const ledger = createLedger();
    const updates = createUpdates({
      ledger,
      sessionUpdate: vi.fn(async () => await pendingSessionUpdate),
    });

    const emitPromise = updates.emit({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      record: true,
      update,
    });
    updates.stop();
    resolveSessionUpdate();
    await emitPromise;

    expect(ledger.recordUpdate).not.toHaveBeenCalled();
  });

  it("preserves ledger order without waiting for ACP delivery", async () => {
    let releaseFirstDelivery!: () => void;
    const firstDelivery = new Promise<void>((resolve) => {
      releaseFirstDelivery = resolve;
    });
    let deliveryCount = 0;
    const ledger = createLedger();
    const updates = createUpdates({
      ledger,
      sessionUpdate: vi.fn(async () => {
        deliveryCount += 1;
        if (deliveryCount === 1) {
          await firstDelivery;
        }
      }),
    });
    const firstUpdate: SessionUpdate = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "first" },
    };
    const interruptionUpdate: SessionUpdate = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "interrupted" },
    };

    const firstEmit = updates.emit({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      record: true,
      update: firstUpdate,
    });
    await vi.waitFor(() => {
      expect(ledger.recordUpdate).toHaveBeenCalledTimes(1);
    });

    await updates.emit({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      record: true,
      waitForDelivery: false,
      update: interruptionUpdate,
    });

    expect(vi.mocked(ledger.recordUpdate).mock.calls.map(([params]) => params.update)).toEqual([
      firstUpdate,
      interruptionUpdate,
    ]);
    await expect(Promise.race([firstEmit, Promise.resolve("pending")])).resolves.toBe("pending");
    releaseFirstDelivery();
    await firstEmit;
  });

  it("does not let a stalled ledger session block another session", async () => {
    let releaseFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const ledger = createLedger();
    vi.mocked(ledger.recordUpdate).mockImplementation(async ({ sessionId }) => {
      if (sessionId === "session-1") {
        await firstWrite;
      }
    });
    const updates = createUpdates({ ledger });

    const stalledEmit = updates.emit({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      record: true,
      waitForDelivery: false,
      update,
    });
    await vi.waitFor(() => {
      expect(ledger.recordUpdate).toHaveBeenCalledTimes(1);
    });

    const queuedSameSessionEmit = updates.emit({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      record: true,
      waitForDelivery: false,
      update,
    });
    await updates.emit({
      sessionId: "session-2",
      sessionKey: "agent:main:session-2",
      record: true,
      waitForDelivery: false,
      update,
    });

    expect(vi.mocked(ledger.recordUpdate).mock.calls.map(([params]) => params.sessionId)).toEqual([
      "session-1",
      "session-2",
    ]);
    releaseFirstWrite();
    await Promise.all([stalledEmit, queuedSameSessionEmit]);
    expect(vi.mocked(ledger.recordUpdate).mock.calls.map(([params]) => params.sessionId)).toEqual([
      "session-1",
      "session-2",
      "session-1",
    ]);
  });
});
