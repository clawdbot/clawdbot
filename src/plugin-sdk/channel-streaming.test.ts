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
    expect(DEFAULT_PROGRESS_DRAFT_LABELS.every((label) => label.endsWith("..."))).toBe(true);
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
    ).toBe("Shelling\n• `patch applied`\n• `tests done`");
    expect(
      formatChannelProgressDraftText({
        entry,
        lines: ["🛠️ Exec", "plain update"],
      }),
    ).toBe("Shelling\n🛠️ Exec\n• plain update");
  });

  it("bounds progress draft line length to reduce edit reflow", () => {
    expect(
      formatChannelProgressDraftText({
        entry: { streaming: { progress: { label: "Shelling" } } },
        lines: ["x".repeat(80)],
        formatLine: (line) => `\`${line}\``,
      }),
    ).toBe(`Shelling\n• \`${"x".repeat(71)}…\``);
  });

  it("keeps compacted raw progress lines from leaking unmatched markdown backticks", () => {
    const line = formatChannelProgressDraftLine(
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
      lines: [line ?? ""],
    });

    expect(text).toBe("Shelling\n🛠️ Exec: run node script…that/keeps/going/and/going/index…");
    expect(text.match(/`/g) ?? []).toHaveLength(0);
  });

  it("formats progress draft lines with shared tool display labels", () => {
    expect(
      buildChannelProgressDraftLine({
        event: "tool",
        name: "write",
        args: { path: "/tmp/demo/index.html" },
      }),
    ).toMatchObject({
      kind: "tool",
      icon: "✍️",
      label: "Write",
      detail: "to /tmp/demo/index.html",
      text: "✍️ Write: to /tmp/demo/index.html",
      toolName: "write",
    });
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
    ).toBe("🛠️ Exec: run tests, `pnpm test -- --watch=false`");
    expect(
      formatChannelProgressDraftLine({
        event: "item",
        itemKind: "command",
        name: "exec",
        progressText: "raw command output",
      }),
    ).toBe("🛠️ Exec: raw command output");
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
