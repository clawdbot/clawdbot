import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type FrontierInvocationRoute =
  | "anthropic-messages/builtin"
  | "anthropic-messages/managed"
  | "azure-openai-responses/managed"
  | "openai-chatgpt-responses/managed"
  | "openai-chatgpt-responses/native-sse"
  | "openai-chatgpt-responses/native-websocket"
  | "openai-responses/managed";

type RouteProof = {
  callbackProof: URL;
  callbackMarkers: readonly string[];
  behaviorProof: URL;
  behaviorMarkers: readonly string[];
};

const FRONTIER_INVOCATION_ROUTES = {
  "anthropic-messages/builtin": {
    callbackProof: new URL("../providers/anthropic.fetch-loopback.test.ts", import.meta.url),
    callbackMarkers: ["observeTestEndpointInvocation", "options?.onFetchDispatch?.();"],
    behaviorProof: new URL("../providers/anthropic.fetch-loopback.test.ts", import.meta.url),
    behaviorMarkers: [
      "counts each SDK retry as an admitted fetch invocation",
      'type: "invocation"',
    ],
  },
  "anthropic-messages/managed": {
    callbackProof: new URL("./anthropic-transport-stream.test.ts", import.meta.url),
    callbackMarkers: ["options?.onFetchInvocation?.();", "options?.onFetchDispatch?.();"],
    behaviorProof: new URL("./anthropic-transport-stream.test.ts", import.meta.url),
    behaviorMarkers: [
      "records $expectedOutcome accounting for native standalone DONE",
      'type: "invocation"',
    ],
  },
  "azure-openai-responses/managed": {
    callbackProof: new URL("./openai-provider-transport-accounting.test.ts", import.meta.url),
    callbackMarkers: [
      "retains Azure invocation accounting from a legacy-only attested host",
      "options.onFetchDispatch?.();",
    ],
    behaviorProof: new URL("./openai-provider-transport-accounting.test.ts", import.meta.url),
    behaviorMarkers: ["call-azure-legacy-only", "invocationEvents(events)"],
  },
  "openai-chatgpt-responses/managed": {
    callbackProof: new URL(
      "./openai-provider-transport-accounting.test-support.ts",
      import.meta.url,
    ),
    callbackMarkers: ["options?.onFetchInvocation?.();", "options?.onFetchDispatch?.();"],
    behaviorProof: new URL("./openai-provider-transport-accounting.test.ts", import.meta.url),
    behaviorMarkers: [
      "executes the managed ChatGPT route with invocation accounting",
      "call-chatgpt-managed",
      "invocationEvents(events)",
    ],
  },
  "openai-chatgpt-responses/native-sse": {
    callbackProof: new URL(
      "./openai-provider-transport-accounting.native.test.ts",
      import.meta.url,
    ),
    callbackMarkers: ["options.onFetchInvocation?.();", "options.onFetchDispatch?.();"],
    behaviorProof: new URL(
      "./openai-provider-transport-accounting.native.test.ts",
      import.meta.url,
    ),
    behaviorMarkers: [
      "uses native SSE header authority and nested event-header precedence",
      "invocationEvents(events)",
    ],
  },
  "openai-chatgpt-responses/native-websocket": {
    callbackProof: new URL("../providers/openai-chatgpt-responses.ts", import.meta.url),
    callbackMarkers: ["submitWebSocketFrame", "transportAccounting.observeInvocation"],
    behaviorProof: new URL(
      "./openai-provider-transport-accounting.native.test.ts",
      import.meta.url,
    ),
    behaviorMarkers: ["uses nested WebSocket event headers", "invocationEvents(events)"],
  },
  "openai-responses/managed": {
    callbackProof: new URL(
      "./openai-provider-transport-accounting.test-support.ts",
      import.meta.url,
    ),
    callbackMarkers: ["options?.onFetchInvocation?.();", "options?.onFetchDispatch?.();"],
    behaviorProof: new URL("./openai-provider-transport-accounting.test.ts", import.meta.url),
    behaviorMarkers: [
      "records SDK retries from admitted fetch invocations, not retry headers",
      "invocationEvents(events)",
      "attemptEvents(events)",
    ],
  },
} as const satisfies Record<FrontierInvocationRoute, RouteProof>;

describe("frontier invocation route coverage", () => {
  it("keeps every supported frontier producer variant explicit", () => {
    expect(Object.keys(FRONTIER_INVOCATION_ROUTES)).toEqual([
      "anthropic-messages/builtin",
      "anthropic-messages/managed",
      "azure-openai-responses/managed",
      "openai-chatgpt-responses/managed",
      "openai-chatgpt-responses/native-sse",
      "openai-chatgpt-responses/native-websocket",
      "openai-responses/managed",
    ]);
  });

  it.each(Object.entries(FRONTIER_INVOCATION_ROUTES))(
    "%s exercises the callback and validates emitted invocation behavior",
    async (_route, proof) => {
      const [callbackSource, behaviorSource] = await Promise.all([
        readFile(fileURLToPath(proof.callbackProof), "utf8"),
        readFile(fileURLToPath(proof.behaviorProof), "utf8"),
      ]);

      for (const marker of proof.callbackMarkers) {
        expect(callbackSource).toContain(marker);
      }
      for (const marker of proof.behaviorMarkers) {
        expect(behaviorSource).toContain(marker);
      }
    },
  );
});
