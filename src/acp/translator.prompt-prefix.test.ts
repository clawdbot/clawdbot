import os from "node:os";
import path from "node:path";
import type { PromptRequest } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { createInMemorySessionStore } from "./session.js";
import { AcpGatewayAgent } from "./translator.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

const TEST_SESSION_ID = "session-1";
const TEST_SESSION_KEY = "agent:main:main";
const TEST_PROMPT = {
  sessionId: TEST_SESSION_ID,
  prompt: [{ type: "text", text: "hello" }],
  _meta: {},
} as unknown as PromptRequest;

describe("acp prompt cwd prefix", () => {
  const createStopAfterSendSpy = () =>
    vi.fn(async (method: string) => {
      if (method === "chat.send") {
        throw new Error("stop-after-send");
      }
      return {};
    });

  function chatSendPayload(requestSpy: { mock: { calls: unknown[][] } }, index = 0) {
    const call = requestSpy.mock.calls[index];
    expect(call?.[0]).toBe("chat.send");
    expect(call?.[2]).toEqual({ timeoutMs: null });
    expect(typeof call?.[1]).toBe("object");
    expect(call?.[1]).not.toBeNull();
    return call?.[1] as Record<string, unknown>;
  }

  async function runPromptAndCaptureRequest(
    options: {
      cwd?: string;
      prefixCwd?: boolean;
      provenanceMode?: "meta" | "meta+receipt";
    } = {},
  ) {
    const sessionStore = createInMemorySessionStore();
    sessionStore.createSession({
      sessionId: TEST_SESSION_ID,
      sessionKey: TEST_SESSION_KEY,
      cwd: options.cwd ?? path.join(os.homedir(), "openclaw-test"),
    });

    const requestSpy = createStopAfterSendSpy();
    const agent = new AcpGatewayAgent(
      createAcpConnection(),
      createAcpGateway(requestSpy as unknown as GatewayClient["request"]),
      {
        sessionStore,
        prefixCwd: options.prefixCwd,
        provenanceMode: options.provenanceMode,
      },
    );

    await expect(agent.prompt(TEST_PROMPT)).rejects.toThrow("stop-after-send");
    return requestSpy;
  }

  async function runPromptWithCwd(cwd: string) {
    const pinnedHome = os.homedir();
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    const previousHome = process.env.HOME;
    delete process.env.OPENCLAW_HOME;
    process.env.HOME = pinnedHome;

    try {
      return await runPromptAndCaptureRequest({ cwd, prefixCwd: true });
    } finally {
      if (previousOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previousOpenClawHome;
      }
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  }

  it("redacts home directory in prompt prefix", async () => {
    const requestSpy = await runPromptWithCwd(path.join(os.homedir(), "openclaw-test"));
    const payload = chatSendPayload(requestSpy);
    expect(typeof payload.message).toBe("string");
    expect(payload.message).toMatch(/\[Working directory: ~[\\/]openclaw-test\]/);
  });

  it("keeps backslash separators when cwd uses them", async () => {
    const requestSpy = await runPromptWithCwd(`${os.homedir()}\\openclaw-test`);
    const payload = chatSendPayload(requestSpy);
    expect(payload.message).toContain("[Working directory: ~\\openclaw-test]");
  });

  it("injects system provenance metadata when enabled", async () => {
    const requestSpy = await runPromptAndCaptureRequest({ provenanceMode: "meta" });
    const payload = chatSendPayload(requestSpy);
    expect(payload.systemInputProvenance).toEqual({
      kind: "external_user",
      originSessionId: TEST_SESSION_ID,
      sourceChannel: "acp",
      sourceTool: "openclaw_acp",
    });
    expect(payload.systemProvenanceReceipt).toBeUndefined();
  });

  it("injects a system provenance receipt when requested", async () => {
    const requestSpy = await runPromptAndCaptureRequest({ provenanceMode: "meta+receipt" });
    const payload = chatSendPayload(requestSpy);
    expect(payload.systemInputProvenance).toEqual({
      kind: "external_user",
      originSessionId: TEST_SESSION_ID,
      sourceChannel: "acp",
      sourceTool: "openclaw_acp",
    });
    expect(typeof payload.systemProvenanceReceipt).toBe("string");
    const receipt = payload.systemProvenanceReceipt as string;
    expect(receipt).toContain("[Source Receipt]");
    expect(receipt).toContain("bridge=openclaw-acp");
    expect(receipt).toContain(`originSessionId=${TEST_SESSION_ID}`);
    expect(receipt).toContain(`targetSession=${TEST_SESSION_KEY}`);
  });

  it("retries without provenance when the gateway rejects admin-only provenance fields", async () => {
    const requestSpy = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("system provenance fields require admin scope"), {
          name: "GatewayClientRequestError",
          gatewayCode: "INVALID_REQUEST",
        }),
      )
      .mockRejectedValueOnce(new Error("stop-after-send"));
    const sessionStore = createInMemorySessionStore();
    sessionStore.createSession({
      sessionId: TEST_SESSION_ID,
      sessionKey: TEST_SESSION_KEY,
      cwd: path.join(os.homedir(), "openclaw-test"),
    });
    const agent = new AcpGatewayAgent(
      createAcpConnection(),
      createAcpGateway(requestSpy as unknown as GatewayClient["request"]),
      {
        sessionStore,
        provenanceMode: "meta+receipt",
      },
    );

    await expect(agent.prompt(TEST_PROMPT)).rejects.toThrow("stop-after-send");
    expect(requestSpy).toHaveBeenCalledTimes(2);
    const firstPayload = chatSendPayload(requestSpy, 0);
    expect(firstPayload.systemInputProvenance).toEqual({
      kind: "external_user",
      originSessionId: TEST_SESSION_ID,
      sourceChannel: "acp",
      sourceTool: "openclaw_acp",
    });
    expect(firstPayload.systemProvenanceReceipt).toContain("[Source Receipt]");

    const retryPayload = chatSendPayload(requestSpy, 1);
    expect(retryPayload.systemInputProvenance).toBeUndefined();
    expect(retryPayload.systemProvenanceReceipt).toBeUndefined();
  });
});
