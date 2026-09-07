import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it } from "vitest";
import {
  createQaBusState,
  createQaChannelTransport,
  startQaBusServer,
  type MockOpenAiRequestSnapshot,
} from "../../../../extensions/qa-lab/api.js";
import { createQaLiveLaneGateway } from "../../../../extensions/qa-lab/runtime-api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

const accountId = "default";
const peerId = "code-mode-proof-peer";
const sessionKey = `agent:main:qa-channel:direct:${peerId}`;
const outboundMarker = "QA-CODE-MODE-CURRENT-TURN-OUTBOUND";
const ordinaryFinalMarker = "QA-CODE-MODE-ORDINARY-FINAL";
const prompt =
  `QA current-turn Code Mode delivery: send exactly \`${outboundMarker}\`; ` +
  `if another provider request follows, reply exactly \`${ordinaryFinalMarker}\``;

let gatewayOwner: ReturnType<typeof createQaLiveLaneGateway> | undefined;
let bus: Awaited<ReturnType<typeof startQaBusServer>> | undefined;

async function waitFor<T>(label: string, read: () => Promise<T | undefined> | T | undefined) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForStableCompletion(params: {
  providerBaseUrl: string;
  readOutboundCount: () => number;
}) {
  const deadline = Date.now() + 45_000;
  let stableSince = 0;
  let previous: { providerRequests: number; outboundMessages: number } | undefined;
  while (Date.now() < deadline) {
    const [requestsResponse, inflightResponse] = await Promise.all([
      fetch(`${params.providerBaseUrl}/debug/requests`),
      fetch(`${params.providerBaseUrl}/debug/inflight-requests`),
    ]);
    expect(requestsResponse.ok).toBe(true);
    expect(inflightResponse.ok).toBe(true);
    const requests = (await requestsResponse.json()) as MockOpenAiRequestSnapshot[];
    const inflight = (await inflightResponse.json()) as unknown[];
    const current = {
      providerRequests: requests.length,
      outboundMessages: params.readOutboundCount(),
    };
    if (
      inflight.length === 0 &&
      previous?.providerRequests === current.providerRequests &&
      previous.outboundMessages === current.outboundMessages
    ) {
      stableSince ||= Date.now();
      if (Date.now() - stableSince >= 1_000) {
        return { requests, inflight, counts: current };
      }
    } else {
      stableSince = 0;
    }
    previous = current;
    await sleep(100);
  }
  throw new Error("timed out waiting for stable provider and outbound completion");
}

afterEach(async () => {
  const errors: unknown[] = [];
  try {
    if (gatewayOwner) {
      await stopQaGatewayFixture(gatewayOwner);
    }
  } catch (error) {
    errors.push(error);
  } finally {
    gatewayOwner = undefined;
  }
  try {
    await bus?.stop();
  } catch (error) {
    errors.push(error);
  } finally {
    bus = undefined;
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Code Mode delivery proof cleanup failed");
  }
});

describe("Code Mode current-turn delivery real Gateway proof", () => {
  it(
    "uses one provider request and leaves the transcript on the completed exec result",
    { timeout: 120_000 },
    async () => {
      const state = createQaBusState();
      bus = await startQaBusServer({ state });
      gatewayOwner = createQaLiveLaneGateway();
      const harness = await gatewayOwner.start({
        repoRoot: process.cwd(),
        command: {
          executablePath: process.execPath,
          argsPrefix: [path.join(process.cwd(), "scripts", "run-node.mjs")],
          cwd: process.cwd(),
        },
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        transport: createQaChannelTransport(state),
        transportBaseUrl: bus.baseUrl,
        controlUiEnabled: false,
        mutateConfig: (config) => ({
          ...config,
          tools: {
            ...config.tools,
            codeMode: { enabled: true },
          },
        }),
      });

      state.addInboundMessage({
        accountId,
        conversation: { kind: "direct", id: peerId },
        senderId: peerId,
        text: prompt,
      });

      await waitFor("one current-turn outbound", () => {
        const outbound = state
          .getSnapshot()
          .messages.filter((message) => message.direction === "outbound");
        return outbound.some((message) => message.text === outboundMarker) ? outbound : undefined;
      });
      const history = await waitFor("completed exec transcript result", async () => {
        const payload = await harness.gateway.call(
          "chat.history",
          { sessionKey, agentId: "main", limit: 20 },
          { timeoutMs: 10_000 },
        );
        if (!isRecord(payload) || !Array.isArray(payload.messages)) {
          return undefined;
        }
        const last = payload.messages.at(-1);
        return isRecord(last) &&
          last.role === "toolResult" &&
          last.toolName === "exec" &&
          JSON.stringify(last).includes('"status":"completed"')
          ? payload.messages
          : undefined;
      });

      if (!harness.mock) {
        throw new Error("mock OpenAI provider did not start");
      }
      const settled = await waitForStableCompletion({
        providerBaseUrl: harness.mock.baseUrl,
        readOutboundCount: () =>
          state.getSnapshot().messages.filter((message) => message.direction === "outbound").length,
      });
      const outbound = state
        .getSnapshot()
        .messages.filter((message) => message.direction === "outbound");

      expect(settled.inflight).toEqual([]);
      expect(settled.counts).toEqual({ providerRequests: 1, outboundMessages: 1 });
      expect(settled.requests).toHaveLength(1);
      expect(settled.requests[0]).toMatchObject({ plannedToolName: "exec" });
      expect(outbound).toHaveLength(1);
      expect(outbound[0]?.text).toBe(outboundMarker);
      expect(outbound.some((message) => message.text === ordinaryFinalMarker)).toBe(false);
      expect(history.at(-1)).toMatchObject({ role: "toolResult", toolName: "exec" });
    },
  );
});
