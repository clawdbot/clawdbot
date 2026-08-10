import { describe, expect, it } from "vitest";
import {
  anthropicSseTailHasModelFragment,
  classifyUnknownAnthropicSseFrame,
  createAnthropicEndpointAuthority,
  createAnthropicStreamTerminalCompleteness,
} from "./anthropic-stream-terminal.js";

describe("Anthropic stream terminal authority", () => {
  it.each([
    { tail: ": keepalive\n", expected: false },
    { tail: "event: vendor_ping\ndata: heartbeat\n", expected: false },
    { tail: "event: messa", expected: true },
    { tail: "event: messa\n", expected: false },
    { tail: "event: messa\ndata: heartbeat", expected: false },
    { tail: "event: message_vendor", expected: false },
    { tail: "event: message_stop\n", expected: true },
    { tail: 'data: {"type":"message_stop"', expected: true },
    {
      tail: 'event: vendor_ping\ndata: {"type":"content_block_delta"',
      expected: true,
    },
    { tail: 'data: {"type":"ping"', expected: false },
    { tail: 'event: vendor_ping\ndata: {"type":"ping"', expected: false },
  ])("classifies incomplete SSE tail $tail", ({ tail, expected }) => {
    expect(anthropicSseTailHasModelFragment(tail)).toBe(expected);
  });

  it.each([
    ['{"type":"content_block_delta"}', "model_event"],
    ['{"type":"vendor_ping"}', "ignore"],
    ["[]", "ignore"],
    ["heartbeat", "ignore"],
  ] as const)("classifies an unknown-envelope payload as %s", (data, expected) => {
    expect(classifyUnknownAnthropicSseFrame(data, JSON.parse)).toBe(expected);
  });

  it.each(['{"type":', "["])("ignores malformed unknown-envelope payloads", (data) => {
    expect(classifyUnknownAnthropicSseFrame(data, JSON.parse)).toBe("ignore");
  });

  it.each([
    {
      provider: "anthropic",
      endpointClass: "anthropic-public",
      expected: true,
    },
    {
      provider: "provider-alias",
      endpointClass: "anthropic-public",
      expected: true,
    },
    {
      provider: " Anthropic ",
      endpointClass: "default",
      expected: true,
    },
    {
      provider: "provider-alias",
      endpointClass: "default",
      expected: true,
    },
    {
      provider: "anthropic",
      endpointClass: "custom",
      expected: false,
    },
    {
      provider: "provider-alias",
      endpointClass: "custom",
      expected: false,
    },
  ])(
    "returns $expected for $provider on $endpointClass",
    ({ provider, endpointClass, expected }) => {
      const authority = createAnthropicEndpointAuthority({
        provider,
        resolveEndpointClass: () => endpointClass,
      });
      authority.observePhysicalDispatch("https://example.test");
      expect(authority.snapshot().requiresMessageStop).toBe(expected);
    },
  );

  it("requires strict terminal authority across same-class cross-origin redirects", () => {
    const authority = createAnthropicEndpointAuthority({
      provider: "anthropic",
      resolveEndpointClass: () => "custom",
    });
    authority.observePhysicalDispatch("https://first.example/v1/messages");
    authority.observePhysicalDispatch("https://second.example/v1/messages");

    expect(authority.snapshot()).toEqual({
      endpointClass: "custom",
      requiresMessageStop: true,
      traceState: "partial",
    });
  });

  it("retains exact authority across repeated same-origin dispatches", () => {
    const authority = createAnthropicEndpointAuthority({
      provider: "anthropic",
      resolveEndpointClass: () => "custom",
    });
    authority.observePhysicalDispatch("https://compatible.example/v1/messages");
    authority.observePhysicalDispatch("https://compatible.example/v1/messages?retry=1");

    expect(authority.snapshot()).toEqual({
      endpointClass: "custom",
      requiresMessageStop: false,
      traceState: "exact",
    });
  });

  it("keeps legacy physical observations partial without attested provenance", () => {
    const authority = createAnthropicEndpointAuthority({
      provider: "anthropic",
      resolveEndpointClass: () => "custom",
    });
    authority.observePhysicalDispatch("https://compatible.example/v1/messages", {
      attested: false,
    });

    expect(authority.snapshot()).toEqual({
      endpointClass: "custom",
      requiresMessageStop: true,
      traceState: "partial",
    });
  });

  it.each([
    { endpointClass: "custom" },
    { endpointClass: "anthropic-public" },
    { endpointClass: "" },
  ])(
    "classifies provisional $endpointClass authority without relaxing message_stop",
    ({ endpointClass }) => {
      const authority = createAnthropicEndpointAuthority({
        provider: "anthropic",
        resolveEndpointClass: () => endpointClass,
      });
      authority.observeProvisional("https://example.test");

      expect(authority.snapshot()).toMatchObject({
        requiresMessageStop: true,
        traceState: endpointClass ? "partial" : "unknown",
      });
    },
  );

  it("rejects standalone DONE without an explicit terminal stop reason", () => {
    const compatible = createAnthropicStreamTerminalCompleteness({
      requireMessageStop: false,
    });
    compatible.observeMessageStart();
    compatible.observeStandaloneDone();
    expect(() => compatible.assertComplete()).toThrow("ended before message_stop");

    const official = createAnthropicStreamTerminalCompleteness({
      requireMessageStop: true,
    });
    official.observeMessageStart();
    official.observeStandaloneDone();
    expect(() => official.assertComplete()).toThrow("ended before message_stop");
  });

  it("rejects standalone DONE before message_start", () => {
    const compatible = createAnthropicStreamTerminalCompleteness({
      requireMessageStop: false,
    });
    compatible.observeStandaloneDone();
    expect(() => compatible.assertComplete()).toThrow("ended before message_stop");
  });

  it("rejects message_stop without a terminal message_delta", () => {
    const official = createAnthropicStreamTerminalCompleteness({
      requireMessageStop: true,
    });
    official.observeMessageStart();
    official.observeMessageStop();
    expect(() => official.assertComplete()).toThrow("ended before message_stop");
  });

  it("requires non-empty mapped stop reasons and rejects bare EOF", () => {
    const blankReason = createAnthropicStreamTerminalCompleteness({
      requireMessageStop: false,
    });
    blankReason.observeMappedStopReason("  ");
    expect(() => blankReason.assertComplete()).toThrow("ended before message_stop");

    const bareEof = createAnthropicStreamTerminalCompleteness({
      requireMessageStop: false,
    });
    expect(() => bareEof.assertComplete()).toThrow("ended before message_stop");
  });

  it("rejects compatible mapped-stop EOF before message_start", () => {
    const compatible = createAnthropicStreamTerminalCompleteness({
      requireMessageStop: false,
    });
    compatible.observeMessageDelta();
    compatible.observeMappedStopReason("end_turn");

    expect(() => compatible.assertComplete()).toThrow("ended before message_stop");
  });

  it("rejects compatible EOF after a structurally complete content block", () => {
    const compatible = createAnthropicStreamTerminalCompleteness({
      requireMessageStop: false,
    });
    compatible.observeMessageStart();
    compatible.observeContentBlockStart(0);
    compatible.observeContentBlockStop(0);

    expect(() => compatible.assertComplete()).toThrow("ended before message_stop");
  });

  it("rejects compatible clean EOF after message_start alone", () => {
    const compatible = createAnthropicStreamTerminalCompleteness({
      requireMessageStop: false,
    });
    compatible.observeMessageStart();

    expect(() => compatible.assertComplete()).toThrow("ended before message_stop");
  });

  it.each(["message_stop", "mapped_stop_reason", "standalone_done"] as const)(
    "rejects %s when a content block remains open",
    (terminal) => {
      const compatible = createAnthropicStreamTerminalCompleteness({
        requireMessageStop: false,
      });
      compatible.observeContentBlockStart(0);
      if (terminal === "message_stop") {
        compatible.observeMessageStop();
      } else if (terminal === "mapped_stop_reason") {
        compatible.observeMappedStopReason("end_turn");
      } else {
        compatible.observeStandaloneDone();
      }
      expect(() => compatible.assertComplete()).toThrow("ended before message_stop");
    },
  );

  it.each([
    {
      name: "reused content block index",
      observe: (terminal: ReturnType<typeof createAnthropicStreamTerminalCompleteness>) => {
        terminal.observeMessageStart();
        terminal.observeContentBlockStart(0);
        terminal.observeContentBlockStop(0);
        terminal.observeContentBlockStart(0);
        terminal.observeContentBlockStop(0);
        terminal.observeMessageDelta();
        terminal.observeMessageStop();
      },
    },
    {
      name: "message delta before block stop",
      observe: (terminal: ReturnType<typeof createAnthropicStreamTerminalCompleteness>) => {
        terminal.observeMessageStart();
        terminal.observeContentBlockStart(0);
        terminal.observeMessageDelta();
        terminal.observeContentBlockStop(0);
        terminal.observeMessageStop();
      },
    },
    {
      name: "block after message delta",
      observe: (terminal: ReturnType<typeof createAnthropicStreamTerminalCompleteness>) => {
        terminal.observeMessageStart();
        terminal.observeMessageDelta();
        terminal.observeContentBlockStart(0);
        terminal.observeContentBlockStop(0);
        terminal.observeMessageStop();
      },
    },
    {
      name: "duplicate message delta",
      observe: (terminal: ReturnType<typeof createAnthropicStreamTerminalCompleteness>) => {
        terminal.observeMessageStart();
        terminal.observeMessageDelta();
        terminal.observeMessageDelta();
        terminal.observeMessageStop();
      },
    },
    {
      name: "invalid content block index",
      observe: (terminal: ReturnType<typeof createAnthropicStreamTerminalCompleteness>) => {
        terminal.observeMessageStart();
        terminal.observeContentBlockStart("0");
        terminal.observeContentBlockStop("0");
        terminal.observeMessageDelta();
        terminal.observeMessageStop();
      },
    },
  ])("rejects $name under every endpoint authority", ({ observe }) => {
    const strict = createAnthropicStreamTerminalCompleteness({ requireMessageStop: true });
    observe(strict);
    expect(() => strict.assertComplete()).toThrow("ended before message_stop");

    const compatible = createAnthropicStreamTerminalCompleteness({ requireMessageStop: false });
    observe(compatible);
    expect(() => compatible.assertComplete()).toThrow("ended before message_stop");
  });

  it("downgrades only a compatible provider's omitted block start", () => {
    const observe = (
      terminal: ReturnType<typeof createAnthropicStreamTerminalCompleteness>,
    ): void => {
      terminal.observeMessageStart();
      terminal.observeContentBlockDelta(0);
      terminal.observeContentBlockStop(0);
      terminal.observeMessageDelta();
      terminal.observeMessageStop();
    };

    const strict = createAnthropicStreamTerminalCompleteness({ requireMessageStop: true });
    observe(strict);
    expect(() => strict.assertComplete()).toThrow("ended before message_stop");

    const compatible = createAnthropicStreamTerminalCompleteness({ requireMessageStop: false });
    observe(compatible);
    expect(compatible.assertComplete()).toEqual({
      state: "unverified",
      reason: "compatible_structural_ambiguity",
    });
  });
});
