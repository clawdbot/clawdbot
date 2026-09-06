import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import { createQaGatewayChild } from "./gateway-child.js";
import {
  QA_REQUESTER_SETTLE_FINAL_MARKER,
  QA_REQUESTER_SETTLE_WAVE_ONE_MARKER,
  QA_REQUESTER_SETTLE_WAVE_TWO_MARKER,
} from "./providers/mock-openai/mock-openai-contracts.js";
import { startQaMockOpenAiServer } from "./providers/mock-openai/server.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";

const TRIGGER =
  "Requester settle sequential waves QA check. Complete both waves before the final answer.";
const REQUESTER_CONVERSATION = { id: "requester-user", kind: "direct" as const };
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

describe("requester-settle sequential waves", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
  });

  it("spawns Wave 2 after Wave 1 settles and emits one final reply", async () => {
    const state = createQaBusState();
    const transport = createQaChannelTransport(state);
    const bus = await startQaBusServer({ state });
    cleanups.push(() => bus.stop());

    const mock = await startQaMockOpenAiServer();
    cleanups.push(() => mock.stop());

    const gatewayOwner = createQaGatewayChild();
    cleanups.push(async () => {
      expect((await gatewayOwner.stop()).errors).toEqual([]);
    });
    const gateway = await gatewayOwner.start({
      repoRoot: REPO_ROOT,
      useRepoCli: true,
      providerBaseUrl: `${mock.baseUrl}/v1`,
      providerMode: "mock-openai",
      transport,
      transportBaseUrl: bus.baseUrl,
      controlUiEnabled: false,
    });
    await transport.waitReady({ gateway });

    const outboundStartIndex = state
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound").length;
    await transport.sendInbound({
      accountId: "default",
      conversation: REQUESTER_CONVERSATION,
      senderId: REQUESTER_CONVERSATION.id,
      text: TRIGGER,
    });

    try {
      const completion = await transport.waitForOutbound({
        conversation: REQUESTER_CONVERSATION,
        sinceIndex: outboundStartIndex,
        timeoutMs: 45_000,
      });
      expect(completion.text).toContain(QA_REQUESTER_SETTLE_FINAL_MARKER);
    } catch (error) {
      throw new Error(
        [
          error instanceof Error ? error.message : String(error),
          `bus=${JSON.stringify(state.getSnapshot())}`,
          `gateway=${gateway.logs()}`,
        ].join("\n"),
        { cause: error },
      );
    }

    const response = await fetch(`${mock.baseUrl}/debug/requests`);
    expect(response.status).toBe(200);
    const requests = (await response.json()) as Array<{
      plannedToolArgs?: { label?: string };
      plannedToolName?: string;
    }>;
    const spawnLabels = requests
      .filter((request) => request.plannedToolName === "sessions_spawn")
      .map((request) => request.plannedToolArgs?.label);
    expect(spawnLabels).toContain("qa-requester-settle-wave-one");
    expect(spawnLabels).toContain("qa-requester-settle-wave-two");

    const outbound = state
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound");
    expect(
      outbound.filter((message) => message.text.includes(QA_REQUESTER_SETTLE_FINAL_MARKER)),
    ).toHaveLength(1);
    expect(
      outbound.some((message) => message.text.includes(QA_REQUESTER_SETTLE_WAVE_ONE_MARKER)),
    ).toBe(false);
    expect(
      outbound.some((message) => message.text.includes(QA_REQUESTER_SETTLE_WAVE_TWO_MARKER)),
    ).toBe(false);
  }, 180_000);
});
