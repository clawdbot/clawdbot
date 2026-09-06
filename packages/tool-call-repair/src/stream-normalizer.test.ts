import { describe, expect, it, vi } from "vitest";
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

function resolveTestFenceRanges(text: string): Array<{ end: number; start: number }> {
  const ranges: Array<{ end: number; start: number }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const backtick = text.indexOf("```", cursor);
    const tilde = text.indexOf("~~~", cursor);
    const start = backtick === -1 ? tilde : tilde === -1 ? backtick : Math.min(backtick, tilde);
    if (start === -1) {
      break;
    }
    const marker = text.slice(start, start + 3);
    const close = text.indexOf(marker, start + marker.length);
    const end = close === -1 ? text.length : close + marker.length;
    ranges.push({ start, end });
    cursor = end;
  }
  return ranges;
}

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

function textContent(...texts: string[]) {
  return texts.map((text) => ({ type: "text", text }));
}

function assistantMessage(content: unknown, stopReason?: string) {
  return { role: "assistant", content, ...(stopReason === undefined ? {} : { stopReason }) };
}

function streamEvent(type: string, fields: Record<string, unknown>) {
  return { type, ...fields };
}

function textDelta(delta: string, snapshot: string) {
  return streamEvent("text_delta", {
    contentIndex: 0,
    delta,
    partial: assistantMessage(textContent(snapshot)),
  });
}

function streamTextDelta(delta: string, contentIndex = 0, partial?: unknown) {
  return streamEvent("text_delta", {
    contentIndex,
    delta,
    ...(partial === undefined ? {} : { partial }),
  });
}

function textStart(contentIndex: number, content = "", partial?: unknown) {
  return streamEvent("text_start", {
    contentIndex,
    content,
    ...(partial === undefined ? {} : { partial }),
  });
}

function textEnd(content: string, contentIndex = 0, partial?: unknown) {
  return streamEvent("text_end", {
    contentIndex,
    content,
    ...(partial === undefined ? {} : { partial }),
  });
}

function doneEvent(reason: string, message: unknown) {
  return streamEvent("done", { reason, message });
}

function doneAssistantEvent(reason: string, content: unknown, stopReason: string) {
  return doneEvent(reason, assistantMessage(content, stopReason));
}

function errorEvent(error: unknown, partial?: unknown) {
  return streamEvent("error", { ...(partial === undefined ? {} : { partial }), error });
}

async function collectNormalizedEvents(
  events: readonly unknown[],
  options: Parameters<typeof normalizePlainTextToolCallStreamEvents>[1],
): Promise<Record<string, unknown>[]> {
  async function* source() {
    yield* events;
  }
  const normalized: Record<string, unknown>[] = [];
  for await (const event of normalizePlainTextToolCallStreamEvents(source(), options)) {
    if (event && typeof event === "object") {
      normalized.push(event as Record<string, unknown>);
    }
  }
  return normalized;
}

async function normalize(
  events: readonly unknown[],
  options: { protectFences?: boolean } = {},
): Promise<Record<string, unknown>[]> {
  const scrubMessage = (message: unknown, scrubOptions?: { preserveEmptyTextBlocks?: boolean }) =>
    projectScrubbedPlainTextToolCallMessage({
      matcher,
      message,
      preserveEmptyTextBlocks: scrubOptions?.preserveEmptyTextBlocks,
      resolveProtectedRanges: options.protectFences ? resolveTestFenceRanges : undefined,
    });
  return collectNormalizedEvents(events, {
    matcher,
    createPromotedToolCallEvents: () => [],
    normalizeTerminalMessage: ({
      message,
      preserveEmptyTextBlocks,
    }): PlainTextToolCallMessageNormalization => {
      const scrubbed = scrubMessage(message, { preserveEmptyTextBlocks });
      return scrubbed ? { kind: "scrubbed", ...scrubbed } : undefined;
    },
    // resolveTestFenceRanges protects exactly fenced regions, the shape the carried fence
    // scan models, so these fence-suite tests opt the fast path in.
    protectedRangesFenceCompatible: options.protectFences === true,
    resolveProtectedRanges: options.protectFences ? resolveTestFenceRanges : undefined,
  });
}

function normalizeTextDeltas(...deltas: string[]) {
  return normalize(deltas.map((delta) => streamTextDelta(delta)));
}

function withTerminal(
  deltas: readonly Record<string, unknown>[],
  terminal: Terminal,
  snapshot: string,
): Record<string, unknown>[] {
  if (terminal === "eof") {
    return [...deltas];
  }
  const message = assistantMessage(textContent(snapshot), "length");
  return terminal === "done"
    ? [...deltas, doneEvent("length", message)]
    : [...deltas, errorEvent({ content: textContent(snapshot) }, message)];
}

function textDeltas(events: readonly Record<string, unknown>[]): unknown[] {
  return events.filter((event) => event.type === "text_delta").map((event) => event.delta);
}

function eventTypes(events: readonly Record<string, unknown>[]): unknown[] {
  return events.map((event) => event.type);
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
    const message = assistantMessage(
      textContent("[read]", `<parameter=path>${"\u00a0".repeat(128_001)}</parameter></function>`),
      "length",
    );
    const events = await normalize([doneEvent("length", message)]);

    expect(events).toEqual([doneEvent("length", { ...message, content: [] })]);
  });

  it.each([
    `<parameter=path>${"x".repeat(256_001)}`,
    `{"path":"${"x".repeat(256_001)}`,
    `{"path":"${"x".repeat(256_001)}"}`,
    `{"path":"${"x".repeat(256_001)}"}\n[END_TOOL_REQU`,
  ])("scrubs incomplete split named calls", async (payload) => {
    const message = assistantMessage(textContent("[read]", payload), "length");
    const events = await normalize([doneEvent("length", message)]);

    expect(events.at(-1)?.message).toMatchObject({ content: [] });
    expect(JSON.stringify(events)).not.toContain("[read]");
  });

  it("scrubs an incomplete named call from a done-only snapshot", async () => {
    const raw = "<function=read><parameter=path>SECRET";
    const message = assistantMessage(textContent(raw), "length");
    const events = await normalize([doneEvent("length", message)]);

    expect(events).toEqual([doneEvent("length", { ...message, content: [] })]);
  });

  it("repairs split calls after visible text", async () => {
    const payload = `<parameter=path>${"x".repeat(256_001)}</parameter></function>`;
    const message = assistantMessage(textContent("Visible\n[read]", payload), "length");
    const events = await normalize([doneEvent("length", message)]);

    expect(events.at(-1)?.message).toMatchObject({ content: textContent("Visible\n") });
  });

  it("merges exact and repaired over-cap ranges", async () => {
    const exact = `<function=read>${"\u00a0".repeat(128_001)}</function>\n`;
    const split = `<parameter=path>${"y".repeat(256_001)}</parameter></function>`;
    const message = assistantMessage(textContent(exact, "[read]", split), "length");
    const events = await normalize([doneEvent("length", message)]);

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
    const message = assistantMessage(
      [{ type: "text", text: call }, image, { type: "text", text: "Visible" }],
      "length",
    );
    const events = await normalize([doneEvent("length", message)]);

    expect(events.at(-1)?.message).toMatchObject({
      content: [image, { type: "text", text: "Visible" }],
    });
  });

  it("strips every leading serialized call after the first over-cap call", async () => {
    const overCap = `<function=read>${"\u00a0".repeat(128_001)}</function>`;
    const second = "<function=read></function>";
    const raw = `${overCap}\n${second}\nVisible`;
    const events = await normalize([doneAssistantEvent("length", textContent(raw), "length")]);

    expect(events.at(-1)?.message).toMatchObject({ content: textContent("Visible") });
  });

  it("suppresses an incomplete follow-on call prefix", async () => {
    const raw = `<function=read>${"\u00a0".repeat(128_001)}</function>\n[tool:read`;
    const events = await normalize([textDelta(raw, raw)]);

    expect(events).toEqual([]);
  });

  it("keeps an incomplete follow-on call private until terminal promotion", async () => {
    const raw = "<function=read></function>\n<function=read><parameter=path>SECRET";
    const message = assistantMessage(
      [{ type: "toolCall", name: "read", arguments: { path: "SECRET" } }],
      "toolUse",
    );
    const events = await collectNormalizedEvents(
      [textDelta(raw, raw), doneAssistantEvent("stop", textContent(raw), "stop")],
      {
        matcher,
        createPromotedToolCallEvents: () => [],
        normalizeTerminalMessage: () => ({
          kind: "promoted",
          message,
          sourceToProjectedContentIndex: new Map(),
        }),
      },
    );

    expect(eventTypes(events)).toEqual(["start", "done"]);
    expect(JSON.stringify(events.slice(0, -1))).not.toContain("SECRET");
  });

  it.each(['[tool:read] {"path":"SECRET"}', 'analysis to=read code {"path":"SECRET"}'])(
    "keeps every split optional closer private for %s",
    async (call) => {
      const marker = "<|call|>";
      for (let split = 1; split < marker.length; split += 1) {
        const first = call + marker.slice(0, split);
        const raw = call + marker;
        const message = assistantMessage(
          [{ type: "toolCall", name: "read", arguments: {} }],
          "toolUse",
        );
        const events = await collectNormalizedEvents(
          [
            textDelta(first, first),
            textDelta(marker.slice(split), raw),
            doneAssistantEvent("stop", textContent(raw), "stop"),
          ],
          {
            matcher,
            createPromotedToolCallEvents: () => [],
            normalizeTerminalMessage: () => ({
              kind: "promoted",
              message,
              sourceToProjectedContentIndex: new Map(),
            }),
          },
        );

        expect(eventTypes(events)).toEqual(["start", "done"]);
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
      const events = await normalizeTextDeltas(
        call + marker.slice(0, split),
        marker.slice(split) + `\n${visible}`,
      );

      expect(textDeltas(events)).toEqual([visible]);
      expect(JSON.stringify(events)).not.toContain(marker);
    }
  });

  it("keeps an optional closer private when it starts after the over-cap payload", async () => {
    const call = `[tool:read] {"path":"${"x".repeat(256_001)}"}`;
    const marker = "<|call|>";
    const events = await normalizeTextDeltas(call, `${marker}\nVisible`);

    expect(textDeltas(events)).toEqual(["Visible"]);
    expect(JSON.stringify(events)).not.toContain(marker);
  });

  it("preserves a follow-on named JSON call invalidated by visible tail text", async () => {
    const overCap = `<function=read>${"\u00a0".repeat(128_001)}</function>`;
    const visible = '[read]\n{"path":"/tmp"} visible';
    const raw = `${overCap}\n${visible}`;
    const events = await normalize([doneAssistantEvent("length", textContent(raw), "length")]);

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
    const message = assistantMessage([{ type: "text", text: raw }, thinking], "length");
    const events = await normalize([
      textDelta(raw, raw),
      {
        type: "thinking_delta",
        contentIndex: 1,
        delta: "checking",
        partial: assistantMessage([{ type: "text", text: raw }, thinking]),
      },
      doneEvent("length", message),
    ]);

    expect(eventTypes(events)).toEqual(["thinking_delta", "done"]);
    expect(events[0]).toMatchObject({ contentIndex: 0, partial: { content: [thinking] } });
    expect(events[1]?.message).toMatchObject({ content: [thinking] });
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
  });

  it("uses the compact error projection when no partial is present", async () => {
    const raw = `[tool:read]\n<parameter=path>\n${"x".repeat(256_001)}`;
    const thinking = { type: "thinking", thinking: "checking" };
    const error = assistantMessage([{ type: "text", text: raw }, thinking]);
    const events = await normalize([
      textDelta(raw, raw),
      {
        type: "thinking_delta",
        contentIndex: 1,
        delta: "checking",
        partial: error,
      },
      errorEvent(error),
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
        partial: assistantMessage(
          type === "thinking_delta" ? [{ type: "text", text: call }, block] : [block],
        ),
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
    const events = await normalize([streamTextDelta(candidate), ...lifecycles]);

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
      streamTextDelta(candidate),
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
    const partial = assistantMessage([
      { type: "text", text: "Visible" },
      { type: "thinking", thinking: "checking" },
    ]);
    const events = await normalize([
      streamTextDelta(`${call}\nVisible`),
      { type: "thinking_start", contentIndex: 1, partial },
    ]);

    expect(events.at(-1)).toEqual({ type: "thinking_start", contentIndex: 1, partial });
  });

  it("preserves clean required partials while draining buffered auxiliary events", async () => {
    const partial = assistantMessage([{ type: "thinking", thinking: "checking" }]);
    const events = await normalize([
      streamTextDelta('[tool:read] {"path":"SECRET"'),
      { type: "thinking_start", contentIndex: 1, partial },
    ]);

    expect(events).toEqual([{ type: "thinking_start", contentIndex: 1, partial }]);
  });

  it("replays a false prefix after auxiliary queue compaction", async () => {
    const prefix = "[tool:re";
    const visible = `${prefix} nope`;
    const sourceEvents = [
      streamTextDelta(prefix),
      ...Array.from({ length: 257 }, () => ({
        type: "thinking_delta",
        contentIndex: 1,
        delta: "x",
      })),
      streamTextDelta(" nope"),
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
        message: assistantMessage(text),
      }),
    ).toBeUndefined();
    expect(exactNameChecks).toBeLessThanOrEqual(callCount * 3);
  });

  it("scrubs an under-cap call after visible terminal text", () => {
    const message = assistantMessage("Visible answer\n<function=read></function>");

    expect(projectScrubbedPlainTextToolCallMessage({ matcher, message })?.message).toEqual({
      ...message,
      content: "Visible answer\n",
    });
  });

  it("preserves a fenced call in terminal projections", () => {
    const text = ["```json", "[read]", '{"path":"example.txt"}', "[/read]", "```"].join("\n");
    const message = assistantMessage(text);

    expect(
      projectScrubbedPlainTextToolCallMessage({
        matcher,
        message,
        resolveProtectedRanges: resolveTestFenceRanges,
      }),
    ).toBeUndefined();
  });

  it("preserves fenced calls when the opener and call are split across live deltas", async () => {
    const parts = ["`", "``json\n", "[re", 'ad]\n{"path":"example.txt"}\n[/read]\n', "```"];
    const text = parts.join("");
    const events = await normalize(
      [
        ...parts.map((delta) => streamTextDelta(delta)),
        doneAssistantEvent("stop", textContent(text), "stop"),
      ],
      { protectFences: true },
    );

    expect(textDeltas(events).join("")).toBe(text);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      message: { content: textContent(text), stopReason: "stop" },
    });
    expect(events.some((event) => String(event.type).startsWith("toolcall_"))).toBe(false);
  });

  it("preserves fence ownership across adjacent text content blocks", async () => {
    const first = "```json\n";
    const second = ["[read]", '{"path":"example.txt"}', "[/read]", "```"].join("\n");
    const content = textContent(first, second);
    const events = await normalize(
      [
        streamTextDelta(first),
        textEnd(first, 0),
        streamTextDelta(second, 1),
        textEnd(second, 1),
        doneAssistantEvent("stop", content, "stop"),
      ],
      { protectFences: true },
    );

    expect(textDeltas(events).join("")).toBe(first + second);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      message: { content, stopReason: "stop" },
    });
    expect(events.some((event) => String(event.type).startsWith("toolcall_"))).toBe(false);
  });

  it("uses cumulative partials when earlier fenced blocks were not streamed", async () => {
    const candidate = ["[read]", '{"path":"example.txt"}', "[/read]", "```"].join("\n");
    const content = textContent("```json\n", candidate);
    const events = await normalize([streamTextDelta(candidate, 1, assistantMessage(content))], {
      protectFences: true,
    });

    expect(textDeltas(events)).toEqual([candidate]);
    expect(events.some((event) => String(event.type).startsWith("toolcall_"))).toBe(false);
  });

  it("uses cumulative partials when earlier fenced blocks were not streamed, even with a complete final line (#122513)", async () => {
    // codex review: the test above happens to end its candidate on an INCOMPLETE last line
    // ("```" with no trailing newline), which independently makes the fast path decline (it
    // always declines on an unfinished line outside a fence) -- masking the real bug. With a
    // complete last line, the fast path's carried state (empty, since block 0's "```json" was
    // never streamed as its own delta) wrongly reports the candidate as NOT protected instead
    // of falling through to the cumulative-partial/full-parse fallback that knows better.
    const first = "```json\n";
    const candidate = ["[read]", '{"path":"example.txt"}', "[/read]", "```", ""].join("\n");
    const content = textContent(first, candidate);
    const events = await normalize(
      [
        streamTextDelta(candidate, 1, assistantMessage(content)),
        textEnd(candidate, 1, assistantMessage(content)),
        doneAssistantEvent("stop", content, "stop"),
      ],
      { protectFences: true },
    );

    expect(textDeltas(events).join("")).toBe(candidate);
    expect(events.some((event) => String(event.type).startsWith("toolcall_"))).toBe(false);
  });

  it("recognizes a real call in an earlier block when a later block streams its fence first (#122513)", async () => {
    // codex review: the carried fence-state scan advances in EVENT order, but a partial's
    // per-block offsets are in CONTENT-INDEX order. A provider can stream block 1 (opening a
    // fence) before block 0 (a genuine, unfenced call) -- by the time block 0's own delta
    // arrives, the scan has tracked 8 chars (block 1's "```json\n") while block 0's own
    // content-order offset is 0. A ">" check misses this direction entirely and lets the fast
    // path answer from the scan's (wrong, event-order) state, which would treat the call as
    // fenced and never promote it -- only a "!==" check catches a mismatch in either direction.
    const candidate = ["[read]", '{"path":"example.txt"}', "[/read]", ""].join("\n");
    const second = "```json\n";
    // No text_end/done here: the terminal path always re-parses the whole assembled
    // message from scratch and would correctly scrub the call regardless of what the
    // streaming fast path decided, masking exactly the bug this test targets. The
    // observable difference is in the intermediate streamed text_delta events.
    const events = await collectNormalizedEvents(
      [
        streamTextDelta(second, 1, assistantMessage(textContent("", second))),
        streamTextDelta(candidate, 0, assistantMessage(textContent(candidate, second))),
      ],
      {
        matcher,
        createPromotedToolCallEvents: () => [],
        normalizeTerminalMessage: () => undefined,
        protectedRangesFenceCompatible: true,
        resolveProtectedRanges: resolveTestFenceRanges,
      },
    );

    // Wrongly "protected" would stream the raw candidate bytes straight out as literal
    // visible text; correctly recognized as a real, unfenced call, they are buffered as
    // a pending candidate instead and never appear verbatim in a streamed delta.
    const streamedText = events
      .map((event) =>
        typeof event.delta === "string"
          ? event.delta
          : typeof event.content === "string"
            ? event.content
            : "",
      )
      .join("");
    expect(streamedText).not.toContain('{"path":"example.txt"}');
  });

  it("does not trust a same-length prefix that came from a different block order (#122513)", async () => {
    // codex review: a length match alone does not prove the event-order scan represents
    // the same prefix as content-index order. Block 1 streams "```\n" first (opens a
    // backtick fence); block 0 then streams "~~~\n" (opens a tilde fence, since a tilde
    // delimiter never closes a backtick fence). Event order ends with fenceChar "`";
    // content-index order (0 then 1) ends with fenceChar "~" -- same tracked length (8),
    // opposite fence identity. Block 2's own "```" delimiter would close the (wrong)
    // event-order backtick fence but not the (correct) content-order tilde fence, so a
    // length-only check wrongly lets a call still inside the real fence through.
    const block1 = "```\n";
    const block0 = "~~~\n";
    const candidate = ["```", "[read]", '{"path":"example.txt"}', "[/read]", "```", ""].join("\n");
    const events = await collectNormalizedEvents(
      [
        streamTextDelta(block1, 1, assistantMessage(textContent("", block1))),
        streamTextDelta(block0, 0, assistantMessage(textContent(block0, block1))),
        streamTextDelta(candidate, 2, assistantMessage(textContent(block0, block1, candidate))),
      ],
      {
        matcher,
        createPromotedToolCallEvents: () => [],
        normalizeTerminalMessage: () => undefined,
        protectedRangesFenceCompatible: true,
        resolveProtectedRanges: resolveTestFenceRanges,
      },
    );

    // Correctly distrusted (this fix), block 2's candidate is recognized as still inside
    // the real (content-order) fence and streams straight out as literal visible text.
    // Wrongly trusted event-order state instead closes the fence on block 2's own
    // opening "```" and buffers the call as a pending candidate -- and since nothing
    // resolves it here, it silently never appears in the output at all.
    const streamedText = events
      .map((event) =>
        typeof event.delta === "string"
          ? event.delta
          : typeof event.content === "string"
            ? event.content
            : "",
      )
      .join("");
    expect(streamedText).toContain('{"path":"example.txt"}');
  });

  it("does not cache trust from a candidate with no partial at all (#122513)", async () => {
    // codex review: a candidate delta can arrive with no partial at all (partial is
    // optional on every event type). hasUntrackedPrecedingContext has nothing to compare
    // in that case and returns "no data", which must not be cached as "trusted" for the
    // rest of the block -- a LATER candidate in the same block, one that does carry a
    // partial revealing a genuine event-order/content-order mismatch, must still get its
    // own fresh check rather than inheriting a default that was never actually confirmed.
    const block1 = "```\n";
    // A complete, well-formed call with no partial: resolves immediately, so a second,
    // separate candidate can start afterward in the same block.
    const firstCall = "[read]\n{}\n[/read]\n";
    const secondCandidate = ["```", "[read]", '{"path":"x"}', "[/read]", "```", ""].join("\n");
    const events = await collectNormalizedEvents(
      [
        streamTextDelta(block1, 1),
        streamTextDelta(firstCall, 0),
        streamTextDelta(
          secondCandidate,
          0,
          assistantMessage(textContent(`~~~\n${firstCall}${secondCandidate}`, block1)),
        ),
      ],
      {
        matcher,
        createPromotedToolCallEvents: () => [],
        normalizeTerminalMessage: () => undefined,
        protectedRangesFenceCompatible: true,
        resolveProtectedRanges: resolveTestFenceRanges,
      },
    );

    // Wrongly caching "trusted" from the no-partial first call would leave the second
    // candidate evaluated against the (wrong) event-order fence state, buffering it as a
    // pending candidate that nothing here ever resolves -- it silently vanishes from the
    // output. Correctly re-checked, it is recognized as still protected and streams out
    // as literal visible text.
    const streamedText = events
      .map((event) =>
        typeof event.delta === "string"
          ? event.delta
          : typeof event.content === "string"
            ? event.content
            : "",
      )
      .join("");
    expect(streamedText).toContain('{"path":"x"}');
  });

  it("invalidates a cached preceding-context verdict when the earlier block grows (#122513)", async () => {
    // codex review: an earlier block can itself still be actively streaming and grow
    // between two candidate probes in a later block, without the content index ever
    // switching away and back (which would otherwise reset the per-block cache via
    // beginProtectionBlock). A cache keyed only on "have we checked this block yet"
    // would reuse a verdict that predates that growth. Block 0 streams "~~~\n" for real
    // (opening a tilde fence in event order); a first, complete call in block 1 confirms
    // trust against that. A second candidate in block 1 then arrives with a partial
    // reporting a LARGER block 0 ("~~~\n~~~\n", closing that same fence in content
    // order) -- the cache must notice the preceding length changed and re-check, not
    // reuse the first verdict.
    const block0First = "~~~\n";
    const firstCall = "[read]\n{}\n[/read]\n";
    const secondCandidate = ["[read]", '{"path":"x"}', "[/read]", ""].join("\n");
    const block0Grown = `${block0First}~~~\n`;
    const events = await collectNormalizedEvents(
      [
        streamTextDelta(block0First, 0),
        streamTextDelta(firstCall, 1, assistantMessage(textContent(block0First, firstCall))),
        streamTextDelta(
          secondCandidate,
          1,
          assistantMessage(textContent(block0Grown, `${firstCall}${secondCandidate}`)),
        ),
      ],
      {
        matcher,
        createPromotedToolCallEvents: () => [],
        normalizeTerminalMessage: () => undefined,
        protectedRangesFenceCompatible: true,
        resolveProtectedRanges: resolveTestFenceRanges,
      },
    );

    // A stale cached "trusted" verdict evaluates the second candidate against the
    // event-order scan, which never saw block 0's second "~~~\n" and so still thinks the
    // tilde fence from the first "~~~\n" is open -- the real, unfenced call is wrongly
    // buffered as protected content and (nothing here resolves it) silently vanishes.
    // Correctly invalidated, the cache re-checks against the grown block 0, sees the
    // fence actually closed in content order, and the real call is recognized.
    const streamedText = events
      .map((event) =>
        typeof event.delta === "string"
          ? event.delta
          : typeof event.content === "string"
            ? event.content
            : "",
      )
      .join("");
    expect(streamedText).not.toContain('{"path":"x"}');
  });

  it("preserves candidate bytes after bounded protection history overflows", async () => {
    const opening = `\`\`\`text\n${"x".repeat(1_000_000)}`;
    const candidate = ["[read]", '{"path":"example.txt"}', "[/read]"].join("\n");
    const events = await normalize([streamTextDelta(opening), streamTextDelta(candidate)], {
      protectFences: true,
    });

    expect(textDeltas(events).join("")).toBe(opening + candidate);
  });

  it("does not resolve Markdown protection for ordinary streamed text", async () => {
    let resolverCalls = 0;
    const visibleChunks = Array.from({ length: 1_000 }, () => "ordinary prose\n");
    const events = await collectNormalizedEvents(
      visibleChunks.map((delta) => streamTextDelta(delta)),
      {
        matcher,
        createPromotedToolCallEvents: () => [],
        normalizeTerminalMessage: () => undefined,
        resolveProtectedRanges: () => {
          resolverCalls += 1;
          return [];
        },
      },
    );

    expect(resolverCalls).toBe(0);
    expect(textDeltas(events).join("")).toBe(visibleChunks.join(""));
  });

  it("materializes accumulated Markdown only after a candidate-shaped delta", async () => {
    const resolvedLengths: number[] = [];
    const visibleChunks = Array.from({ length: 1_000 }, () => "ordinary prose\n");
    const candidate = ["[read]", '{"path":"example.txt"}', "[/read]"].join("\n");
    const events = await collectNormalizedEvents(
      [...visibleChunks.map((delta) => streamTextDelta(delta)), streamTextDelta(candidate)],
      {
        matcher,
        createPromotedToolCallEvents: () => [],
        normalizeTerminalMessage: () => undefined,
        resolveProtectedRanges: (text) => {
          resolvedLengths.push(text.length);
          return [];
        },
      },
    );

    expect(resolvedLengths).toContain(visibleChunks.join("").length + candidate.length);
    expect(resolvedLengths.length).toBeLessThanOrEqual(3);
    expect(textDeltas(events).join("")).toBe(visibleChunks.join(""));
  });

  it("materializes accumulated Markdown when an inline span blocks the fast path", async () => {
    const resolvedLengths: number[] = [];
    // Inline code spans are a shape the carried fence scan deliberately does not model,
    // so the authoritative full parse must still run — and still stay bounded.
    const visibleChunks = Array.from({ length: 1_000 }, () => "ordinary `code` prose\n");
    const candidate = ["[read]", '{"path":"example.txt"}', "[/read]"].join("\n");
    const events = await collectNormalizedEvents(
      [...visibleChunks.map((delta) => streamTextDelta(delta)), streamTextDelta(candidate)],
      {
        matcher,
        createPromotedToolCallEvents: () => [],
        normalizeTerminalMessage: () => undefined,
        protectedRangesFenceCompatible: true,
        resolveProtectedRanges: (text) => {
          resolvedLengths.push(text.length);
          return [];
        },
      },
    );

    expect(resolvedLengths).toContain(visibleChunks.join("").length + candidate.length);
    expect(resolvedLengths.length).toBeLessThanOrEqual(3);
    expect(textDeltas(events).join("")).toBe(visibleChunks.join(""));
  });

  it("does not carry an open fence from a finished completion into the next one", async () => {
    // The done branch clears the protection context; carried block state must clear with
    // it, or the next completion starts "inside" the previous fence and its first line is
    // wrongly treated as protected literal text.
    const firstText = "```toml\n[read.section]\n";
    const call = ["[read]", '{"path":"secret.txt"}', "[/read]"].join("\n");
    const events = await normalize(
      [
        streamTextDelta(firstText),
        doneAssistantEvent("stop", textContent(firstText), "stop"),
        streamTextDelta(`${call}\n`),
        doneAssistantEvent("stop", textContent(`${call}\n`), "stop"),
      ],
      { protectFences: true },
    );

    expect(textDeltas(events).join("")).not.toContain('{"path":"secret.txt"}');
  });

  it("keeps protection resolution bounded across a bracket-dense fenced answer", async () => {
    let resolverCalls = 0;
    // `[read...` is candidate-shaped for this matcher, so every line trips the candidate
    // check while staying protected by the surrounding fence.
    const fenced = [
      "```toml",
      ...Array.from({ length: 300 }, (_, index) => `[read.section.${index}]\nname = "svc"`),
      "```",
      "",
    ].join("\n");
    // Split so every '[' lands at the end of its own delta, which is what makes a real
    // provider stream trip the candidate check on nearly every line.
    const deltas = fenced.split(/(?<=\[)/);
    const events = await collectNormalizedEvents(
      deltas.map((delta) => streamTextDelta(delta)),
      {
        matcher,
        createPromotedToolCallEvents: () => [],
        normalizeTerminalMessage: () => undefined,
        protectedRangesFenceCompatible: true,
        resolveProtectedRanges: (text) => {
          resolverCalls += 1;
          return resolveTestFenceRanges(text);
        },
      },
    );

    // Before the carried fence state existed this resolved the whole accumulated
    // response once per bracket delta (hundreds of full parses over a growing buffer).
    expect(resolverCalls).toBeLessThanOrEqual(3);
    expect(textDeltas(events).join("")).toBe(fenced);
  });

  it("keeps protection resolution bounded when every delta carries a cumulative partial", async () => {
    let resolverCalls = 0;
    // OpenAI-completions and Mistral attach a growing cumulative snapshot to every
    // text_delta via `partial`. resolvePartialProtectionCheck validates against exactly
    // that shape and, when it validates, still does a full Markdown parse of the
    // snapshot — so if it ran ahead of the carried-fence-state fast path, the fast path
    // would never get a chance to answer and the quadratic parse would persist even
    // with protectedRangesFenceCompatible set.
    const fenced = [
      "```toml",
      ...Array.from({ length: 300 }, (_, index) => `[read.section.${index}]\nname = "svc"`),
      "```",
      "",
    ].join("\n");
    const deltas = fenced.split(/(?<=\[)/);
    let accumulated = "";
    const events = await collectNormalizedEvents(
      deltas.map((delta) => {
        accumulated += delta;
        return streamTextDelta(delta, 0, assistantMessage(textContent(accumulated)));
      }),
      {
        matcher,
        createPromotedToolCallEvents: () => [],
        normalizeTerminalMessage: () => undefined,
        protectedRangesFenceCompatible: true,
        resolveProtectedRanges: (text) => {
          resolverCalls += 1;
          return resolveTestFenceRanges(text);
        },
      },
    );

    expect(resolverCalls).toBeLessThanOrEqual(3);
    expect(textDeltas(events).join("")).toBe(fenced);
  });

  it("keeps a large preceding block's prefix check bounded across many later candidates (#122513)", async () => {
    // End the preceding line so the next block opens a CommonMark fence.
    const precedingBlock = `${"x".repeat(199_999)}\n`;
    const fenced = [
      "```toml",
      ...Array.from({ length: 300 }, (_, index) => `[read.section.${index}]\nname = "svc"`),
      "```",
      "",
    ].join("\n");
    const deltas = fenced.split(/(?<=\[)/);
    let accumulated = "";
    const events = [
      streamTextDelta(precedingBlock, 0, assistantMessage(textContent(precedingBlock, ""))),
      ...deltas.map((delta) => {
        accumulated += delta;
        return streamTextDelta(
          delta,
          1,
          assistantMessage(textContent(precedingBlock, accumulated)),
        );
      }),
    ];

    let resolverCalls = 0;
    let precedingPrefixSlices = 0;
    // oxlint-disable-next-line typescript/unbound-method -- called below with the intercepted string receiver.
    const originalSlice = String.prototype.slice;
    const sliceSpy = vi
      .spyOn(String.prototype, "slice")
      .mockImplementation(function (this: string, start, end) {
        if (start === 0 && end === precedingBlock.length && this.length >= end) {
          precedingPrefixSlices += 1;
        }
        return originalSlice.call(this, start, end);
      });
    let normalized: Record<string, unknown>[];
    try {
      normalized = await collectNormalizedEvents(events, {
        matcher,
        createPromotedToolCallEvents: () => [],
        normalizeTerminalMessage: () => undefined,
        protectedRangesFenceCompatible: true,
        resolveProtectedRanges: (text) => {
          resolverCalls += 1;
          return resolveTestFenceRanges(text);
        },
      });
    } finally {
      sliceSpy.mockRestore();
    }

    expect(resolverCalls).toBeLessThanOrEqual(3);
    // Rechecking the entire preceding block for every candidate makes work quadratic.
    // Count full-prefix operations so this bound does not depend on runner speed.
    expect(precedingPrefixSlices).toBeLessThanOrEqual(4);
    expect(textDeltas(normalized).join("")).toBe(precedingBlock + fenced);
  });

  it("still protects an unfenced caller-defined range when the fast path is not opted in", async () => {
    // The carried fence scan only ever proves fence state. A resolver whose protected
    // ranges are not fences at all (unlike resolveTestFenceRanges/findCodeRegions) would be
    // silently bypassed if the stream trusted the fast path's "not protected" verdict for
    // it, so this must go through the full resolver instead — this caller never opts in.
    const OPEN_MARK = "<<PROTECT>>";
    const CLOSE_MARK = "<<END>>";
    const resolveMarkedRanges = (text: string) => {
      const ranges: Array<{ end: number; start: number }> = [];
      let cursor = 0;
      for (;;) {
        const start = text.indexOf(OPEN_MARK, cursor);
        if (start === -1) {
          break;
        }
        const close = text.indexOf(CLOSE_MARK, start + OPEN_MARK.length);
        const end = close === -1 ? text.length : close + CLOSE_MARK.length;
        ranges.push({ start, end });
        cursor = end;
      }
      return ranges;
    };
    const call = ["[read]", '{"path":"secret.txt"}', "[/read]"].join("\n");
    // A trailing newline keeps every line complete; an unfinished final line is a shape the
    // fast path already declines on its own, which would mask the bug this test targets.
    const text = `${OPEN_MARK}\n${call}\n${CLOSE_MARK}\n`;
    const events = await collectNormalizedEvents(
      [streamTextDelta(text), doneAssistantEvent("stop", textContent(text), "stop")],
      {
        matcher,
        createPromotedToolCallEvents: () => [],
        normalizeTerminalMessage: ({ message }) => {
          const scrubbed = projectScrubbedPlainTextToolCallMessage({
            matcher,
            message,
            resolveProtectedRanges: resolveMarkedRanges,
          });
          return scrubbed ? { kind: "scrubbed", ...scrubbed } : undefined;
        },
        resolveProtectedRanges: resolveMarkedRanges,
      },
    );

    expect(textDeltas(events).join("")).toBe(text);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      message: { content: textContent(text), stopReason: "stop" },
    });
  });

  it("still scrubs an unfenced call from live deltas and the terminal message", async () => {
    const text = ["[read]", '{"path":"secret.txt"}', "[/read]"].join("\n");
    const events = await normalize(
      [streamTextDelta(text), doneAssistantEvent("length", textContent(text), "length")],
      { protectFences: true },
    );

    expect(textDeltas(events)).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      message: { content: [{ type: "text", text: "" }], stopReason: "length" },
    });
  });

  it.each(["comment", "analysis", "final", "<", "["])(
    "preserves the unnamed protocol prefix %s in terminal prose",
    (prefix) => {
      const message = assistantMessage(`Visible answer\n${prefix}`);
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
      streamTextDelta(prefix),
      streamTextDelta('"}'),
      ...whitespaceChunks.map((delta) => streamTextDelta(delta)),
      streamTextDelta(tail),
      doneAssistantEvent("length", textContent(raw), "length"),
    ]);

    expect(textDeltas(events)).toEqual(["Visible"]);
    expectTerminalContent(events, "done", textContent("Visible"));
    expect(JSON.stringify(events)).not.toContain("[read]");
  });

  it("bounds blank-line buffering after a complete call", async () => {
    const call = "<function=read></function>\n";
    const whitespaceChunks = Array.from({ length: 65 }, () => "\n".repeat(4096));
    const events = await normalize([
      streamTextDelta(call),
      ...whitespaceChunks.map((delta) => streamTextDelta(delta)),
      streamTextDelta("Visible"),
    ]);

    const deltas = textDeltas(events);
    expect(deltas.at(-1)).toBe("Visible");
    expect(deltas.slice(0, -1).join("").length).toBeLessThanOrEqual(2 * 4096);
    expect(JSON.stringify(events)).not.toContain("<function=read>");
  });

  it("preserves visible whitespace when an optional JSON closer is absent", async () => {
    const prefix = `[tool:read] {"path":"${"x".repeat(256_001)}`;
    const suffix = '"}\n\nVisible';
    const events = await normalizeTextDeltas(prefix, suffix);

    expect(textDeltas(events)).toEqual(["\nVisible"]);
  });

  it("preserves split visible whitespace when an optional JSON closer is absent", async () => {
    const prefix = `[tool:read] {"path":"${"x".repeat(256_001)}`;
    const events = await normalizeTextDeltas(prefix, '"}', "\n\n", "Visible");

    expect(textDeltas(events)).toEqual(["\nVisible"]);
  });

  it("retains a later text start when a buffered call leaves visible text", async () => {
    const call = "<function=read></function>\n";
    const suffix = "Visible";
    const events = await normalize([
      streamTextDelta(call),
      textStart(1),
      streamTextDelta(suffix, 1),
    ]);

    expect(events).toMatchObject([
      { type: "text_start", contentIndex: 1 },
      { type: "text_delta", contentIndex: 1, delta: suffix },
    ]);
  });

  it("retains a new block supplied only by its authoritative text end", async () => {
    const events = await normalize([streamTextDelta("[read]"), textEnd("Visible answer", 1)]);

    expect(events).toEqual([
      { type: "text_delta", contentIndex: 0, delta: "[read]" },
      { type: "text_end", contentIndex: 1, content: "Visible answer" },
    ]);
  });

  it("keeps an incomplete call private across a cumulative text end", async () => {
    const visible = "Hello\n";
    const call = "<function=read><parameter=path>SECRET";
    const raw = visible + call;
    const events = await normalize([streamTextDelta(raw), textEnd(raw, 0)]);

    expect(textDeltas(events)).toEqual([visible]);
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });

  it("projects sanitized text across the original terminal content indexes", async () => {
    const intro = "Visible intro.\n";
    const call = "<function=read></function>\n";
    const suffix = "Visible suffix.";
    const content = textContent(intro, call, suffix);
    const events = await normalize([
      streamTextDelta(intro),
      streamTextDelta(call, 1),
      streamTextDelta(suffix, 2),
      doneAssistantEvent("length", content, "length"),
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
    const content = textContent(call, suffix);
    const events = await normalize([
      streamTextDelta(call),
      streamTextDelta(suffix, 1),
      doneAssistantEvent("length", content, "length"),
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
    const error = assistantMessage([{ type: "text", text: call }, thinking, suffix]);
    const events = await normalize([
      streamTextDelta(call),
      streamTextDelta(suffix.text, 2),
      errorEvent(error),
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
      streamTextDelta(intro),
      streamTextDelta(`${call}${suffix}`),
      doneAssistantEvent("length", textContent(raw), "length"),
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
      streamTextDelta(first),
      streamTextDelta(second),
      textEnd(raw, 0),
      doneAssistantEvent("length", textContent(raw), "length"),
    ]);

    expect(eventTypes(events)).toEqual(["text_delta", "text_delta", "text_delta", "done"]);
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
      doneAssistantEvent("length", textContent(raw), "length"),
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
        ...chunks.map((delta) => streamTextDelta(delta)),
        textEnd(raw, 0, withPartial ? assistantMessage(textContent(raw)) : undefined),
        doneAssistantEvent("length", textContent(raw), "length"),
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
      streamTextDelta(call),
      ...chunks.map((delta) => streamTextDelta(delta)),
      textEnd(raw, 0),
      doneAssistantEvent("length", textContent(raw), "length"),
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
        partial: assistantMessage([{ type: "text", text: call }, thinking]),
      },
      errorEvent({ message: "stream failed" }),
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
        partial: assistantMessage([{ type: "text", text: `${visible}${prefix}` }, thinking]),
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
      expect(textDeltas(await normalize([streamTextDelta(word)]))).toEqual([word]);
    },
  );

  it("reconciles false-prefix prose completed by text_end", async () => {
    const events = await normalize([
      streamTextDelta("analysis"),
      textEnd("analysis is ordinary prose", 0),
    ]);

    expect(textDeltas(events)).toEqual(["analysis is ordinary prose"]);
    expect(eventTypes(events)).toEqual(["text_delta", "text_end"]);
  });

  it("bounds unnamed Harmony prefixes before EOF", async () => {
    const raw = `analysis${" ".repeat(256_001)}`;
    const events = await normalize([streamTextDelta(raw)]);

    expect(textDeltas(events)).toEqual([raw]);
  });

  it("preserves a malformed parameter marker after over-cap XML", async () => {
    const prefix = `<function=read><parameter=path>${"x".repeat(256_001)}</parameter>`;
    const suffix = "<parameter=x!>Visible answer";
    const events = await normalizeTextDeltas(prefix, suffix);

    expect(textDeltas(events)).toEqual([suffix]);
  });

  it("recovers a visible suffix delivered only by an over-cap text_end", async () => {
    const prefix = `<function=read><parameter=path>${"x".repeat(256_001)}`;
    const complete = `${prefix}</parameter></function>\nVisible answer`;
    const events = await normalize([streamTextDelta(prefix), textEnd(complete, 0)]);

    expect(textDeltas(events)).toEqual(["Visible answer"]);
    expect(JSON.stringify(events)).not.toContain("<function=read>");
  });

  it("fails closed on an unresolved authoritative tool-name prefix", async () => {
    const content = "Hello\n[tool:re";
    const event = textEnd(content, 0);

    expect(textDeltas(await normalize([event]))).toEqual(["Hello\n"]);
  });

  it("emits a held text start before a synthetic visible prefix", async () => {
    const visible = "Visible\n";
    const candidate = "[tool:re nope";
    const raw = visible + candidate;
    const events = await normalize([
      textStart(0, "", assistantMessage(textContent(""))),
      textDelta(`${visible}[tool:re`, `${visible}[tool:re`),
      textDelta(" nope", raw),
    ]);

    expect(eventTypes(events)).toEqual(["text_start", "text_delta", "text_delta"]);
    expect(textDeltas(events)).toEqual([visible, candidate]);
  });

  it.each(["[tool:read]", "analysis to=read code"])(
    "suppresses over-cap whitespace before a split JSON payload for %s",
    async (header) => {
      const prefix = header + " ".repeat(256_001);
      const payload = '{"path":"SECRET"}<|call|>';
      const events = await normalizeTextDeltas(prefix, payload);

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
    const events = await normalize(withTerminal([streamTextDelta(raw)], terminal, raw));

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
    const rawMessage = assistantMessage(textContent(header, payload), "stop");
    const promotedMessage = assistantMessage(
      [{ type: "toolCall", id: "call_repaired", name: "read", arguments: { path: "SECRET" } }],
      "toolUse",
    );
    const events = await collectNormalizedEvents(
      [
        textStart(0),
        streamTextDelta(header),
        textEnd(header, 0),
        textStart(1),
        streamTextDelta(payload, 1),
        textEnd(payload, 1),
        doneEvent("stop", rawMessage),
      ],
      {
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
      },
    );

    expect(eventTypes(events)).toEqual(["start", "toolcall_start", "toolcall_end", "done"]);
    expect(events.at(-1)).toMatchObject({ reason: "toolUse", message: promotedMessage });
    expect(JSON.stringify(events)).not.toContain("[/read]");
  });

  it("preserves native tool-call partials while replaying a false-positive prefix", async () => {
    const prefix = "[tool:re";
    const toolCall = { type: "toolCall", id: "call_native", name: "other", arguments: {} };
    const partial = assistantMessage([{ type: "text", text: prefix }, toolCall]);
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
