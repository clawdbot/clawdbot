import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildChannelProgressDraftLine,
  createChannelProgressDraftGate,
  DEFAULT_PROGRESS_DRAFT_LABELS,
  formatChannelProgressDraftLine,
  formatChannelProgressDraftLineForEntry,
  formatChannelProgressDraftText,
  getChannelStreamingConfigObject,
  isChannelProgressDraftWorkToolName,
  isPotentialTruncatedFinal,
  mergeChannelProgressDraftLine,
  resolveChannelPreviewStreamMode,
  resolveChannelProgressDraftLabel,
  resolveChannelProgressDraftMaxLines,
  resolveChannelProgressDraftRender,
  resolveChannelStreamingBlockCoalesce,
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingChunkMode,
  resolveChannelStreamingNativeTransport,
  resolveChannelStreamingPreviewCommandText,
  resolveChannelStreamingPreviewChunk,
  resolveChannelStreamingSuppressDefaultToolProgressMessages,
  resolveChannelStreamingPreviewToolProgress,
  resolveTranscriptBackedChannelFinalText,
  selectLongerFinalText,
} from "./channel-streaming.js";

describe("channel-streaming", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads canonical nested streaming config first", () => {
    const entry = {
      streaming: {
        chunkMode: "newline",
        nativeTransport: true,
        block: {
          enabled: true,
          coalesce: { minChars: 40, maxChars: 80, idleMs: 250 },
        },
        preview: {
          chunk: { minChars: 10, maxChars: 20, breakPreference: "sentence" },
          toolProgress: false,
          commandText: "status",
        },
      },
      chunkMode: "length",
      blockStreaming: false,
      nativeStreaming: false,
      blockStreamingCoalesce: { minChars: 5, maxChars: 15, idleMs: 100 },
      draftChunk: { minChars: 2, maxChars: 4, breakPreference: "paragraph" },
    } as const;

    expect(getChannelStreamingConfigObject(entry)).toEqual(entry.streaming);
    expect(resolveChannelStreamingChunkMode(entry)).toBe("newline");
    expect(resolveChannelStreamingNativeTransport(entry)).toBe(true);
    expect(resolveChannelStreamingBlockEnabled(entry)).toBe(true);
    expect(resolveChannelStreamingBlockCoalesce(entry)).toEqual({
      minChars: 40,
      maxChars: 80,
      idleMs: 250,
    });
    expect(resolveChannelStreamingPreviewChunk(entry)).toEqual({
      minChars: 10,
      maxChars: 20,
      breakPreference: "sentence",
    });
    expect(resolveChannelStreamingPreviewToolProgress(entry)).toBe(false);
    expect(resolveChannelStreamingPreviewCommandText(entry)).toBe("status");
  });

  it("keeps progress-only tool progress config out of normal preview modes", () => {
    expect(
      resolveChannelStreamingPreviewToolProgress({
        streaming: { mode: "partial", progress: { toolProgress: false } },
      }),
    ).toBe(true);
    expect(
      resolveChannelStreamingPreviewToolProgress({
        streaming: {
          mode: "block",
          preview: { toolProgress: true },
          progress: { toolProgress: false },
        },
      }),
    ).toBe(true);
    expect(
      resolveChannelStreamingPreviewToolProgress({
        streaming: {
          mode: "progress",
          preview: { toolProgress: true },
          progress: { toolProgress: false },
        },
      }),
    ).toBe(false);
  });

  it("falls back to legacy flat fields when the canonical object is absent", () => {
    const entry = {
      chunkMode: "newline",
      blockStreaming: true,
      nativeStreaming: true,
      blockStreamingCoalesce: { minChars: 120, maxChars: 240, idleMs: 500 },
      draftChunk: { minChars: 8, maxChars: 16, breakPreference: "newline" },
    } as const;

    expect(getChannelStreamingConfigObject(entry)).toBeUndefined();
    expect(resolveChannelStreamingChunkMode(entry)).toBe("newline");
    expect(resolveChannelStreamingNativeTransport(entry)).toBe(true);
    expect(resolveChannelStreamingBlockEnabled(entry)).toBe(true);
    expect(resolveChannelStreamingBlockCoalesce(entry)).toEqual({
      minChars: 120,
      maxChars: 240,
      idleMs: 500,
    });
    expect(resolveChannelStreamingPreviewChunk(entry)).toEqual({
      minChars: 8,
      maxChars: 16,
      breakPreference: "newline",
    });
    expect(resolveChannelStreamingPreviewToolProgress(entry)).toBe(true);
  });

  it("preserves progress as a first-class preview mode", () => {
    expect(resolveChannelPreviewStreamMode({ streaming: "progress" }, "off")).toBe("progress");
    expect(resolveChannelPreviewStreamMode({ streaming: { mode: "progress" } }, "off")).toBe(
      "progress",
    );
  });

  it("keeps block preview mode separate from block delivery", () => {
    expect(resolveChannelStreamingBlockEnabled({ streaming: "block" })).toBeUndefined();
    expect(resolveChannelStreamingBlockEnabled({ streaming: { mode: "block" } })).toBeUndefined();
    expect(
      resolveChannelStreamingBlockEnabled({
        streaming: { mode: "block", block: { enabled: true } },
      }),
    ).toBe(true);
    expect(resolveChannelStreamingBlockEnabled({ streaming: "block", blockStreaming: false })).toBe(
      false,
    );
  });

  it("selects a longer transcript candidate for ellipsis-truncated finals", async () => {
    const fullAnswer =
      "Here is the complete final answer with enough stable prefix text before the ellipsis and enough continuation text after it.";
    const truncatedFinal =
      "Here is the complete final answer with enough stable prefix text before the ellipsis...";

    expect(isPotentialTruncatedFinal(truncatedFinal)).toBe(true);
    expect(
      selectLongerFinalText({
        finalText: truncatedFinal,
        candidateTexts: ["short", fullAnswer],
      }),
    ).toBe(fullAnswer);
    await expect(
      resolveTranscriptBackedChannelFinalText({
        finalText: truncatedFinal,
        resolveCandidateText: async () => fullAnswer,
      }),
    ).resolves.toBe(fullAnswer);
  });

  it("keeps intentional ellipsis finals when candidates do not prove truncation", async () => {
    const finalText =
      "Here is the complete final answer with enough stable prefix text before an intentional pause...";
    const candidateText =
      "Here is the complete final answer with enough stable prefix text before an intentional pause... then punctuation";

    expect(
      selectLongerFinalText({
        finalText,
        candidateTexts: [candidateText],
      }),
    ).toBeUndefined();
    await expect(
      resolveTranscriptBackedChannelFinalText({
        finalText,
        resolveCandidateText: async () => candidateText,
      }),
    ).resolves.toBe(finalText);
  });

  it("suppresses standalone tool progress for active preview drafts", () => {
    expect(
      resolveChannelStreamingSuppressDefaultToolProgressMessages({
        streaming: { mode: "progress", progress: { toolProgress: false } },
      }),
    ).toBe(true);
    expect(
      resolveChannelStreamingSuppressDefaultToolProgressMessages(
        { streaming: { mode: "partial", preview: { toolProgress: false } } },
        { draftStreamActive: true },
      ),
    ).toBe(true);
    expect(
      resolveChannelStreamingSuppressDefaultToolProgressMessages(
        { streaming: { mode: "partial", preview: { toolProgress: false } } },
        { draftStreamActive: true, previewToolProgressEnabled: true },
      ),
    ).toBe(true);
    expect(
      resolveChannelStreamingSuppressDefaultToolProgressMessages(
        { streaming: { mode: "progress" } },
        { draftStreamActive: false },
      ),
    ).toBe(false);
  });

  it("uses auto progress labels when no explicit label is configured", () => {
    const invalidLabels = DEFAULT_PROGRESS_DRAFT_LABELS.filter((label) => !label.endsWith("..."));
    expect(invalidLabels).toStrictEqual([]);
    expect(resolveChannelProgressDraftLabel({ random: () => 0 })).toBe(
      DEFAULT_PROGRESS_DRAFT_LABELS[0],
    );
    expect(resolveChannelProgressDraftLabel({ random: () => 0.99 })).toBe(
      DEFAULT_PROGRESS_DRAFT_LABELS.at(-1),
    );
    expect(
      resolveChannelProgressDraftLabel({
        entry: { streaming: { progress: { label: " AUTO " } } },
        random: () => 0,
      }),
    ).toBe(DEFAULT_PROGRESS_DRAFT_LABELS[0]);
  });

  it("supports explicit progress labels and custom label sets", () => {
    expect(
      resolveChannelProgressDraftLabel({
        entry: { streaming: { progress: { label: "Crunching" } } },
      }),
    ).toBe("Crunching");
    expect(
      resolveChannelProgressDraftLabel({
        entry: { streaming: { progress: { labels: ["Pearling"] } } },
        random: () => 0.5,
      }),
    ).toBe("Pearling");
    expect(
      resolveChannelProgressDraftLabel({
        entry: { streaming: { progress: { label: false } } },
      }),
    ).toBeUndefined();
  });

  it("formats bounded progress draft text", () => {
    const entry = { streaming: { progress: { label: "Shelling", maxLines: 2, render: "rich" } } };
    expect(resolveChannelProgressDraftMaxLines(entry)).toBe(2);
    expect(resolveChannelProgressDraftRender(entry)).toBe("rich");
    expect(
      formatChannelProgressDraftText({
        entry,
        lines: [" tool: read ", "patch applied", "tests done"],
        formatLine: (line) => `\`${line}\``,
      }),
    ).toBe("• `patch applied`\n• `tests done`");
    expect(
      formatChannelProgressDraftText({
        entry,
        lines: ["🛠️ Exec", "plain update"],
      }),
    ).toBe("🛠️ Exec\n• plain update");
  });

  it("renders progress labels as rolling lines", () => {
    const entry = { streaming: { progress: { label: "Shelling", maxLines: 3 } } };

    expect(
      formatChannelProgressDraftText({
        entry,
        lines: ["🛠️ Exec", "📖 Read", "🩹 Patch"],
      }),
    ).toBe("🛠️ Exec\n📖 Read\n🩹 Patch");
  });

  it("renders structured progress lines with compact details", () => {
    const line = buildChannelProgressDraftLine({
      event: "patch",
      summary: "1 modified",
      modified: ["extensions/discord/src/monitor/message-handler.draft-preview.ts"],
    });

    expect(
      formatChannelProgressDraftText({
        entry: { streaming: { progress: { label: false } } },
        lines: line ? [line] : [],
      }),
    ).toBe("🩹 1 modified; extensions/discord/src/monitor/message-handler.draft-prev…");
  });

  it("bounds progress draft line length to reduce edit reflow", () => {
    expect(
      formatChannelProgressDraftText({
        entry: { streaming: { progress: { label: "Shelling" } } },
        lines: ["x".repeat(160)],
        formatLine: (line) => `\`${line}\``,
      }),
    ).toBe(`Shelling\n• \`${"x".repeat(71)}…\``);
  });

  it("keeps compacted raw progress lines from leaking unmatched markdown backticks", () => {
    const line = buildChannelProgressDraftLine(
      {
        event: "tool",
        name: "exec",
        args: {
          command:
            "node scripts/check-something-with-a-very-long-path /tmp/openclaw/some/really/deep/path/that/keeps/going/and/going/index.ts --flag value",
        },
      },
      { detailMode: "raw" },
    );

    const text = formatChannelProgressDraftText({
      entry: { streaming: { progress: { label: "Shelling" } } },
      lines: line ? [line] : [],
    });

    expect(text).toBe("Shelling\n🛠️ run node script…th/that/keeps/going/and/going/index…");
    expect(text.match(/`/g) ?? []).toHaveLength(0);
  });

  it("formats progress draft lines with shared tool display labels", () => {
    const progressLine = buildChannelProgressDraftLine({
      event: "tool",
      name: "write",
      args: { path: "/tmp/demo/index.html" },
    });
    if (!progressLine) {
      throw new Error("expected tool progress draft line");
    }
    expect(progressLine.kind).toBe("tool");
    expect(progressLine.icon).toBe("✍️");
    expect(progressLine.label).toBe("Write");
    expect(progressLine.detail).toBe("to /tmp/demo/index.html");
    expect(progressLine.text).toBe("✍️ Write: to /tmp/demo/index.html");
    expect(progressLine.toolName).toBe("write");
    expect(
      formatChannelProgressDraftLine({
        event: "tool",
        name: "write",
        args: { path: "/tmp/demo/index.html" },
      }),
    ).toBe("✍️ Write: to /tmp/demo/index.html");
    expect(
      formatChannelProgressDraftLine({
        event: "item",
        itemKind: "tool",
        name: "write",
        meta: "/tmp/demo/style.css",
      }),
    ).toBe("✍️ Write: /tmp/demo/style.css");
    expect(
      formatChannelProgressDraftLine({
        event: "patch",
        modified: ["/tmp/demo/index.html", "/tmp/demo/style.css"],
      }),
    ).toBe("🩹 Apply Patch: /tmp/demo/{index.html, style.css}");
    expect(
      formatChannelProgressDraftLine(
        {
          event: "tool",
          name: "exec",
          args: { command: "pnpm test -- --watch=false" },
        },
        { detailMode: "raw" },
      ),
    ).toBe("🛠️ run tests, `pnpm test -- --watch=false`");
    expect(
      formatChannelProgressDraftLine({
        event: "tool",
        name: "bash",
        args: { command: "sed -n '1,80p' extensions/discord/src/draft-stream.ts" },
      }),
    ).toBe("🛠️ print lines 1-80 from extensions/discord/src/draft-stream.ts");
    expect(
      formatChannelProgressDraftLine({
        event: "tool",
        name: "web_search",
        args: { search_query: [{ q: "Codex OAuth API key" }], response_length: "short" },
      }),
    ).toBe('🔎 Web Search: for "Codex OAuth API key"');
    expect(
      formatChannelProgressDraftLine({
        event: "item",
        itemKind: "command",
        name: "exec",
        progressText: "raw command output",
      }),
    ).toBe("🛠️ raw command output");
    expect(
      formatChannelProgressDraftLine(
        {
          event: "item",
          itemKind: "command",
          name: "exec",
          progressText: "raw command output",
        },
        { commandText: "status" },
      ),
    ).toBe("🛠️ Exec");
    expect(
      formatChannelProgressDraftLine(
        {
          event: "tool",
          name: "exec",
          args: { command: "pnpm test" },
        },
        { detailMode: "raw", commandText: "status" },
      ),
    ).toBe("🛠️ Exec");
    expect(
      formatChannelProgressDraftLineForEntry(
        { streaming: { preview: { commandText: "status" } } },
        {
          event: "item",
          itemKind: "command",
          name: "exec",
          progressText: "raw command output",
        },
      ),
    ).toBe("🛠️ Exec");
    expect(
      formatChannelProgressDraftLine({
        event: "item",
        itemKind: "analysis",
        title: "Reasoning",
      }),
    ).toBeUndefined();
    expect(
      formatChannelProgressDraftLine({
        event: "item",
        itemKind: "analysis",
        title: "Reasoning",
        progressText: "Reading the code path",
      }),
    ).toBe("Reading the code path");
  });

  it("updates keyed progress lines in place", () => {
    const first = buildChannelProgressDraftLine({
      event: "item",
      itemId: "preamble-1",
      itemKind: "preamble",
      title: "Preamble",
      progressText: "Checking the",
    });
    const second = buildChannelProgressDraftLine({
      event: "item",
      itemId: "preamble-1",
      itemKind: "preamble",
      title: "Preamble",
      progressText: "Checking the app-server stream",
    });
    if (!first || !second) {
      throw new Error("expected preamble progress lines");
    }

    const initialLines: Array<string | typeof first> = ["🛠️ Exec"];
    const lines = mergeChannelProgressDraftLine(initialLines, first, { maxLines: 4 });
    const updated = mergeChannelProgressDraftLine(lines, second, { maxLines: 4 });

    expect(updated).toHaveLength(2);
    expect(updated.at(-1)).toMatchObject({
      id: "preamble-1",
      text: "Checking the app-server stream",
    });
    expect(
      formatChannelProgressDraftText({
        lines: updated,
        entry: { streaming: { progress: { label: false } } },
      }),
    ).toBe("🛠️ Exec\n• Checking the app-server stream");
  });

  it("starts progress drafts after five seconds or a second work event", async () => {
    vi.useFakeTimers();
    const onStart = vi.fn(async () => {});
    const gate = createChannelProgressDraftGate({ onStart });

    await expect(gate.noteWork()).resolves.toBe(false);
    expect(onStart).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(onStart).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(gate.hasStarted).toBe(true);
  });

  it("starts progress drafts immediately on the second work event", async () => {
    vi.useFakeTimers();
    const onStart = vi.fn(async () => {});
    const gate = createChannelProgressDraftGate({ onStart });

    await gate.noteWork();
    await expect(gate.noteWork()).resolves.toBe(true);

    expect(onStart).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("ignores message-like tools for progress draft work", () => {
    expect(isChannelProgressDraftWorkToolName("message")).toBe(false);
    expect(isChannelProgressDraftWorkToolName("react")).toBe(false);
    expect(isChannelProgressDraftWorkToolName("web_search")).toBe(true);
    expect(isChannelProgressDraftWorkToolName("exec")).toBe(true);
  });
});
