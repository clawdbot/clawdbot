import { describe, expect, it } from "vitest";
import { inferToolMetaFromArgsCore } from "../agents/tool-display.js";
import { formatToolAggregate } from "../auto-reply/tool-meta.js";
import {
  buildChannelProgressDraftLine,
  buildChannelProgressDraftLineForEntry,
  formatChannelProgressDraftText,
  formatPlanChecklistLines,
  normalizeAgentPlanSteps,
  isChannelProgressDraftWorkToolName,
  mergeChannelProgressDraftLine,
  resolveChannelPreviewStreamMode,
  resolveChannelStreamingBlockCoalesce,
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingChunkMode,
  resolveChannelStreamingNativeTransport,
  resolveChannelStreamingPreviewChunk,
  resolveChannelStreamingProgressCommentary,
  resolveChannelStreamingProgressNarration,
} from "./streaming.js";

describe("buildChannelProgressDraftLine", () => {
  it("suppresses update_plan from generic work-tool progress", () => {
    expect(isChannelProgressDraftWorkToolName("update_plan")).toBe(false);
  });

  it("omits generic completed status from successful command output with title", () => {
    const line = buildChannelProgressDraftLine(
      {
        event: "command-output",
        toolCallId: "exec-1",
        phase: "end",
        title: "pwd",
        name: "exec",
        exitCode: 0,
      },
      { commandText: "raw" },
    );

    expect(line).toMatchObject({
      kind: "command-output",
      id: "exec-1",
      text: "🛠️ pwd",
      detail: "pwd",
      status: "completed",
    });
  });

  it("uses the tool label when successful command output has no title", () => {
    const line = buildChannelProgressDraftLine({
      event: "command-output",
      phase: "end",
      name: "exec",
      exitCode: 0,
    });

    expect(line).toMatchObject({
      kind: "command-output",
      text: "🛠️ Exec",
      status: "completed",
    });
    expect(line?.detail).toBeUndefined();
  });

  it("keeps command status and title in raw command progress lines", () => {
    const line = buildChannelProgressDraftLine(
      {
        event: "command-output",
        toolCallId: "exec-1",
        phase: "end",
        title: "command false",
        name: "exec",
        exitCode: 2,
      },
      { commandText: "raw" },
    );

    expect(line).toMatchObject({
      kind: "command-output",
      id: "exec-1",
      text: "🛠️ exit 2; command false",
      detail: "command false",
      status: "exit 2",
    });
  });

  it("keeps only command status in status-only progress lines", () => {
    const line = buildChannelProgressDraftLine(
      {
        event: "command-output",
        phase: "end",
        title: "command false",
        name: "exec",
        exitCode: 2,
      },
      { commandText: "status" },
    );

    expect(line).toMatchObject({
      kind: "command-output",
      text: "🛠️ exit 2",
      detail: "exit 2",
      status: "exit 2",
    });
    expect(line?.text).not.toContain("command false");
  });

  it("defaults entry-backed command progress to status and preserves explicit raw text", () => {
    const input = {
      event: "tool" as const,
      name: "exec",
      phase: "start",
      args: { command: "echo private" },
    };

    expect(buildChannelProgressDraftLineForEntry(undefined, input)?.text).toBe("🛠️ Exec");
    expect(
      buildChannelProgressDraftLineForEntry(
        { streaming: { progress: { commandText: "raw" } } },
        input,
        { detailMode: "raw" },
      )?.text,
    ).toContain("echo private");

    const commandOutput = {
      event: "command-output" as const,
      name: "exec",
      phase: "end",
      title: "echo private",
      exitCode: 1,
    };
    expect(buildChannelProgressDraftLine(commandOutput)?.text).toBe("🛠️ exit 1");
    expect(buildChannelProgressDraftLine(commandOutput, { commandText: "raw" })?.text).toContain(
      "echo private",
    );

    const item = {
      event: "item" as const,
      itemKind: "command",
      name: "exec",
      phase: "start",
      status: "running",
      meta: "echo private",
    };
    expect(buildChannelProgressDraftLine(item)?.text).toBe("🛠️ Exec");
    expect(buildChannelProgressDraftLine(item, { commandText: "raw" })?.text).toContain(
      "echo private",
    );

    const namespaced = {
      event: "tool" as const,
      name: "server.exec",
      phase: "start",
      args: { command: "echo private" },
    };
    expect(buildChannelProgressDraftLineForEntry(undefined, namespaced)?.text).not.toContain(
      "echo private",
    );
    expect(
      buildChannelProgressDraftLineForEntry(
        { streaming: { progress: { commandText: "raw" } } },
        namespaced,
      )?.text,
    ).toContain("echo private");
  });

  it("renders plain sentences for command tools without argv or tool chrome", () => {
    const line = buildChannelProgressDraftLine(
      {
        event: "tool",
        name: "exec",
        phase: "start",
        args: { command: "git status", workdir: "/workspace/project" },
      },
      { detailMode: "plain", commandText: "status" },
    );
    expect(line?.text).toBe("I'm checking the current state of the project.");
    expect(line?.text).not.toContain("git");
    expect(line?.text).not.toContain("/workspace");
    expect(line?.text).not.toContain("🛠️");
  });

  it("keeps plain sentences when command start is replaced by command-output", () => {
    const start = buildChannelProgressDraftLine(
      {
        event: "tool",
        toolCallId: "call-1",
        name: "exec",
        phase: "start",
        args: { command: "git status", workdir: "/workspace/project" },
      },
      { detailMode: "plain", commandText: "status" },
    );
    const plainTitle = "I'm checking the current state of the project.";
    const done = buildChannelProgressDraftLine(
      {
        event: "command-output",
        toolCallId: "call-1",
        name: "exec",
        phase: "end",
        exitCode: 0,
        title: plainTitle,
      },
      { detailMode: "plain", commandText: "status" },
    );
    const failed = buildChannelProgressDraftLine(
      {
        event: "command-output",
        toolCallId: "call-1",
        name: "exec",
        phase: "end",
        exitCode: 1,
        title: plainTitle,
      },
      { detailMode: "plain", commandText: "status" },
    );

    expect(start?.text).toBe(plainTitle);
    expect(done?.text).toBe(plainTitle);
    expect(done?.text).not.toContain("🛠️");
    expect(done?.text).not.toContain("git");
    // Failures keep the plain activity sentence (never exit codes / tool chrome).
    expect(failed?.text).toBe(plainTitle);
    expect(failed?.text).not.toContain("🛠️");
    expect(failed?.text).not.toContain("exit");
    expect(failed?.text).not.toContain("git status");
    expect(failed?.text).not.toContain("/workspace");
  });

  it("uses a plain-language failure when no safe sentence is available", () => {
    const failed = buildChannelProgressDraftLine(
      {
        event: "command-output",
        toolCallId: "call-2",
        name: "exec",
        phase: "end",
        exitCode: 1,
      },
      { detailMode: "plain", commandText: "status" },
    );
    expect(failed?.text).toBe("That step didn't work.");
    expect(failed?.text).not.toContain("exit");
    expect(failed?.text).not.toContain("🛠️");
  });
});

// Claude CLI tool names arrive capitalized. Each tool call is described twice —
// a structured progress line and the tool-summary payload that channels without
// a progress draft render as text — so both must resolve to one draft line.
describe("backend tool-name casing", () => {
  const CLI_TOOL_CALLS = [
    { name: "Bash", args: { command: "echo alpha", description: "print text" } },
    { name: "Read", args: { file_path: "/tmp/x.ts" } },
    { name: "Edit", args: { file_path: "/tmp/x.ts", old_string: "a", new_string: "b" } },
    { name: "mcp__openclaw__exec", args: { command: "echo alpha" } },
  ] as const;

  it.each(CLI_TOOL_CALLS)("renders $name as one line", ({ name, args }) => {
    const structured = buildChannelProgressDraftLine(
      {
        event: "tool",
        toolCallId: "call-1",
        name,
        phase: "start",
        args,
      },
      { commandText: "raw" },
    );
    const meta = inferToolMetaFromArgsCore(name, args, { detailMode: "explain" });
    const summaryText = formatToolAggregate(name, meta ? [meta] : undefined, { markdown: true });

    const merged = mergeChannelProgressDraftLine(
      structured ? [structured] : [],
      { kind: "item", label: "", text: summaryText, prefix: false },
      { maxLines: 8 },
    );

    expect(merged).toHaveLength(1);
  });

  it("keeps explicit raw shell detail so renderers never fall back to prefixed text", () => {
    // Without detail, a renderer composing "<icon> <label>" then appending the
    // line text prints the icon twice ("🛠️ Bash 🛠️ print text").
    const line = buildChannelProgressDraftLine(
      {
        event: "tool",
        toolCallId: "call-1",
        name: "Bash",
        phase: "start",
        args: { command: "echo alpha", description: "print text" },
      },
      { commandText: "raw" },
    );

    expect(line?.detail).toBe("print text");
    expect(line?.text).toBe(`${line?.icon} print text`);
  });
});

describe("mergeChannelProgressDraftLine", () => {
  it("keeps identical visible lines distinct when their stable ids differ", () => {
    const first = { id: "tool-1", kind: "tool" as const, text: "bash", label: "bash" };
    const second = { id: "tool-2", kind: "tool" as const, text: "bash", label: "bash" };

    const lines = mergeChannelProgressDraftLine([first], second, { maxLines: 8 });

    expect(lines.map((line) => line.id)).toEqual(["tool-1", "tool-2"]);
  });
});

describe("normalizeAgentPlanSteps", () => {
  it("normalizes external-plugin string steps and typed entries, dropping blanks", () => {
    expect(
      normalizeAgentPlanSteps([
        "Inspect",
        "  ",
        { step: "  Patch  ", status: "in_progress" },
        { step: "   ", status: "pending" },
        { step: "Test", status: "bogus" },
      ]),
    ).toEqual([
      { step: "Inspect", status: "pending" },
      { step: "Patch", status: "in_progress" },
    ]);
    expect(normalizeAgentPlanSteps(undefined)).toBeUndefined();
  });
});

describe("streaming config resolution", () => {
  it("resolves the canonical nested streaming shape", () => {
    const entry = {
      streaming: {
        mode: "block",
        chunkMode: "newline",
        preview: { chunk: { minChars: 10 } },
        block: { enabled: true, coalesce: { idleMs: 5 } },
        nativeTransport: false,
      },
    };

    expect(resolveChannelPreviewStreamMode(entry, "partial")).toBe("block");
    expect(resolveChannelStreamingChunkMode(entry)).toBe("newline");
    expect(resolveChannelStreamingBlockEnabled(entry)).toBe(true);
    expect(resolveChannelStreamingPreviewChunk(entry)).toEqual({ minChars: 10 });
    expect(resolveChannelStreamingBlockCoalesce(entry)).toEqual({ idleMs: 5 });
    expect(resolveChannelStreamingNativeTransport(entry)).toBe(false);
  });

  it.each(["partial", "block", "progress"] as const)(
    "lets an available explicit %s preview override the inherited block default",
    (mode) => {
      expect(
        resolveChannelStreamingBlockEnabled(
          { streaming: { mode } },
          {
            previewAvailable: true,
            blockStreamingDefault: "on",
          },
        ),
      ).toBe(false);
    },
  );

  it("keeps the inherited block default for off or invalid preview modes", () => {
    expect(
      resolveChannelStreamingBlockEnabled(
        { streaming: { mode: "off" } },
        {
          previewAvailable: true,
          blockStreamingDefault: "on",
        },
      ),
    ).toBe(true);
    expect(
      resolveChannelStreamingBlockEnabled(
        { streaming: { mode: "invalid" } },
        {
          previewAvailable: true,
          blockStreamingDefault: "on",
        },
      ),
    ).toBe(true);
  });

  it("preserves block precedence when preview delivery is unavailable", () => {
    expect(
      resolveChannelStreamingBlockEnabled(
        { streaming: { mode: "partial" } },
        {
          previewAvailable: false,
          blockStreamingDefault: "on",
        },
      ),
    ).toBe(true);
  });

  it("keeps explicit block configuration authoritative", () => {
    expect(
      resolveChannelStreamingBlockEnabled(
        { streaming: { mode: "partial", block: { enabled: true } } },
        {
          previewAvailable: true,
          blockStreamingDefault: "off",
        },
      ),
    ).toBe(true);
    expect(
      resolveChannelStreamingBlockEnabled(
        { streaming: { mode: "partial", block: { enabled: false } } },
        {
          previewAvailable: true,
          blockStreamingDefault: "on",
        },
      ),
    ).toBe(false);
  });
});

describe("progress narration", () => {
  it("renders plan markers and keeps the checklist under narration", () => {
    const plan = [
      { step: "Inspect", status: "completed" as const },
      { step: "Patch", status: "in_progress" as const },
      { step: "Test", status: "pending" as const },
    ];

    expect(formatPlanChecklistLines(plan, { maxLines: 5, maxLineChars: 80 })).toEqual([
      "✅ Inspect",
      "▸ Patch",
      "▢ Test",
    ]);
    expect(
      formatChannelProgressDraftText({
        entry: { streaming: { mode: "progress", progress: { label: false } } },
        lines: ["🛠️ Exec"],
        narration: "Working through the plan.",
        plan,
      }),
    ).toBe("Working through the plan.\n\n🛠️ Exec\n✅ Inspect\n▸ Patch\n▢ Test");
  });

  it("summarizes overflowing plans and prioritizes unfinished steps", () => {
    expect(
      formatPlanChecklistLines(
        [
          { step: "One", status: "completed" },
          { step: "Two", status: "completed" },
          { step: "Three", status: "in_progress" },
          { step: "Four", status: "pending" },
        ],
        { maxLines: 3, maxLineChars: 80 },
      ),
    ).toEqual(["✅ 2/4 done", "▸ Three", "▢ Four"]);
  });

  it("keeps the active step when later pending work fills the checklist", () => {
    expect(
      formatPlanChecklistLines(
        [
          { step: "Done", status: "completed" },
          { step: "Active", status: "in_progress" },
          { step: "Next", status: "pending" },
          { step: "Later", status: "pending" },
          { step: "Last", status: "pending" },
        ],
        { maxLines: 3, maxLineChars: 80 },
      ),
    ).toEqual(["✅ 1/5 done", "▸ Active", "▢ Last"]);
  });

  it("shares the line budget between tool progress and the checklist", () => {
    expect(
      formatChannelProgressDraftText({
        entry: {
          streaming: { mode: "progress", progress: { label: false, maxLines: 3 } },
        },
        lines: ["tool one", "tool two", "tool three"],
        plan: [
          { step: "Active", status: "in_progress" },
          { step: "Next", status: "pending" },
        ],
      }),
    ).toBe("• tool three\n▸ Active\n▢ Next");
  });

  it("drops every tool line when the checklist consumes the whole budget", () => {
    expect(
      formatChannelProgressDraftText({
        entry: {
          streaming: { mode: "progress", progress: { label: false, maxLines: 2 } },
        },
        lines: ["tool one", "tool two"],
        plan: [
          { step: "Active", status: "in_progress" },
          { step: "Next", status: "pending" },
        ],
      }),
    ).toBe("▸ Active\n▢ Next");
  });

  it("omits the implicit progress label when narration is available", () => {
    const text = formatChannelProgressDraftText({
      entry: { streaming: { mode: "progress" } },
      lines: ["🛠️ Exec"],
      narration: "Counting lines in the workspace files.",
    });

    expect(text).toBe("Counting lines in the workspace files.\n\n🛠️ Exec");
  });

  it("keeps an explicitly configured automatic label above narration", () => {
    const text = formatChannelProgressDraftText({
      entry: {
        streaming: {
          mode: "progress",
          progress: { label: "auto", labels: ["Clawing"] },
        },
      },
      lines: ["🛠️ Exec"],
      narration: "Counting lines in the workspace files.",
    });

    expect(text).toBe("Clawing\n\nCounting lines in the workspace files.\n\n🛠️ Exec");
  });

  it("keeps tool lines visible under the narration headline", () => {
    const text = formatChannelProgressDraftText({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      lines: ["🛠️ Exec", "🛠️ Wc"],
      narration: "Counting lines in the workspace files.",
    });

    expect(text).toBe("Shelling\n\nCounting lines in the workspace files.\n\n🛠️ Exec\n🛠️ Wc");
  });

  it("renders the narration headline alone when no work lines exist yet", () => {
    const text = formatChannelProgressDraftText({
      entry: { streaming: { mode: "progress", progress: { label: false } } },
      lines: [],
      narration: "Counting lines in the workspace files.",
    });

    expect(text).toBe("Counting lines in the workspace files.");
  });

  it("compacts narration at a word boundary instead of line width", () => {
    const narration = Array.from({ length: 60 }, (_value, index) => `word${index}`).join(" ");
    const text = formatChannelProgressDraftText({
      entry: { streaming: { mode: "progress", progress: { label: false } } },
      lines: [],
      narration,
    });

    expect(text.endsWith("…")).toBe(true);
    expect(Array.from(text).length).toBeLessThanOrEqual(280);
    expect(text).not.toContain("\n");
  });

  it("honors the caller's mode when resolving commentary", () => {
    // The progress-draft channels default to "progress" when streaming.mode is
    // unset, so guessing "partial" here made progress.commentary a silent no-op.
    const entry = { streaming: { progress: { commentary: true } } };
    expect(resolveChannelStreamingProgressCommentary(entry, false, "progress")).toBe(true);
    expect(resolveChannelStreamingProgressCommentary(entry, false, "partial")).toBe(false);
    expect(
      resolveChannelStreamingProgressCommentary(
        { streaming: { mode: "progress", progress: { commentary: true } } },
        false,
      ),
    ).toBe(true);
  });

  it("resolves the narration toggle with default on", () => {
    // Mode gating is the caller's job; unset config keeps narration available.
    expect(resolveChannelStreamingProgressNarration(undefined)).toBe(true);
    expect(resolveChannelStreamingProgressNarration({ streaming: { mode: "progress" } })).toBe(
      true,
    );
    expect(
      resolveChannelStreamingProgressNarration({
        streaming: { mode: "progress", progress: { narration: false } },
      }),
    ).toBe(false);
  });
});
