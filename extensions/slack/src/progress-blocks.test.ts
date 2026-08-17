// Slack tests cover progress blocks plugin behavior.
import { describe, expect, it } from "vitest";
import {
  buildSlackProgressCardBlocks,
  buildSlackProgressStreamCompletionChunks,
  buildSlackProgressStreamChunks,
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
  extra?: Record<string, unknown>,
) {
  return { type: "task_update", id, title, status, ...extra };
}

function contentTaskId(prefix: string) {
  return expect.stringMatching(new RegExp(`^${prefix}_[a-f0-9]{8}_1$`, "u"));
}

function expectTaskUpdate(
  task: unknown,
  fields: { id: unknown; title: string; status: string; details?: string },
) {
  expect(task).toEqual({
    type: "task_update",
    id: fields.id,
    title: fields.title,
    status: fields.status,
    ...(fields.details ? { details: fields.details } : {}),
  });
}

describe("buildSlackProgressCardBlocks", () => {
  it("renders the working card with narration, plan, one activity block, and live footer", () => {
    const blocks = buildSlackProgressCardBlocks({
      state: "working",
      title: "Implementing",
      narration: "Checking the workspace.",
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Patch", status: "in_progress" },
      ],
      lines: [toolLine("run tests"), itemLine("prepare the workspace", "Preamble")],
      toolCalls: 3,
      elapsedSeconds: 12,
      diffStat: { files: 4, added: 2, removed: 1 },
    });

    expect(blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "🔄 *Implementing*" } },
      {
        type: "section",
        text: { type: "mrkdwn", text: "_Checking the workspace._" },
      },
      { type: "section", text: { type: "mrkdwn", text: "✅ Inspect\n▸ Patch" } },
      {
        type: "section",
        text: { type: "mrkdwn", text: "🛠️ *Exec* — run tests\n• *Preamble* — —" },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "🛠️ 3 tools · 📝 4 files +2 −1 · ⏱ 12s" }],
      },
    ]);
  });

  it.each([
    { state: "success" as const, icon: "✅" },
    { state: "error" as const, icon: "❌" },
  ])(
    "renders $state terminal cards and gates the session action on public URL",
    ({ state, icon }) => {
      const blocks = buildSlackProgressCardBlocks({
        state,
        title: "Implementing",
        lines: [toolLine("run tests")],
        diffStat: { files: 2, added: 1, removed: 1 },
        sessionUrl: "https://team.openclaw.ai/openclaw/chat/main",
      });

      expect(blocks[0]).toEqual({
        type: "section",
        text: { type: "mrkdwn", text: `${icon} *Implementing*` },
      });
      // Finished cards keep the diff stat only: no tool-call/elapsed receipt.
      expect(blocks).toContainEqual({
        type: "context",
        elements: [{ type: "mrkdwn", text: "📝 2 files +1 −1" }],
      });
      expect(blocks.at(-1)).toEqual({
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "openclaw:session_link",
            text: { type: "plain_text", text: "Open in OpenClaw" },
            url: "https://team.openclaw.ai/openclaw/chat/main",
          },
        ],
      });

      expect(
        buildSlackProgressCardBlocks({ state, title: "Implementing", lines: [] }),
      ).toHaveLength(1);
    },
  );

  it("keeps the newest activity rows inside one section and the Slack block budget", () => {
    const blocks = buildSlackProgressCardBlocks({
      state: "working",
      title: "Working",
      lines: Array.from({ length: 60 }, (_value, index) => progressLine(index)),
      elapsedSeconds: 1,
    });
    const activity = blocks.find(
      (block) => block.type === "section" && JSON.stringify(block).includes("Exec 59"),
    );

    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(activity).toBeDefined();
    expect(JSON.stringify(activity)).toContain("🛠️ *Exec 59* — run 59");
    expect(JSON.stringify(activity)).not.toContain("Exec 0");
  });
});

describe("native Slack progress stream chunks", () => {
  it("uses typed plan steps instead of tool lines when a plan exists", () => {
    const chunks = buildSlackProgressStreamChunks({
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
    const initial = buildSlackProgressStreamChunks({
      title: "Implementation",
      lines: [],
      plan: [
        { step: "Inspect code", status: "completed" },
        { step: "Run tests", status: "pending" },
      ],
    });
    const revised = buildSlackProgressStreamChunks({
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

  it("terminalizes orphaned rows when a plan snapshot shrinks", () => {
    const first = reconcileSlackNativeTaskChunks({
      previousTasks: new Map(),
      chunks: buildSlackProgressStreamChunks({
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
      chunks: buildSlackProgressStreamChunks({
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
      chunks: buildSlackProgressStreamChunks({
        lines: [itemLine("run tests", "Running tests")],
      }),
    });
    const planChunks = reconcileSlackNativeTaskChunks({
      previousTasks: lineChunks.tasks,
      chunks: buildSlackProgressStreamChunks({
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

  it("keeps content-derived task ids stable when a rolling line window shifts", () => {
    const first = reconcileSlackNativeTaskChunks({
      previousTasks: new Map(),
      chunks: buildSlackProgressStreamChunks({
        lines: [itemLine("first task"), itemLine("shared task")],
      }),
    });
    const shifted = reconcileSlackNativeTaskChunks({
      previousTasks: first.tasks,
      chunks: buildSlackProgressStreamChunks({
        lines: [itemLine("shared task"), itemLine("new task")],
      }),
    });
    const firstShared = [...first.tasks].find(([, task]) => task.title === "shared task");
    const shiftedShared = [...shifted.tasks].find(([, task]) => task.title === "shared task");

    expect(firstShared?.[0]).toBeDefined();
    expect(shiftedShared?.[0]).toBe(firstShared?.[0]);
    expect(shifted.chunks).toContainEqual(
      taskUpdate(contentTaskId("item"), "first task", "complete"),
    );
  });

  it("keeps a singleton content-derived task id when an identical line joins", () => {
    const singletonChunks = buildSlackProgressStreamChunks({
      lines: [itemLine("same task")],
    });
    const duplicateChunks = buildSlackProgressStreamChunks({
      lines: [itemLine("same task"), itemLine("same task")],
    });
    const singletonTasks = (singletonChunks ?? []).filter((chunk) => chunk.type === "task_update");
    const duplicateTasks = (duplicateChunks ?? []).filter((chunk) => chunk.type === "task_update");

    expect(singletonTasks).toHaveLength(1);
    expect(singletonTasks[0]).toEqual(
      taskUpdate(expect.stringMatching(/^item_[a-f0-9]{8}_1$/u), "same task", "in_progress"),
    );
    expect(duplicateTasks).toHaveLength(2);
    expect(duplicateTasks[0]?.id).toBe(singletonTasks[0]?.id);
    expect(duplicateTasks[1]).toEqual(
      taskUpdate(expect.stringMatching(/^item_[a-f0-9]{8}_2$/u), "same task", "in_progress"),
    );
  });

  it("suffixes duplicate content-derived task ids within one snapshot", () => {
    const chunks = buildSlackProgressStreamChunks({
      lines: [itemLine("same task"), itemLine("same task")],
    });
    const tasks = (chunks ?? []).filter((chunk) => chunk.type === "task_update");

    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toEqual(
      taskUpdate(expect.stringMatching(/^item_[a-f0-9]{8}_1$/u), "same task", "in_progress"),
    );
    expect(tasks[1]).toEqual(
      taskUpdate(expect.stringMatching(/^item_[a-f0-9]{8}_2$/u), "same task", "in_progress"),
    );
  });

  it("keeps chunks untouched when no previous tasks are orphaned", () => {
    const chunks = buildSlackProgressStreamChunks({
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
      buildSlackProgressStreamChunks({
        lines: [itemLine("tool one", "Tool one"), itemLine("tool two", "Tool two")],
      }),
    ).toEqual([
      planUpdate("tool two"),
      taskUpdate(contentTaskId("item"), "tool one", "in_progress"),
      taskUpdate(contentTaskId("item"), "tool two", "in_progress"),
    ]);
  });

  it("uses configured max line chars for native task details", () => {
    expect(
      buildSlackProgressStreamChunks({
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
      taskUpdate(contentTaskId("tool"), "Exec", "in_progress", {
        details: "run tests in /Users/example/P…aw/packages/very/deep/path/example",
      }),
    ]);
  });

  it("separates inline file deltas from native task details", () => {
    expect(
      buildSlackProgressStreamChunks({
        lines: [toolLine("src/native-card.ts +4 -2", "Write")],
      }),
    ).toEqual([
      planUpdate("Write — src/native-card.ts"),
      taskUpdate(contentTaskId("write"), "Write", "in_progress", {
        details: "src/native-card.ts",
        output: "+4 −2",
      }),
    ]);
  });

  it("maps completed and failed progress statuses onto native task states", () => {
    expect(
      buildSlackProgressStreamChunks({
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
      taskUpdate(contentTaskId("exec"), "exec", "complete", {
        details: "command finished",
      }),
      taskUpdate(contentTaskId("exec"), "exec", "error", {
        details: "command failed · exit 1",
      }),
    ]);
  });

  it("keeps newest native task chunks when capping progress lines", () => {
    const chunksWithTitle = buildSlackProgressStreamChunks({
      title: "Shelling...",
      lines: Array.from({ length: 60 }, (_value, index) => progressLine(index)),
    });
    expect(chunksWithTitle).toHaveLength(51);
    expect(chunksWithTitle?.[0]).toEqual(planUpdate("Shelling..."));
    expectTaskUpdate(chunksWithTitle?.[1], {
      id: contentTaskId("tool"),
      title: "Exec 10",
      status: "in_progress",
      details: "run 10",
    });
    expectTaskUpdate(chunksWithTitle?.at(-1), {
      id: contentTaskId("tool"),
      title: "Exec 59",
      status: "in_progress",
      details: "run 59",
    });

    const chunksWithoutTitle = buildSlackProgressStreamChunks({
      lines: Array.from({ length: 60 }, (_value, index) => progressLine(index)),
    });
    expect(chunksWithoutTitle).toHaveLength(51);
    expect(chunksWithoutTitle?.[0]).toEqual(planUpdate("Exec 59 — run 59"));
    expectTaskUpdate(chunksWithoutTitle?.[1], {
      id: contentTaskId("tool"),
      title: "Exec 10",
      status: "in_progress",
      details: "run 10",
    });
    expectTaskUpdate(chunksWithoutTitle?.at(-1), {
      id: contentTaskId("tool"),
      title: "Exec 59",
      status: "in_progress",
      details: "run 59",
    });
  });

  it("uses the newest meaningful progress step as the native plan title when no title is provided", () => {
    expect(
      buildSlackProgressStreamChunks({
        lines: [toolLine("run tests")],
      }),
    ).toEqual([
      planUpdate("Exec — run tests"),
      taskUpdate(contentTaskId("exec"), "Exec", "in_progress", { details: "run tests" }),
    ]);
  });

  it("keeps a native status headline when no task rows are visible", () => {
    expect(
      buildSlackProgressStreamChunks({
        title: "Checking the workspace",
        lines: [],
      }),
    ).toEqual([planUpdate("Checking the workspace")]);
  });

  it("caps explicit native plan titles to Slack chunk limits", () => {
    const chunks = buildSlackProgressStreamChunks({
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
      buildSlackProgressStreamChunks({
        lines: [itemLine("prepare the workspace", "Preamble"), toolLine("run tests")],
      }),
    ).toEqual([
      planUpdate("Exec — run tests"),
      taskUpdate(contentTaskId("item"), "prepare the workspace", "in_progress"),
      taskUpdate(contentTaskId("exec"), "Exec", "in_progress", { details: "run tests" }),
    ]);
  });

  it("renders identical command progress lines as distinct native tasks when ids differ", () => {
    expect(
      buildSlackProgressStreamChunks({
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
    const running = buildSlackProgressStreamChunks({
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
    const completed = buildSlackProgressStreamChunks({
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
      title: "bash",
      details: "completed",
    });
  });

  it("does not emit native stream chunks when there are no tasks or title", () => {
    expect(
      buildSlackProgressStreamChunks({
        lines: [],
      }),
    ).toBeUndefined();
  });

  it("updates native Slack progress without creating duplicate plan blocks", () => {
    expect(
      buildSlackProgressStreamChunks({
        title: "Shelling",
        lines: [itemLine("tool one", "Tool one"), itemLine("tool two", "Tool two")],
      }),
    ).toEqual([
      planUpdate("Shelling"),
      taskUpdate(contentTaskId("item"), "tool one", "in_progress"),
      taskUpdate(contentTaskId("item"), "tool two", "in_progress"),
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
      taskUpdate(contentTaskId("item"), "tool one", "complete"),
      taskUpdate(contentTaskId("command_output"), "Exec", "error", {
        details: "command failed · exit 1",
      }),
    ]);
  });

  it("puts task detail, diff output, and the session source on the terminal row", () => {
    expect(
      buildSlackProgressStreamCompletionChunks({
        lines: [toolLine("src/native-card.ts", "Write")],
        diffStat: { files: 1, added: 3, removed: 1 },
        sessionUrl: "https://team.openclaw.ai/openclaw/chat/main",
      }),
    ).toEqual([
      planUpdate("Write — src/native-card.ts"),
      taskUpdate(contentTaskId("write"), "Write", "complete", {
        details: "src/native-card.ts",
        output: "+3 −1",
        sources: [
          {
            type: "url_source",
            url: "https://team.openclaw.ai/openclaw/chat/main",
            text: "Open in OpenClaw",
          },
        ],
      }),
    ]);
  });
});
