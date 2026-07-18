// Covers the gateway work-admission wiring for the OpenAI-compatible endpoint:
//  (A) drain-503 mapping — when the (detached) agent run rejects with a
//      GatewayDrainingError, both the non-streaming and streaming paths surface
//      the shared 503 {type:"service_unavailable",code:"gateway_unavailable"}
//      envelope instead of a masked "internal error"; and
//  (B) the root work-admission continuation that keeps a detached streaming run
//      admitted after the HTTP handler returns and its own root lease releases.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GatewayDrainingError,
  getActiveGatewayRootWorkCount,
  isGatewaySubordinateWorkAdmissionClosed,
  resetGatewayWorkAdmission,
  retainGatewayRootWorkAdmissionContinuation,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  agentCommand,
  getFreePort,
  installGatewayTestHooks,
  startGatewayServerWithRetries,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let enabledServer: Awaited<ReturnType<typeof startGatewayServerWithRetries>>["server"];
let enabledPort: number;

beforeAll(async () => {
  const started = await startGatewayServerWithRetries({
    port: await getFreePort(),
    opts: {
      host: "127.0.0.1",
      auth: { mode: "none" },
      controlUiEnabled: false,
      openAiChatCompletionsEnabled: true,
    },
  });
  enabledPort = started.port;
  enabledServer = started.server;
});

afterAll(async () => {
  await enabledServer?.close({ reason: "openai http admission suite done" });
});

async function postChatCompletions(port: number, body: unknown) {
  return await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openclaw-scopes": "operator.write",
    },
    body: JSON.stringify(body),
  });
}

function parseSseDataLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length));
}

describe("OpenAI-compatible HTTP drain-503 mapping (e2e)", () => {
  it("maps a GatewayDrainingError run rejection to a non-streaming 503 gateway_unavailable envelope", async () => {
    agentCommand.mockClear();
    // The detached run loses process admission mid-flight; agentCommandFromIngress
    // surfaces that as a GatewayDrainingError rather than a generic failure.
    agentCommand.mockRejectedValueOnce(new GatewayDrainingError() as never);

    const res = await postChatCompletions(enabledPort, {
      model: "openclaw",
      messages: [{ role: "user", content: "hi during drain" }],
    });

    // Without the resolveOpenAiCompatError mapping this path returns a masked
    // 500 {type:"api_error", message:"internal error"} instead.
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error?: Record<string, unknown> };
    expect(json.error).toEqual({
      message: "Gateway is draining; new tasks are not accepted",
      type: "service_unavailable",
      code: "gateway_unavailable",
    });
    expect(agentCommand).toHaveBeenCalledTimes(1);
  });

  it("maps a GatewayDrainingError run rejection to a streaming 503 error chunk, not 'Error: internal error'", async () => {
    agentCommand.mockClear();
    agentCommand.mockRejectedValueOnce(new GatewayDrainingError() as never);

    const res = await postChatCompletions(enabledPort, {
      stream: true,
      model: "openclaw",
      messages: [{ role: "user", content: "hi during drain" }],
    });
    expect(res.status).toBe(200);

    const text = await res.text();
    const data = parseSseDataLines(text);
    expect(data[data.length - 1]).toBe("[DONE]");

    const chunks = data
      .filter((d) => d !== "[DONE]")
      .map((d) => JSON.parse(d) as Record<string, unknown>);

    // The draining error is surfaced as a structured OpenAI-compatible error
    // envelope on the stream.
    const drainErrorChunk = chunks.find(
      (chunk) =>
        typeof chunk.error === "object" &&
        (chunk.error as { code?: unknown }).code === "gateway_unavailable",
    );
    if (!drainErrorChunk) {
      throw new Error("expected a gateway_unavailable error chunk on the stream");
    }
    expect(drainErrorChunk.error).toEqual({
      message: "Gateway is draining; new tasks are not accepted",
      type: "service_unavailable",
      code: "gateway_unavailable",
    });

    // Regression guard for the original "Error: internal error" bug: the masked
    // fallback content must NOT be emitted when the error maps cleanly.
    const emittedContent = chunks
      .flatMap((c) => (c.choices as Array<Record<string, unknown>> | undefined) ?? [])
      .map((choice) => (choice.delta as Record<string, unknown> | undefined)?.content)
      .filter((v): v is string => typeof v === "string");
    expect(emittedContent).not.toContain("Error: internal error");
    expect(agentCommand).toHaveBeenCalledTimes(1);
  });
});

describe("gateway root work-admission continuation (unit)", () => {
  it("keeps the root admitted after the request lease releases, until the continuation is released", async () => {
    resetGatewayWorkAdmission();
    try {
      const lease = tryBeginGatewayRootWorkAdmission();
      if (!lease) {
        throw new Error("expected an admitted root lease");
      }
      await lease.run(async () => {
        expect(getActiveGatewayRootWorkCount()).toBe(1);

        // The detached run transfers the admitted request root before the
        // handler returns.
        const releaseContinuation = retainGatewayRootWorkAdmissionContinuation();
        expect(releaseContinuation).not.toBeNull();

        // The HTTP boundary releases its own root lease as soon as it returns.
        // Because the continuation holds an extra reference, the root stays
        // admitted -- subordinate work in the same chain is still accepted.
        lease.release();
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(false);

        // Only when the detached run finishes and releases the continuation does
        // the root retire and subordinate admission close for the chain.
        releaseContinuation?.();
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(true);
      });
    } finally {
      resetGatewayWorkAdmission();
    }
  });

  it("returns null and releases as a safe no-op when there is no live root to retain", () => {
    resetGatewayWorkAdmission();
    try {
      // Outside any admitted root chain there is nothing to hand off.
      const releaseContinuation = retainGatewayRootWorkAdmissionContinuation();
      expect(releaseContinuation).toBeNull();
      // The handler releases via optional chaining; a null continuation must be a
      // safe no-op and must not perturb admitted-root accounting.
      expect(() => releaseContinuation?.()).not.toThrow();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      resetGatewayWorkAdmission();
    }
  });
});
