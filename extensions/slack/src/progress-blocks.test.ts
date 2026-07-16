import { formatChannelProgressDraftText } from "openclaw/plugin-sdk/channel-outbound";
// Slack tests cover progress blocks plugin behavior.
import { describe, expect, it } from "vitest";
import {
  buildSlackProgressDraftBlocks,
  buildSlackProgressStreamCompletionChunks,
  buildSlackProgressStreamStartChunks,
  buildSlackProgressStreamUpdateChunks,
  reconcileSlackNativeTaskChunks,
} from "./progress-blocks.js";

function progressLine(index: number) {
  return {
    kind: "tool" as const,
    icon: "🛠️",
    label: `Exec ${index}`,
    detail: `run ${index}`,
    text: `🛠️ Exec ${index}: run ${index}`,
  };
}

function itemLine(text: string, label = text) {
  return { kind: "item" as const, label, text };
}

function toolLine(detail: string, label = "Exec") {
  return {
    kind: "tool" as const,
    icon: "🛠️",
    label,
    detail,
    text: `🛠️ ${label}: ${detail}`,
    toolName: label.toLowerCase(),
  };
}

function planUpdate(title: string) {
  return { type: "plan_update", title };
}

function taskUpdate(
  id: unknown,
  title: string,
  status: "pending" | "in_progress" | "complete" | "error",
) {
  return { type: "task_update", id, title, status };
}

function legacyHeadingBlock(text: string) {
  return {
    type: "section",
    text: { type: "mrkdwn", text },
  };
}

function legacyLineBlock(title: string, detail: string) {
  return {
    type: "section",
    fields: [
      { type: "mrkdwn", text: title },
      { type: "mrkdwn", text: detail },
    ],
  };
}

function expectLegacyLineBlock(block: unknown, title: string, detail: string) {
  expect(block).toEqual(legacyLineBlock(title, detail));
}

function expectTaskUpdate(task: unknown, fields: { id: string; title: string; status: string }) {
  expect(task).toEqual({
    type: "task_update",
    id: fields.id,
    title: fields.title,
    status: fields.status,
  });
}

describe("buildSlackProgressDraftBlocks", () => {
  it("keeps a typed checklist below Slack status draft text", () => {
    expect(
      formatChannelProgressDraftText({
        entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
        lines: [toolLine("hidden while status exists")],
        narration: "Implementing the change.",
        plan: [
          { step: "Inspect", status: "completed" },
          { step: "Patch", status: "in_progress" },
          { step: "Test", status: "pending" },
        ],
      }),
    ).toBe("Shelling\n\nImplementing the change.\n\n✅ Inspect\n▸ Patch\n▢ Test");
  });

  it("keeps legacy rich draft rendering as section field blocks", () => {
    expect(
      buildSlackProgressDraftBlocks({
        label: "Shelling...",
        lines: [toolLine("run tests")],
      }),
    ).toEqual([legacyHeadingBlock("*Shelling...*"), legacyLineBlock("🛠️ *Exec*", "run tests")]);
  });

  it("uses title as the legacy rich draft heading when label is absent", () => {
    expect(
      buildSlackProgressDraftBlocks({
        title: "Shelling...",
        lines: [toolLine("run tests")],
      }),
    ).toEqual([legacyHeadingBlock("*Shelling...*"), legacyLineBlock("🛠️ *Exec*", "run tests")]);
  });

  it("uses configured max line chars for legacy rich draft details", () => {
    const blocks = buildSlackProgressDraftBlocks({
      title: "Shelling...",
      maxLineChars: 64,
      lines: [
        {
          kind: "tool",
          icon: "🛠️",
          label: "Exec",
          detail: "run tests in /Users/example/Projects/openclaw/packages/very/deep/path/example",
          text: "🛠️ Exec: run tests in /Users/example/Projects/openclaw/packages/very/deep/path/example",
        },
      ],
    });

    expectLegacyLineBlock(
      blocks?.[1],
      "🛠️ *Exec*",
      "run tests in /Users/example/P…aw/packages/very/deep/path/example",
    );
  });

  it("keeps completed and failed statuses in legacy rich draft details", () => {
    const blocks = buildSlackProgressDraftBlocks({
      title: "Shelling...",
      lines: [
        {
          kind: "command-output",
          label: "Exec",
          detail: "command finished",
          status: "completed",
          text: "🛠️ Exec: completed",
          toolName: "exec",
        },
        {
          kind: "command-output",
          label: "Exec",
          detail: "command failed",
          status: "exit 1",
          text: "🛠️ Exec: exit 1",
          toolName: "exec",
        },
      ],
    });

    expectLegacyLineBlock(blocks?.[1], "• *Exec*", "command finished");
    expectLegacyLineBlock(blocks?.[2], "• *Exec*", "command failed · exit 1");
  });

  it("keeps newest rich progress lines when capping legacy draft blocks", () => {
    const blocksWithLabel = buildSlackProgressDraftBlocks({
      title: "Shelling...",
      lines: Array.from({ length: 60 }, (_value, index) => progressLine(index)),
    });
    expect(blocksWithLabel).toHaveLength(50);
    // The label block survives capping; tool lines yield the remaining budget.
    expect(JSON.stringify(blocksWithLabel?.[0])).toContain("Shelling...");
    expectLegacyLineBlock(blocksWithLabel?.[1], "🛠️ *Exec 11*", "run 11");
    expectLegacyLineBlock(blocksWithLabel?.at(-1), "🛠️ *Exec 59*", "run 59");

    const blocksWithoutTitle = buildSlackProgressDraftBlocks({
      lines: Array.from({ length: 60 }, (_value, index) => progressLine(index)),
    });
    expect(blocksWithoutTitle).toHaveLength(50);
    expectLegacyLineBlock(blocksWithoutTitle?.[0], "🛠️ *Exec 10*", "run 10");
    expectLegacyLineBlock(blocksWithoutTitle?.at(-1), "🛠️ *Exec 59*", "run 59");
  });

  it("renders legacy rich draft lines without a heading when no label or title is provided", () => {
    expect(
      buildSlackProgressDraftBlocks({
        lines: [toolLine("run tests")],
      }),
    ).toEqual([legacyLineBlock("🛠️ *Exec*", "run tests")]);
  });

  it("uses a blank legacy rich draft detail when structured detail is absent", () => {
    expect(
      buildSlackProgressDraftBlocks({
        lines: [itemLine("prepare the workspace", "Preamble"), toolLine("run tests")],
      }),
    ).toEqual([legacyLineBlock("• *Preamble*", "—"), legacyLineBlock("🛠️ *Exec*", "run tests")]);
  });

  it("does not emit legacy rich draft blocks when there are no lines or heading", () => {
    expect(
      buildSlackProgressDraftBlocks({
        lines: [],
      }),
    ).toBeUndefined();
  });
});

describe("native Slack progress stream chunks", () => {
  it("uses typed plan steps instead of tool lines when a plan exists", () => {
    const chunks = buildSlackProgressStreamStartChunks({
      title: "Implementation",
      lines: [toolLine("legacy fallback")],
      plan: [
        { step: "Inspect code", status: "completed" },
        { step: "Patch code", status: "in_progress" },
        { step: "Run tests", status: "pending" },
      ],
    });

    expect(chunks).toEqual([
      planUpdate("Implementation"),
      taskUpdate("plan_step_1", "Inspect code", "complete"),
      taskUpdate("plan_step_2", "Patch code", "in_progress"),
      taskUpdate("plan_step_3", "Run tests", "pending"),
    ]);
  });

  it("reconciles renamed and reordered plan steps by rewriting position-keyed tasks", () => {
    const initial = buildSlackProgressStreamStartChunks({
      title: "Implementation",
      lines: [],
      plan: [
        { step: "Inspect code", status: "completed" },
        { step: "Run tests", status: "pending" },
      ],
    });
    const revised = buildSlackProgressStreamUpdateChunks({
      title: "Implementation",
      lines: [],
      plan: [
        { step: "Inspect code", status: "completed" },
        { step: "Fix parser bug", status: "in_progress" },
        { step: "Run tests", status: "pending" },
      ],
    });

    expect(initial).toEqual([
      planUpdate("Implementation"),
      taskUpdate("plan_step_1", "Inspect code", "complete"),
      taskUpdate("plan_step_2", "Run tests", "pending"),
    ]);
    expect(revised).toEqual([
      planUpdate("Implementation"),
      taskUpdate("plan_step_1", "Inspect code", "complete"),
      taskUpdate("plan_step_2", "Fix parser bug", "in_progress"),
      taskUpdate("plan_step_3", "Run tests", "pending"),
    ]);
  });

  it("renders the plan checklist in rich draft blocks", () => {
    const blocks = buildSlackProgressDraftBlocks({
      title: "Implementation",
      lines: [],
      plan: [
        { step: "Inspect code", status: "completed" },
        { step: "Run tests", status: "in_progress" },
      ],
    });

    expect(JSON.stringify(blocks)).toContain("✅ Inspect code");
    expect(JSON.stringify(blocks)).toContain("▸ Run tests");
  });

  it("terminalizes orphaned rows when a plan snapshot shrinks", () => {
    const first = reconcileSlackNativeTaskChunks({
      previousTasks: new Map(),
      chunks: buildSlackProgressStreamUpdateChunks({
        title: "Implementation",
        lines: [],
        plan: [
          { step: "Inspect code", status: "completed" },
          { step: "Patch code", status: "in_progress" },
          { step: "Run tests", status: "pending" },
        ],
      }),
    });
    const shrunk = reconcileSlackNativeTaskChunks({
      previousTasks: first.tasks,
      chunks: buildSlackProgressStreamUpdateChunks({
        title: "Implementation",
        lines: [],
        plan: [{ step: "Inspect code", status: "in_progress" }],
      }),
    });

    expect(shrunk.chunks).toEqual([
      planUpdate("Implementation"),
      taskUpdate("plan_step_1", "Inspect code", "in_progress"),
      taskUpdate("plan_step_2", "Patch code", "complete"),
      taskUpdate("plan_step_3", "Run tests", "complete"),
    ]);
  });

  it("terminalizes tool-line tasks when the source switches to a typed plan", () => {
    const lineChunks = reconcileSlackNativeTaskChunks({
      previousTasks: new Map(),
      chunks: buildSlackProgressStreamStartChunks({
        lines: [itemLine("run tests", "Running tests")],
      }),
    });
    const planChunks = reconcileSlackNativeTaskChunks({
      previousTasks: lineChunks.tasks,
      chunks: buildSlackProgressStreamUpdateChunks({
        title: "Implementation",
        lines: [],
        plan: [{ step: "Inspect code", status: "in_progress" }],
      }),
    });

    const tasks = (planChunks.chunks ?? []).filter((chunk) => chunk.type === "task_update");
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ id: "plan_step_1", status: "in_progress" });
    expect(tasks[1]).toMatchObject({ status: "complete" });
  });

  it("keeps chunks untouched when no previous tasks are orphaned", () => {
    const chunks = buildSlackProgressStreamUpdateChunks({
      title: "Implementation",
      lines: [],
      plan: [{ step: "Inspect code", status: "in_progress" }],
    });
    const reconciled = reconcileSlackNativeTaskChunks({
      previousTasks: new Map([["plan_step_1", { title: "Inspect code", status: "in_progress" }]]),
      chunks,
    });

    expect(reconciled.chunks).toEqual(chunks);
  });

  it("starts native Slack progress with plan/task chunks instead of a static blocks plan", () => {
    expect(
      buildSlackProgressStreamStartChunks({
        lines: [itemLine("tool one", "Tool one"), itemLine("tool two", "Tool two")],
      }),
    ).toEqual([
      planUpdate("tool two"),
      taskUpdate("item_1", "tool one", "in_progress"),
      taskUpdate("item_2", "tool two", "in_progress"),
    ]);
  });

  it("uses configured max line chars for native task details", () => {
    expect(
      buildSlackProgressStreamStartChunks({
        title: "Shelling...",
        maxLineChars: 64,
        lines: [
          {
            kind: "tool",
            icon: "🛠️",
            label: "Exec",
            detail: "run tests in /Users/example/Projects/openclaw/packages/very/deep/path/example",
            text: "🛠️ Exec: run tests in /Users/example/Projects/openclaw/packages/very/deep/path/example",
          },
        ],
      }),
    ).toEqual([
      planUpdate("Shelling..."),
      taskUpdate(
        "tool_1",
        "Exec — run tests in /Users/example/P…aw/packages/very/deep/path/example",
        "in_progress",
      ),
    ]);
  });

  it("maps completed and failed progress statuses onto native task states", () => {
    expect(
      buildSlackProgressStreamStartChunks({
        title: "Shelling...",
        lines: [
          {
            kind: "command-output",
            label: "Exec",
            detail: "command finished",
            status: "completed",
            text: "🛠️ Exec: completed",
            toolName: "exec",
          },
          {
            kind: "command-output",
            label: "Exec",
            detail: "command failed",
            status: "exit 1",
            text: "🛠️ Exec: exit 1",
            toolName: "exec",
          },
        ],
      }),
    ).toEqual([
      planUpdate("Shelling..."),
      taskUpdate("exec_1", "Exec — command finished", "complete"),
      taskUpdate("exec_2", "Exec — command failed · exit 1", "error"),
    ]);
  });

  it("keeps newest native task chunks when capping progress lines", () => {
    const chunksWithTitle = buildSlackProgressStreamStartChunks({
      title: "Shelling...",
      lines: Array.from({ length: 60 }, (_value, index) => progressLine(index)),
    });
    expect(chunksWithTitle).toHaveLength(51);
    expect(chunksWithTitle?.[0]).toEqual(planUpdate("Shelling..."));
    expectTaskUpdate(chunksWithTitle?.[1], {
      id: "tool_1",
      title: "Exec 10 — run 10",
      status: "in_progress",
    });
    expectTaskUpdate(chunksWithTitle?.at(-1), {
      id: "tool_50",
      title: "Exec 59 — run 59",
      status: "in_progress",
    });

    const chunksWithoutTitle = buildSlackProgressStreamStartChunks({
      lines: Array.from({ length: 60 }, (_value, index) => progressLine(index)),
    });
    expect(chunksWithoutTitle).toHaveLength(51);
    expect(chunksWithoutTitle?.[0]).toEqual(planUpdate("Exec 59 — run 59"));
    expectTaskUpdate(chunksWithoutTitle?.[1], {
      id: "tool_1",
      title: "Exec 10 — run 10",
      status: "in_progress",
    });
    expectTaskUpdate(chunksWithoutTitle?.at(-1), {
      id: "tool_50",
      title: "Exec 59 — run 59",
      status: "in_progress",
    });
  });

  it("uses the newest meaningful progress step as the native plan title when no title is provided", () => {
    expect(
      buildSlackProgressStreamStartChunks({
        lines: [toolLine("run tests")],
      }),
    ).toEqual([
      planUpdate("Exec — run tests"),
      taskUpdate("exec_1", "Exec — run tests", "in_progress"),
    ]);
  });

  it("caps explicit native plan titles to Slack chunk limits", () => {
    const chunks = buildSlackProgressStreamStartChunks({
      title: `Shelling ${"x".repeat(300)}`,
      lines: [toolLine("run tests")],
    });
    const title =
      chunks?.[0] && typeof chunks[0] === "object" && "title" in chunks[0]
        ? chunks[0].title
        : undefined;

    expect(title).toHaveLength(256);
    expect(title?.endsWith("…")).toBe(true);
  });

  it("preserves visible text in native tasks without structured detail", () => {
    expect(
      buildSlackProgressStreamStartChunks({
        lines: [itemLine("prepare the workspace", "Preamble"), toolLine("run tests")],
      }),
    ).toEqual([
      planUpdate("Exec — run tests"),
      taskUpdate("item_1", "prepare the workspace", "in_progress"),
      taskUpdate("exec_2", "Exec — run tests", "in_progress"),
    ]);
  });

  it("renders identical command progress lines as distinct native tasks when ids differ", () => {
    expect(
      buildSlackProgressStreamStartChunks({
        title: "Shelling...",
        lines: [
          {
            id: "cmd-1",
            kind: "item",
            icon: "🛠️",
            label: "Exec",
            text: "🛠️ Exec",
            toolName: "exec",
          },
          {
            id: "cmd-2",
            kind: "item",
            icon: "🛠️",
            label: "Exec",
            text: "🛠️ Exec",
            toolName: "exec",
          },
        ],
      }),
    ).toEqual([
      planUpdate("Shelling..."),
      taskUpdate(expect.stringMatching(/^cmd_1_[a-f0-9]{8}$/u), "🛠️ Exec", "in_progress"),
      taskUpdate(expect.stringMatching(/^cmd_2_[a-f0-9]{8}$/u), "🛠️ Exec", "in_progress"),
    ]);
  });

  it("keeps id-derived native task ids stable when completion changes visible status text", () => {
    const running = buildSlackProgressStreamUpdateChunks({
      title: "Shelling...",
      lines: [
        {
          id: "call-2",
          kind: "tool",
          icon: "🛠️",
          label: "Bash",
          text: "🛠️ Bash",
          toolName: "bash",
        },
      ],
    });
    const completed = buildSlackProgressStreamUpdateChunks({
      title: "Shelling...",
      lines: [
        {
          id: "call-2",
          kind: "command-output",
          icon: "🛠️",
          label: "Bash",
          status: "completed",
          text: "🛠️ completed",
          toolName: "bash",
        },
      ],
    });

    const runningTaskId =
      running?.[1] && typeof running[1] === "object" && "id" in running[1]
        ? running[1].id
        : undefined;
    expect(running?.[1]).toMatchObject({ id: expect.stringMatching(/^call_2_[a-f0-9]{8}$/u) });
    expect(completed?.[1]).toMatchObject({
      id: runningTaskId,
      status: "complete",
      title: "Bash — completed",
    });
  });

  it("does not emit native stream chunks when there are no tasks", () => {
    expect(
      buildSlackProgressStreamStartChunks({
        title: "Shelling...",
        lines: [],
      }),
    ).toBeUndefined();
  });

  it("updates native Slack progress without creating duplicate plan blocks", () => {
    expect(
      buildSlackProgressStreamUpdateChunks({
        title: "Shelling",
        lines: [itemLine("tool one", "Tool one"), itemLine("tool two", "Tool two")],
      }),
    ).toEqual([
      planUpdate("Shelling"),
      taskUpdate("item_1", "tool one", "in_progress"),
      taskUpdate("item_2", "tool two", "in_progress"),
    ]);
  });

  it("marks unfinished native Slack progress tasks complete for finalization", () => {
    expect(
      buildSlackProgressStreamCompletionChunks({
        lines: [
          { kind: "item", label: "Tool one", text: "tool one" },
          {
            kind: "command-output",
            label: "Exec",
            detail: "command failed",
            status: "exit 1",
            text: "Exec: exit 1",
          },
        ],
      }),
    ).toEqual([
      planUpdate("Exec — command failed · exit 1"),
      taskUpdate("item_1", "tool one", "complete"),
      taskUpdate("command_output_2", "Exec — command failed · exit 1", "error"),
    ]);
  });
});
