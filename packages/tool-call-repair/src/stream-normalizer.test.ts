import { describe, expect, it } from "vitest";
import { parseStandalonePlainTextToolCallBlocks } from "./payload.js";
import {
  normalizePlainTextToolCallStreamEvents,
  projectScrubbedPlainTextToolCallMessage,
  type PlainTextToolCallMessageNormalization,
  type PlainTextToolCallNameMatcher,
} from "./stream-normalizer.js";

const matcher: PlainTextToolCallNameMatcher = {
  hasExactName: (name) => name === "read",
  hasNamePrefix: (prefix) => "read".startsWith(prefix),
};

type Terminal = "done" | "eof" | "error";

function parseSplitCall(parts: readonly string[]) {
  let offset = 0;
  const lineBreakOffsets = new Set(
    parts.slice(0, -1).map((part) => {
      offset += part.length;
      return offset;
    }),
  );
  return parseStandalonePlainTextToolCallBlocks(parts.join(""), undefined, {
    lineBreakOffsets,
  });
}

function textContent(text: string) {
  return [{ type: "text", text }];
}

function textDelta(delta: string, snapshot: string) {
  return {
    type: "text_delta",
    contentIndex: 0,
    delta,
    partial: { role: "assistant", content: textContent(snapshot) },
  };
}

async function normalize(events: readonly unknown[]): Promise<Record<string, unknown>[]> {
  async function* source() {
    yield* events;
  }
  const normalized: Record<string, unknown>[] = [];
  const scrubMessage = (message: unknown, options?: { preserveEmptyTextBlocks?: boolean }) =>
    projectScrubbedPlainTextToolCallMessage({
      matcher,
      message,
      preserveEmptyTextBlocks: options?.preserveEmptyTextBlocks,
    });
  for await (const event of normalizePlainTextToolCallStreamEvents(source(), {
    matcher,
    createPromotedToolCallEvents: () => [],
    normalizeTerminalMessage: ({
      message,
      preserveEmptyTextBlocks,
    }): PlainTextToolCallMessageNormalization => {
      const scrubbed = scrubMessage(message, { preserveEmptyTextBlocks });
      return scrubbed ? { kind: "scrubbed", ...scrubbed } : undefined;
    },
  })) {
    if (event && typeof event === "object") {
      normalized.push(event as Record<string, unknown>);
    }
  }
  return normalized;
}

function withTerminal(
  deltas: readonly Record<string, unknown>[],
  terminal: Terminal,
  snapshot: string,
): Record<string, unknown>[] {
  if (terminal === "eof") {
    return [...deltas];
  }
  const message = { role: "assistant", content: textContent(snapshot), stopReason: "length" };
  return terminal === "done"
    ? [...deltas, { type: "done", reason: "length", message }]
    : [...deltas, { type: "error", partial: message, error: { content: textContent(snapshot) } }];
}

function textDeltas(events: readonly Record<string, unknown>[]): unknown[] {
  return events.filter((event) => event.type === "text_delta").map((event) => event.delta);
}

function expectTerminalContent(
  events: readonly Record<string, unknown>[],
  terminal: Terminal,
  content: unknown,
) {
  if (terminal === "done") {
    expect(events.at(-1)?.message).toMatchObject({ content });
  } else if (terminal === "error") {
    const partialContent =
      Array.isArray(content) && content.length === 0 ? textContent("") : content;
    expect(events.at(-1)?.partial).toMatchObject({ content: partialContent });
    expect(events.at(-1)?.error).toMatchObject({ content });
  }
}

describe("normalizePlainTextToolCallStreamEvents over-cap XML", () => {
  it.each<Terminal>(["done", "error", "eof"])(
    "suppresses an incomplete multibyte prefix at %s",
    async (terminal) => {
      const raw = `<function=read>${"\u00a0".repeat(128_001)}`;
      const events = await normalize(withTerminal([textDelta(raw, raw)], terminal, raw));

      expect(textDeltas(events)).toEqual([]);
      expect(JSON.stringify(events)).not.toContain("<function=read>");
      expectTerminalContent(events, terminal, []);
    },
  );

  it.each<Terminal>(["done", "error", "eof"])(
    "preserves visible text that invalidates an incomplete over-cap prefix at %s",
    async (terminal) => {
      const prefix = `<function=read>${"\u00a0".repeat(128_001)}`;
      const visible = "Visible answer";
      const events = await normalize(
        withTerminal(
          [textDelta(prefix, prefix), textDelta(visible, `${prefix}${visible}`)],
          terminal,
          `${prefix}${visible}`,
        ),
      );

      expect(textDeltas(events)).toEqual([visible]);
      expect(JSON.stringify(events)).not.toContain("<function=read>");
      if (terminal !== "eof") {
        expectTerminalContent(events, terminal, textContent(visible));
      }
    },
  );

  it.each<Terminal>(["done", "error", "eof"])(
    "preserves a 400k suffix after a complete byte-over-cap call at %s",
    async (terminal) => {
      const call = `<function=read>${"\u00a0".repeat(128_001)}</function>`;
      const visible = `${"a".repeat(150_000)}MIDDLE${"b".repeat(250_000)}`;
      const raw = `${call}\n${visible}`;
      const events = await normalize(withTerminal([textDelta(raw, raw)], terminal, raw));

      expect(textDeltas(events)).toEqual([visible]);
      expect(String(textDeltas(events)[0])).toHaveLength(visible.length);
      expect(String(textDeltas(events)[0])).toContain("MIDDLE");
      expect(JSON.stringify(events)).not.toContain("<function=read>");
      expectTerminalContent(events, terminal, textContent(visible));
    },
  );

  it("does not leak a complete parameter tail before a split function close", async () => {
    const prefix = `<function=read><parameter=path>${"x".repeat(256_001)}</parameter>`;
    const raw = `${prefix}</function>`;
    const events = await normalize([textDelta(prefix, prefix), textDelta("</function>", raw)]);

    expect(events).toEqual([]);
  });

  it("suppresses XML-punctuated parameter names after the byte cap", async () => {
    const prefix = `<function=read><parameter=path>${"x".repeat(256_001)}</parameter>`;
    const tail = "<parameter=foo.bar>SECRET</parameter></function>";
    const events = await normalize([
      textDelta(prefix, prefix),
      textDelta(tail, `${prefix}${tail}`),
    ]);

    expect(events).toEqual([]);
  });

  it("uses repaired text-block joins for done-only byte-over-cap calls", async () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "[read]" },
        {
          type: "text",
          text: `<parameter=path>${"\u00a0".repeat(128_001)}</parameter></function>`,
        },
      ],
      stopReason: "length",
    };
    const events = await normalize([{ type: "done", reason: "length", message }]);

    expect(events).toEqual([
      { type: "done", reason: "length", message: { ...message, content: [] } },
    ]);
  });

  it.each([
    `<parameter=path>${"x".repeat(256_001)}`,
    `{"path":"${"x".repeat(256_001)}`,
    `{"path":"${"x".repeat(256_001)}"}`,
    `{"path":"${"x".repeat(256_001)}"}\n[END_TOOL_REQU`,
  ])("scrubs incomplete split named calls", async (payload) => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "[read]" },
        { type: "text", text: payload },
      ],
      stopReason: "length",
    };
    const events = await normalize([{ type: "done", reason: "length", message }]);

    expect(events.at(-1)?.message).toMatchObject({ content: [] });
    expect(JSON.stringify(events)).not.toContain("[read]");
  });

  it("scrubs an incomplete named call from a done-only snapshot", async () => {
    const raw = "<function=read><parameter=path>SECRET";
    const message = { role: "assistant", content: textContent(raw), stopReason: "length" };
    const events = await normalize([{ type: "done", reason: "length", message }]);

    expect(events).toEqual([
      { type: "done", reason: "length", message: { ...message, content: [] } },
    ]);
  });

  it("repairs split calls after visible text", async () => {
    const payload = `<parameter=path>${"x".repeat(256_001)}</parameter></function>`;
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "Visible\n[read]" },
        { type: "text", text: payload },
      ],
      stopReason: "length",
    };
    const events = await normalize([{ type: "done", reason: "length", message }]);

    expect(events.at(-1)?.message).toMatchObject({ content: textContent("Visible\n") });
  });

  it("merges exact and repaired over-cap ranges", async () => {
    const exact = `<function=read>${"\u00a0".repeat(128_001)}</function>\n`;
    const split = `<parameter=path>${"y".repeat(256_001)}</parameter></function>`;
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: exact },
        { type: "text", text: "[read]" },
        { type: "text", text: split },
      ],
      stopReason: "length",
    };
    const events = await normalize([{ type: "done", reason: "length", message }]);

    expect(events.at(-1)?.message).toMatchObject({ content: [] });
  });

  it("keeps literal close markers inside split parameter values", () => {
    const parts = ["[write]", "<parameter=content>literal </function> tail</parameter></function>"];

    expect(parseSplitCall(parts)?.[0]?.arguments).toEqual({
      content: "literal </function> tail",
    });
  });

  it.each([
    ["<function=read><parameter=path> ", "/tmp</parameter></function>"],
    ["[read]", '  {"path":"/tmp"}[/read]'],
  ])("repairs a boundary inside leading horizontal whitespace", (first, second) => {
    expect(parseSplitCall([first, second])?.[0]?.name).toBe("read");
  });

  it.each(["\n", "\r\n"])("does not duplicate an existing parameter line break %j", (lineBreak) => {
    const first = "<function=read><parameter=path>";
    const second = `  ${lineBreak}/tmp</parameter></function>`;

    expect(parseSplitCall([first, second])?.[0]?.arguments).toEqual({ path: `  ${lineBreak}/tmp` });
  });

  it("preserves non-text ordering around the visible suffix", async () => {
    const call = `<function=read>${"\u00a0".repeat(128_001)}</function>`;
    const image = { type: "image", data: "opaque" };
    const message = {
      role: "assistant",
      content: [{ type: "text", text: call }, image, { type: "text", text: "Visible" }],
      stopReason: "length",
    };
    const events = await normalize([{ type: "done", reason: "length", message }]);

    expect(events.at(-1)?.message).toMatchObject({
      content: [image, { type: "text", text: "Visible" }],
    });
  });

  it("strips every leading serialized call after the first over-cap call", async () => {
    const overCap = `<function=read>${"\u00a0".repeat(128_001)}</function>`;
    const second = "<function=read></function>";
    const raw = `${overCap}\n${second}\nVisible`;
    const events = await normalize([
      {
        type: "done",
        reason: "length",
        message: { role: "assistant", content: textContent(raw), stopReason: "length" },
      },
    ]);

    expect(events.at(-1)?.message).toMatchObject({ content: textContent("Visible") });
  });

  it("suppresses an incomplete follow-on call prefix", async () => {
    const raw = `<function=read>${"\u00a0".repeat(128_001)}</function>\n[tool:read`;
    const events = await normalize([textDelta(raw, raw)]);

    expect(events).toEqual([]);
  });

  it("keeps an incomplete follow-on call private until terminal promotion", async () => {
    const raw = "<function=read></function>\n<function=read><parameter=path>SECRET";
    async function* source() {
      yield textDelta(raw, raw);
      yield {
        type: "done",
        reason: "stop",
        message: { role: "assistant", content: textContent(raw), stopReason: "stop" },
      };
    }
    const message = {
      role: "assistant",
      content: [{ type: "toolCall", name: "read", arguments: { path: "SECRET" } }],
      stopReason: "toolUse",
    };
    const events: Record<string, unknown>[] = [];
    for await (const event of normalizePlainTextToolCallStreamEvents(source(), {
      matcher,
      createPromotedToolCallEvents: () => [],
      normalizeTerminalMessage: () => ({
        kind: "promoted",
        message,
        sourceToProjectedContentIndex: new Map(),
      }),
    })) {
      events.push(event as Record<string, unknown>);
    }

    expect(events.map((event) => event.type)).toEqual(["start", "done"]);
    expect(JSON.stringify(events.slice(0, -1))).not.toContain("SECRET");
  });

  it.each(['[tool:read] {"path":"SECRET"}', 'analysis to=read code {"path":"SECRET"}'])(
    "keeps every split optional closer private for %s",
    async (call) => {
      const marker = "<|call|>";
      for (let split = 1; split < marker.length; split += 1) {
        const first = call + marker.slice(0, split);
        const raw = call + marker;
        async function* source() {
          yield textDelta(first, first);
          yield textDelta(marker.slice(split), raw);
          yield {
            type: "done",
            reason: "stop",
            message: { role: "assistant", content: textContent(raw), stopReason: "stop" },
          };
        }
        const message = {
          role: "assistant",
          content: [{ type: "toolCall", name: "read", arguments: {} }],
          stopReason: "toolUse",
        };
        const events: Record<string, unknown>[] = [];
        for await (const event of normalizePlainTextToolCallStreamEvents(source(), {
          matcher,
          createPromotedToolCallEvents: () => [],
          normalizeTerminalMessage: () => ({
            kind: "promoted",
            message,
            sourceToProjectedContentIndex: new Map(),
          }),
        })) {
          events.push(event as Record<string, unknown>);
        }

        expect(events.map((event) => event.type)).toEqual(["start", "done"]);
        expect(JSON.stringify(events.slice(0, -1))).not.toContain(marker.slice(0, split));
      }
    },
  );

  it.each([
    ["tool bracket", (payload: string) => `[tool:read] ${payload}`, "<|call|>"],
    ["tool bracket legacy", (payload: string) => `[tool:read] ${payload}`, "[END_TOOL_REQUEST]"],
    ["tool bracket named", (payload: string) => `[tool:read] ${payload}`, "[/read]"],
    ["Harmony", (payload: string) => `analysis to=read code ${payload}`, "<|call|>"],
    ["named bracket", (payload: string) => `[read]\n${payload}`, "[/read]"],
    ["legacy named bracket", (payload: string) => `[read]\n${payload}`, "[END_TOOL_REQUEST]"],
  ])("keeps split over-cap closing markers private for %s", async (_name, build, marker) => {
    const call = build(`{"path":"${"x".repeat(256_001)}"}`);
    const visible = "Visible";
    for (let split = 1; split < marker.length; split += 1) {
      const events = await normalize([
        { type: "text_delta", contentIndex: 0, delta: call + marker.slice(0, split) },
        { type: "text_delta", contentIndex: 0, delta: marker.slice(split) + `\n${visible}` },
      ]);

      expect(textDeltas(events)).toEqual([visible]);
      expect(JSON.stringify(events)).not.toContain(marker);
    }
  });

  it("keeps an optional closer private when it starts after the over-cap payload", async () => {
    const call = `[tool:read] {"path":"${"x".repeat(256_001)}"}`;
    const marker = "<|call|>";
    const events = await normalize([
      { type: "text_delta", contentIndex: 0, delta: call },
      { type: "text_delta", contentIndex: 0, delta: `${marker}\nVisible` },
    ]);

    expect(textDeltas(events)).toEqual(["Visible"]);
    expect(JSON.stringify(events)).not.toContain(marker);
  });

  it("preserves a follow-on named JSON call invalidated by visible tail text", async () => {
    const overCap = `<function=read>${"\u00a0".repeat(128_001)}</function>`;
    const visible = '[read]\n{"path":"/tmp"} visible';
    const raw = `${overCap}\n${visible}`;
    const events = await normalize([
      {
        type: "done",
        reason: "length",
        message: { role: "assistant", content: textContent(raw), stopReason: "length" },
      },
    ]);

    expect(events.at(-1)?.message).toMatchObject({ content: textContent(visible) });
  });

  it("preserves equal visible suffixes from independent calls", async () => {
    const call = `<function=read>${"\u00a0".repeat(128_001)}</function>\nOK\n`;
    const events = await normalize([textDelta(call, call), textDelta(call, `${call}${call}`)]);

    expect(textDeltas(events)).toEqual(["OK\n", "OK\n"]);
  });

  it("remaps buffered auxiliary indexes after compact terminal scrubbing", async () => {
    const raw = `[tool:read]\n<parameter=path>\n${"x".repeat(256_001)}`;
    const thinking = { type: "thinking", thinking: "checking" };
    const message = {
      role: "assistant",
      content: [{ type: "text", text: raw }, thinking],
      stopReason: "length",
    };
    const events = await normalize([
      textDelta(raw, raw),
      {
        type: "thinking_delta",
        contentIndex: 1,
        delta: "checking",
        partial: { role: "assistant", content: [{ type: "text", text: raw }, thinking] },
      },
      { type: "done", reason: "length", message },
    ]);

    expect(events.map((event) => event.type)).toEqual(["thinking_delta", "done"]);
    expect(events[0]).toMatchObject({ contentIndex: 0, partial: { content: [thinking] } });
    expect(events[1]?.message).toMatchObject({ content: [thinking] });
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
  });

  it("uses the compact error projection when no partial is present", async () => {
    const raw = `[tool:read]\n<parameter=path>\n${"x".repeat(256_001)}`;
    const thinking = { type: "thinking", thinking: "checking" };
    const error = { role: "assistant", content: [{ type: "text", text: raw }, thinking] };
    const events = await normalize([
      textDelta(raw, raw),
      {
        type: "thinking_delta",
        contentIndex: 1,
        delta: "checking",
        partial: error,
      },
      { type: "error", error },
    ]);

    expect(events[0]).toMatchObject({ contentIndex: 0, partial: { content: [thinking] } });
    expect(events.at(-1)?.error).toMatchObject({ content: [thinking] });
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
  });

  it.each(["thinking_delta", "text_delta"])(
    "scrubs raw cumulative snapshots from later %s events",
    async (type) => {
      const call = `<function=read>${"\u00a0".repeat(128_001)}</function>`;
      const visible = type === "thinking_delta" ? "checking" : "Visible";
      const block =
        type === "thinking_delta"
          ? { type: "thinking", thinking: visible }
          : { type: "text", text: `${call}${visible}` };
      const later = {
        type,
        contentIndex: type === "thinking_delta" ? 1 : 0,
        delta: visible,
        partial: {
          role: "assistant",
          content: type === "thinking_delta" ? [{ type: "text", text: call }, block] : [block],
        },
      };
      const events = await normalize([textDelta(call, call), later]);

      expect(JSON.stringify(events)).not.toContain("<function=read>");
      expect(events.at(-1)?.delta).toBe(visible);
    },
  );

  it("drains every unique auxiliary lifecycle event at the queue cap", async () => {
    const candidate = '[tool:read] {"path":"SECRET"';
    const lifecycles = Array.from({ length: 129 }, (_, index) => [
      { type: "thinking_start", contentIndex: index + 1 },
      { type: "thinking_end", contentIndex: index + 1, content: "" },
    ]).flat();
    const events = await normalize([
      { type: "text_delta", contentIndex: 0, delta: candidate },
      ...lifecycles,
    ]);

    expect(events[0]?.type).toBe("start");
    expect(events.filter((event) => event.type === "thinking_start")).toHaveLength(129);
    expect(events.filter((event) => event.type === "thinking_end")).toHaveLength(129);
    expect(events.slice(1)).toMatchObject(lifecycles);
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });

  it("drains merged auxiliary deltas at the queue byte cap", async () => {
    const candidate = '[tool:read] {"path":"SECRET"';
    const chunk = "x".repeat(128_001);
    const events = await normalize([
      { type: "text_delta", contentIndex: 0, delta: candidate },
      { type: "thinking_delta", contentIndex: 1, delta: chunk },
      { type: "thinking_delta", contentIndex: 1, delta: chunk },
      { type: "thinking_delta", contentIndex: 1, delta: chunk },
    ]);

    expect(events[0]?.type).toBe("start");
    expect(events.filter((event) => event.type === "thinking_delta")).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });

  it("preserves clean required partials after scrubbing a call", async () => {
    const call = `<function=read><parameter=path>${"x".repeat(256_001)}</parameter></function>`;
    const partial = {
      role: "assistant",
      content: [
        { type: "text", text: "Visible" },
        { type: "thinking", thinking: "checking" },
      ],
    };
    const events = await normalize([
      { type: "text_delta", contentIndex: 0, delta: `${call}\nVisible` },
      { type: "thinking_start", contentIndex: 1, partial },
    ]);

    expect(events.at(-1)).toEqual({ type: "thinking_start", contentIndex: 1, partial });
  });

  it("preserves clean required partials while draining buffered auxiliary events", async () => {
    const partial = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "checking" }],
    };
    const events = await normalize([
      { type: "text_delta", contentIndex: 0, delta: '[tool:read] {"path":"SECRET"' },
      { type: "thinking_start", contentIndex: 1, partial },
    ]);

    expect(events).toEqual([{ type: "thinking_start", contentIndex: 1, partial }]);
  });

  it("replays a false prefix after auxiliary queue compaction", async () => {
    const prefix = "[tool:re";
    const visible = `${prefix} nope`;
    const sourceEvents = [
      { type: "text_delta", contentIndex: 0, delta: prefix },
      ...Array.from({ length: 257 }, () => ({
        type: "thinking_delta",
        contentIndex: 1,
        delta: "x",
      })),
      { type: "text_delta", contentIndex: 0, delta: " nope" },
    ];
    const events = await normalize(sourceEvents);

    expect(textDeltas(events).join("")).toBe(visible);
  });

  it("scans complete under-cap call sequences linearly", () => {
    const callCount = 64;
    let exactNameChecks = 0;
    const countingMatcher: PlainTextToolCallNameMatcher = {
      hasExactName: (name) => {
        exactNameChecks += 1;
        return name === "read";
      },
      hasNamePrefix: (prefix) => "read".startsWith(prefix),
    };
    const text = Array.from({ length: callCount }, () => "<function=read></function>").join("\n");

    expect(
      projectScrubbedPlainTextToolCallMessage({
        matcher: countingMatcher,
        message: { role: "assistant", content: text },
      }),
    ).toBeUndefined();
    expect(exactNameChecks).toBeLessThanOrEqual(callCount * 3);
  });

  it("scrubs an under-cap call after visible terminal text", () => {
    const message = {
      role: "assistant",
      content: "Visible answer\n<function=read></function>",
    };

    expect(projectScrubbedPlainTextToolCallMessage({ matcher, message })?.message).toEqual({
      ...message,
      content: "Visible answer\n",
    });
  });

  it.each(["comment", "analysis", "final", "<", "["])(
    "preserves the unnamed protocol prefix %s in terminal prose",
    (prefix) => {
      const message = { role: "assistant", content: `Visible answer\n${prefix}` };
      expect(projectScrubbedPlainTextToolCallMessage({ matcher, message })).toBeUndefined();
    },
  );

  it("suppresses a complete call sequence over the aggregate byte budget", async () => {
    const call = "<function=read></function>\n";
    const raw = call.repeat(10_000);

    expect(new TextEncoder().encode(raw).byteLength).toBeGreaterThan(256_000);
    expect(await normalize([textDelta(raw, raw)])).toEqual([]);
  });

  it("hands an aggregate-over-cap active tail to bounded suppression", async () => {
    const prefix = "<function=read></function>\n".repeat(9_500);
    const active = "<function=read><parameter=path>secret";
    const close = "</parameter></function>\nVisible";
    const events = await normalize([
      textDelta(`${prefix}${active}`, `${prefix}${active}`),
      textDelta(close, `${prefix}${active}${close}`),
    ]);

    expect(textDeltas(events)).toEqual(["Visible"]);
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  it("keeps only a bounded active marker after an aggregate-over-cap prefix", async () => {
    const prefix = "<function=read></function>\n".repeat(9_500);
    const marker = "[tool:re";
    const visible = `${marker} nope`;
    const events = await normalize([
      textDelta(`${prefix}${marker}`, `${prefix}${marker}`),
      textDelta(" nope", `${prefix}${visible}`),
    ]);

    expect(textDeltas(events)).toEqual([visible]);
    expect(JSON.stringify(events)).not.toContain("<function=read>");
  });

  it("keeps post-JSON structural whitespace private without accumulating it", async () => {
    const prefix = `[read]\n{"path":"${"x".repeat(256_001)}`;
    const whitespaceChunks = Array.from({ length: 64 }, () => " ".repeat(4096));
    const tail = "[/read]\nVisible";
    const raw = `${prefix}"}${whitespaceChunks.join("")}${tail}`;
    const events = await normalize([
      { type: "text_delta", contentIndex: 0, delta: prefix },
      { type: "text_delta", contentIndex: 0, delta: '"}' },
      ...whitespaceChunks.map((delta) => ({ type: "text_delta", contentIndex: 0, delta })),
      { type: "text_delta", contentIndex: 0, delta: tail },
      {
        type: "done",
        reason: "length",
        message: { role: "assistant", content: textContent(raw), stopReason: "length" },
      },
    ]);

    expect(textDeltas(events)).toEqual(["Visible"]);
    expectTerminalContent(events, "done", textContent("Visible"));
    expect(JSON.stringify(events)).not.toContain("[read]");
  });

  it("bounds blank-line buffering after a complete call", async () => {
    const call = "<function=read></function>\n";
    const whitespaceChunks = Array.from({ length: 65 }, () => "\n".repeat(4096));
    const events = await normalize([
      { type: "text_delta", contentIndex: 0, delta: call },
      ...whitespaceChunks.map((delta) => ({ type: "text_delta", contentIndex: 0, delta })),
      { type: "text_delta", contentIndex: 0, delta: "Visible" },
    ]);

    const deltas = textDeltas(events);
    expect(deltas.at(-1)).toBe("Visible");
    expect(deltas.slice(0, -1).join("").length).toBeLessThanOrEqual(2 * 4096);
    expect(JSON.stringify(events)).not.toContain("<function=read>");
  });

  it("preserves visible whitespace when an optional JSON closer is absent", async () => {
    const prefix = `[tool:read] {"path":"${"x".repeat(256_001)}`;
    const suffix = '"}\n\nVisible';
    const events = await normalize([
      { type: "text_delta", contentIndex: 0, delta: prefix },
      { type: "text_delta", contentIndex: 0, delta: suffix },
    ]);

    expect(textDeltas(events)).toEqual(["\nVisible"]);
  });

  it("preserves split visible whitespace when an optional JSON closer is absent", async () => {
    const prefix = `[tool:read] {"path":"${"x".repeat(256_001)}`;
    const events = await normalize([
      { type: "text_delta", contentIndex: 0, delta: prefix },
      { type: "text_delta", contentIndex: 0, delta: '"}' },
      { type: "text_delta", contentIndex: 0, delta: "\n\n" },
      { type: "text_delta", contentIndex: 0, delta: "Visible" },
    ]);

    expect(textDeltas(events)).toEqual(["\nVisible"]);
  });

  it("retains a later text start when a buffered call leaves visible text", async () => {
    const call = "<function=read></function>\n";
    const suffix = "Visible";
    const events = await normalize([
      { type: "text_delta", contentIndex: 0, delta: call },
      { type: "text_start", contentIndex: 1, content: "" },
      { type: "text_delta", contentIndex: 1, delta: suffix },
    ]);

    expect(events).toMatchObject([
      { type: "text_start", contentIndex: 1 },
      { type: "text_delta", contentIndex: 1, delta: suffix },
    ]);
  });

  it("retains a new block supplied only by its authoritative text end", async () => {
    const events = await normalize([
      { type: "text_delta", contentIndex: 0, delta: "[read]" },
      { type: "text_end", contentIndex: 1, content: "Visible answer" },
    ]);

    expect(events).toEqual([
      { type: "text_delta", contentIndex: 0, delta: "[read]" },
      { type: "text_end", contentIndex: 1, content: "Visible answer" },
    ]);
  });

  it("keeps an incomplete call private across a cumulative text end", async () => {
    const visible = "Hello\n";
    const call = "<function=read><parameter=path>SECRET";
    const raw = visible + call;
    const events = await normalize([
      { type: "text_delta", contentIndex: 0, delta: raw },
      { type: "text_end", contentIndex: 0, content: raw },
    ]);

    expect(textDeltas(events)).toEqual([visible]);
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });

  it("projects sanitized text across the original terminal content indexes", async () => {
    const intro = "Visible intro.\n";
    const call = "<function=read></function>\n";
    const suffix = "Visible suffix.";
    const content = [
      { type: "text", text: intro },
      { type: "text", text: call },
      { type: "text", text: suffix },
    ];
    const events = await normalize([
      { type: "text_delta", contentIndex: 0, delta: intro },
      { type: "text_delta", contentIndex: 1, delta: call },
      { type: "text_delta", contentIndex: 2, delta: suffix },
      {
        type: "done",
        reason: "length",
        message: { role: "assistant", content, stopReason: "length" },
      },
    ]);

    expect(textDeltas(events)).toEqual([intro, suffix]);
    expect(events.at(-1)?.message).toMatchObject({
      content: [content[0], { type: "text", text: "" }, content[2]],
    });
    expect(JSON.stringify(events)).not.toContain("<function=read>");
  });

  it("preserves a later content index after a separately scrubbed over-cap call", async () => {
    const call = `<function=read><parameter=path>${"x".repeat(256_001)}</parameter></function>`;
    const suffix = "Visible suffix.";
    const content = [
      { type: "text", text: call },
      { type: "text", text: suffix },
    ];
    const events = await normalize([
      { type: "text_delta", contentIndex: 0, delta: call },
      { type: "text_delta", contentIndex: 1, delta: suffix },
      {
        type: "done",
        reason: "length",
        message: { role: "assistant", content, stopReason: "length" },
      },
    ]);

    expect(textDeltas(events)).toEqual([suffix]);
    expect(events.at(-1)?.message).toMatchObject({
      content: [{ type: "text", text: "" }, content[1]],
    });
  });

  it("preserves streamed content indexes in terminal error snapshots", async () => {
    const call = `<function=read><parameter=path>${"x".repeat(256_001)}</parameter></function>`;
    const thinking = { type: "thinking", thinking: "checking" };
    const suffix = { type: "text", text: "Visible suffix." };
    const error = { role: "assistant", content: [{ type: "text", text: call }, thinking, suffix] };
    const events = await normalize([
      { type: "text_delta", contentIndex: 0, delta: call },
      { type: "text_delta", contentIndex: 2, delta: suffix.text },
      { type: "error", error },
    ]);

    expect(textDeltas(events)).toEqual([suffix.text]);
    expect(events.at(-1)?.error).toMatchObject({
      content: [{ type: "text", text: "" }, thinking, suffix],
    });
  });

  it("keeps earlier visible text when scrubbing a later same-index call", async () => {
    const intro = "Visible intro.\n";
    const call = "<function=read></function>\n";
    const suffix = "Visible suffix.";
    const raw = `${intro}${call}${suffix}`;
    const events = await normalize([
      { type: "text_delta", contentIndex: 0, delta: intro },
      { type: "text_delta", contentIndex: 0, delta: `${call}${suffix}` },
      {
        type: "done",
        reason: "length",
        message: { role: "assistant", content: textContent(raw), stopReason: "length" },
      },
    ]);

    expect(textDeltas(events)).toEqual([intro, suffix]);
    expectTerminalContent(events, "done", textContent(`${intro}${suffix}`));
    expect(JSON.stringify(events)).not.toContain("<function=read>");
  });

  it("emits each visible segment once across multiple stripped calls and cumulative text_end", async () => {
    const call = `<function=read>${"\u00a0".repeat(128_001)}</function>\n`;
    const first = `${call}ONE\n`;
    const second = `TWO\n${call}THREE`;
    const raw = first + second;
    const events = await normalize([
      { type: "text_delta", contentIndex: 0, delta: first },
      { type: "text_delta", contentIndex: 0, delta: second },
      { type: "text_end", contentIndex: 0, content: raw },
      {
        type: "done",
        reason: "length",
        message: { role: "assistant", content: textContent(raw), stopReason: "length" },
      },
    ]);

    expect(events.map((event) => event.type)).toEqual([
      "text_delta",
      "text_delta",
      "text_delta",
      "done",
    ]);
    expect(textDeltas(events)).toEqual(["ONE\n", "TWO\n", "THREE"]);
    expectTerminalContent(events, "done", textContent("ONE\nTWO\nTHREE"));
  });

  it.each([
    ["delta omits the index", {}, { contentIndex: 0 }],
    ["text_end omits the index", { contentIndex: 0 }, {}],
  ])("canonicalizes index zero when the %s", async (_name, deltaIndex, endIndex) => {
    const call = `<function=read>${"\u00a0".repeat(128_001)}</function>\n`;
    const visible = "Visible once.";
    const raw = call + visible;
    const events = await normalize([
      { type: "text_delta", ...deltaIndex, delta: raw },
      { type: "text_end", ...endIndex, content: raw },
      {
        type: "done",
        reason: "length",
        message: { role: "assistant", content: textContent(raw), stopReason: "length" },
      },
    ]);

    expect(textDeltas(events)).toEqual([visible]);
    expectTerminalContent(events, "done", textContent(visible));
  });

  it.each([false, true])(
    "tracks many stripped segments by emitted offset (text_end partial: %s)",
    async (withPartial) => {
      const call = "<function=read></function>\n";
      const segments = Array.from({ length: 64 }, (_, index) => `SEG-${index}\n`);
      const chunks = segments.map((segment) => call + segment);
      const raw = chunks.join("");
      const events = await normalize([
        ...chunks.map((delta) => ({ type: "text_delta", contentIndex: 0, delta })),
        {
          type: "text_end",
          contentIndex: 0,
          content: raw,
          ...(withPartial ? { partial: { role: "assistant", content: textContent(raw) } } : {}),
        },
        {
          type: "done",
          reason: "length",
          message: { role: "assistant", content: textContent(raw), stopReason: "length" },
        },
      ]);

      expect(textDeltas(events)).toEqual(segments);
      expectTerminalContent(events, "done", textContent(segments.join("")));
    },
  );

  it("bounds cumulative dedupe state to offsets for multi-megabyte visible text", async () => {
    const call = "<function=read></function>\n";
    const chunks = Array.from({ length: 512 }, () => "x".repeat(4_096));
    const visible = chunks.join("");
    const raw = call + visible;
    const events = await normalize([
      { type: "text_delta", contentIndex: 0, delta: call },
      ...chunks.map((delta) => ({ type: "text_delta", contentIndex: 0, delta })),
      { type: "text_end", contentIndex: 0, content: raw },
      {
        type: "done",
        reason: "length",
        message: { role: "assistant", content: textContent(raw), stopReason: "length" },
      },
    ]);

    expect(textDeltas(events)).toEqual(chunks);
    expectTerminalContent(events, "done", textContent(visible));
  });

  it("emits buffered auxiliary events exactly once on unsanitized errors", async () => {
    const call = "<function=read></function>";
    const thinking = { type: "thinking", thinking: "checking" };
    const events = await normalize([
      textDelta(call, call),
      {
        type: "thinking_delta",
        contentIndex: 1,
        delta: "checking",
        partial: { role: "assistant", content: [{ type: "text", text: call }, thinking] },
      },
      { type: "error", error: { message: "stream failed" } },
    ]);

    expect(events.filter((event) => event.type === "thinking_delta")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });

  it("preserves earlier cumulative text in replayed false-positive partials", async () => {
    const visible = "Hello\n";
    const prefix = "[tool:re";
    const thinking = { type: "thinking", thinking: "x" };
    const events = await normalize([
      textDelta(visible, visible),
      textDelta(prefix, `${visible}${prefix}`),
      {
        type: "thinking_delta",
        contentIndex: 1,
        delta: "x",
        partial: {
          role: "assistant",
          content: [{ type: "text", text: `${visible}${prefix}` }, thinking],
        },
      },
      textDelta(" nope", `${visible}${prefix} nope`),
    ]);

    expect(events.find((event) => event.type === "thinking_delta")).toMatchObject({
      partial: { content: [{ type: "text", text: `${visible}${prefix}` }, thinking] },
    });
  });

  it.each(["analysis", "commentary", "final"])(
    "replays the bare Harmony channel word %s at EOF",
    async (word) => {
      expect(
        textDeltas(await normalize([{ type: "text_delta", contentIndex: 0, delta: word }])),
      ).toEqual([word]);
    },
  );

  it("reconciles false-prefix prose completed by text_end", async () => {
    const events = await normalize([
      { type: "text_delta", contentIndex: 0, delta: "analysis" },
      { type: "text_end", contentIndex: 0, content: "analysis is ordinary prose" },
    ]);

    expect(textDeltas(events)).toEqual(["analysis is ordinary prose"]);
    expect(events.map((event) => event.type)).toEqual(["text_delta", "text_end"]);
  });

  it("bounds unnamed Harmony prefixes before EOF", async () => {
    const raw = `analysis${" ".repeat(256_001)}`;
    const events = await normalize([{ type: "text_delta", contentIndex: 0, delta: raw }]);

    expect(textDeltas(events)).toEqual([raw]);
  });

  it("preserves a malformed parameter marker after over-cap XML", async () => {
    const prefix = `<function=read><parameter=path>${"x".repeat(256_001)}</parameter>`;
    const suffix = "<parameter=x!>Visible answer";
    const events = await normalize([
      { type: "text_delta", contentIndex: 0, delta: prefix },
      { type: "text_delta", contentIndex: 0, delta: suffix },
    ]);

    expect(textDeltas(events)).toEqual([suffix]);
  });

  it("recovers a visible suffix delivered only by an over-cap text_end", async () => {
    const prefix = `<function=read><parameter=path>${"x".repeat(256_001)}`;
    const complete = `${prefix}</parameter></function>\nVisible answer`;
    const events = await normalize([
      { type: "text_delta", contentIndex: 0, delta: prefix },
      { type: "text_end", contentIndex: 0, content: complete },
    ]);

    expect(textDeltas(events)).toEqual(["Visible answer"]);
    expect(JSON.stringify(events)).not.toContain("<function=read>");
  });

  it("fails closed on an unresolved authoritative tool-name prefix", async () => {
    const content = "Hello\n[tool:re";
    const event = { type: "text_end", contentIndex: 0, content };

    expect(textDeltas(await normalize([event]))).toEqual(["Hello\n"]);
  });

  it("emits a held text start before a synthetic visible prefix", async () => {
    const visible = "Visible\n";
    const candidate = "[tool:re nope";
    const raw = visible + candidate;
    const events = await normalize([
      {
        type: "text_start",
        contentIndex: 0,
        content: "",
        partial: { role: "assistant", content: textContent("") },
      },
      textDelta(`${visible}[tool:re`, `${visible}[tool:re`),
      textDelta(" nope", raw),
    ]);

    expect(events.map((event) => event.type)).toEqual(["text_start", "text_delta", "text_delta"]);
    expect(textDeltas(events)).toEqual([visible, candidate]);
  });

  it.each(["[tool:read]", "analysis to=read code"])(
    "suppresses over-cap whitespace before a split JSON payload for %s",
    async (header) => {
      const prefix = header + " ".repeat(256_001);
      const payload = '{"path":"SECRET"}<|call|>';
      const events = await normalize([
        { type: "text_delta", contentIndex: 0, delta: prefix },
        { type: "text_delta", contentIndex: 0, delta: payload },
      ]);

      expect(events).toEqual([]);
    },
  );

  it.each(
    [
      "<function=read><parameter=path>SECRET",
      "<function=read><parameter=path>SECRET</parameter></function>",
    ].flatMap((raw) =>
      (["done", "error", "eof"] as const).map((terminal) => [raw, terminal] as const),
    ),
  )("fails closed on a known %s candidate at %s", async (raw, terminal) => {
    const events = await normalize(
      withTerminal([{ type: "text_delta", contentIndex: 0, delta: raw }], terminal, raw),
    );

    expect(textDeltas(events)).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });

  it.each(["[tool:read] {}", "analysis to=read code {}"])(
    "scrubs a cumulative partial before emitting a visible prefix for %s",
    async (call) => {
      const visible = "Visible\n";
      const first = `${visible}${call}<`;
      const raw = `${visible}${call}<|call|>`;
      const events = await normalize([textDelta(first, first), textDelta("|call|>", raw)]);

      expect(textDeltas(events)).toEqual([visible]);
      expect(events[0]?.partial).toMatchObject({ content: textContent(visible) });
      expect(JSON.stringify(events[0])).not.toContain("SECRET");
      expect(JSON.stringify(events)).not.toContain("<|call|>");
    },
  );

  it("keeps block-local text_end checkpoints out of the candidate buffer", async () => {
    const header = "[read]";
    const payload = '{"path":"SECRET"}[/read]';
    const rawMessage = {
      role: "assistant",
      content: [
        { type: "text", text: header },
        { type: "text", text: payload },
      ],
      stopReason: "stop",
    };
    const promotedMessage = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call_repaired", name: "read", arguments: { path: "SECRET" } },
      ],
      stopReason: "toolUse",
    };
    async function* source() {
      yield { type: "text_start", contentIndex: 0, content: "" };
      yield { type: "text_delta", contentIndex: 0, delta: header };
      yield { type: "text_end", contentIndex: 0, content: header };
      yield { type: "text_start", contentIndex: 1, content: "" };
      yield { type: "text_delta", contentIndex: 1, delta: payload };
      yield { type: "text_end", contentIndex: 1, content: payload };
      yield { type: "done", reason: "stop", message: rawMessage };
    }
    const events: Record<string, unknown>[] = [];
    for await (const event of normalizePlainTextToolCallStreamEvents(source(), {
      matcher,
      createPromotedToolCallEvents: (message) => [
        { type: "toolcall_start", contentIndex: 0, partial: message },
        { type: "toolcall_end", contentIndex: 0, partial: message },
      ],
      normalizeTerminalMessage: () => ({
        kind: "promoted",
        message: promotedMessage,
        sourceToProjectedContentIndex: new Map(),
      }),
    })) {
      events.push(event as Record<string, unknown>);
    }

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_end",
      "done",
    ]);
    expect(events.at(-1)).toMatchObject({ reason: "toolUse", message: promotedMessage });
    expect(JSON.stringify(events)).not.toContain("[/read]");
  });

  it("preserves native tool-call partials while replaying a false-positive prefix", async () => {
    const prefix = "[tool:re";
    const toolCall = { type: "toolCall", id: "call_native", name: "other", arguments: {} };
    const partial = {
      role: "assistant",
      content: [{ type: "text", text: prefix }, toolCall],
    };
    const events = await normalize([
      textDelta(prefix, prefix),
      { type: "toolcall_start", contentIndex: 1, partial },
      textDelta(" nope", `${prefix} nope`),
    ]);

    expect(events.find((event) => event.type === "toolcall_start")?.partial).toEqual(partial);
  });

  it("does not allocate a synthetic partial from a hostile content index", async () => {
    const raw = `<function=read><parameter=path>${"x".repeat(256_001)}</parameter></function>`;
    const events = await normalize([
      { ...textDelta(raw, raw), contentIndex: Number.MAX_SAFE_INTEGER },
    ]);

    expect(events).toEqual([]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
