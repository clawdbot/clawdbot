import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearConfigCache } from "../config/config.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  gatewayReplyMock,
  installGatewayTestHooks,
  onceMessage,
  prepareGatewayReplyRuntimeForTest,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const temporaryDirectories = useAutoCleanupTempDirTracker(afterEach);
let gateway: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;

beforeAll(async () => {
  gateway = await createGatewaySuiteHarness();
});
afterAll(async () => {
  await gateway.close();
});
afterEach(() => {
  gatewayReplyMock.mockReset();
  testState.sessionStorePath = undefined;
  clearConfigCache();
});

it("reports an adopted pre-model failure as one visible failure over the Gateway WebSocket", async () => {
  testState.sessionStorePath = path.join(
    temporaryDirectories.make("openclaw-adopted-failure-"),
    "sessions.json",
  );
  await writeSessionStore({
    entries: { main: { sessionId: "adopted-failure-session", updatedAt: Date.now() } },
  });
  const socket = await gateway.openWs();
  const runId = "adopted-before-model-failure";
  const terminalStates: string[] = [];
  socket.on("message", (raw) => {
    const frame = JSON.parse(rawDataToString(raw)) as {
      event?: string;
      payload?: { runId?: string; state?: string };
    };
    const state = frame.payload?.state;
    if (
      frame.event === "chat" &&
      frame.payload?.runId === runId &&
      state &&
      ["error", "final", "aborted"].includes(state)
    ) {
      terminalStates.push(state);
    }
  });
  const originalError = new Error("private synthetic dispatch failure detail");
  gatewayReplyMock.mockImplementationOnce(async (_ctx, options) => {
    await options?.turnAdoptionLifecycle?.onAdopted();
    throw originalError;
  });
  try {
    await connectOk(socket);
    await prepareGatewayReplyRuntimeForTest({ force: true });
    const terminal = onceMessage(
      socket,
      (frame) =>
        frame.type === "event" &&
        frame.event === "chat" &&
        frame.payload?.runId === runId &&
        frame.payload?.state === "error",
    );
    void terminal.catch(() => undefined);
    const request = {
      sessionKey: "main",
      message: "Please answer this message.",
      idempotencyKey: runId,
    };
    const accepted = await rpcReq(socket, "chat.send", request);
    expect(accepted.ok).toBe(true);
    expect(accepted.payload).toMatchObject({ runId, status: "started" });
    const failed = await terminal;
    expect(JSON.stringify(failed)).toContain("Something went wrong");
    expect(JSON.stringify(failed)).not.toContain(originalError.message);
    const replay = await rpcReq(socket, "chat.send", request);
    expect(replay.ok).toBe(false);
    expect(replay.payload).toMatchObject({ runId, status: "error" });
    expect(gatewayReplyMock).toHaveBeenCalledOnce();
    expect(terminalStates).toEqual(["error"]);
  } finally {
    socket.close();
  }
});
