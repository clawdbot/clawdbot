// Slack tests cover progress blocks plugin behavior.
import type { ChannelProgressDraftLine } from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it } from "vitest";
import {
  buildSlackProgressCardBlocks,
  buildSlackProgressStreamChunks,
  EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT,
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
  it("retains independent approvals and failures in the card attention section", () => {
    const blocks = buildSlackProgressCardBlocks({
      state: "working",
      title: "Working",
      lines: [
        { kind: "approval", label: "Approve deploy", status: "requested", text: "Approve deploy" },
        {
          kind: "approval",
          label: "Approve restart",
          status: "requested",
          text: "Approve restart",
        },
        { kind: "command-output", label: "Build", status: "exit 1", text: "Build exit 1" },
        { kind: "command-output", label: "Test", status: "exit 2", text: "Test exit 2" },
      ],
    });
    const text = JSON.stringify(blocks);
    for (const expected of [
      "Approve deploy",
      "Approve restart",
      "Build — exit 1",
      "Test — exit 2",
    ]) {
      expect(text).toContain(expected);
    }
  });

  it("preserves authored commentary and reasoning Markdown beside tool activity", () => {
    const blocks = buildSlackProgressCardBlocks({
      state: "working",
      title: "Checking the workspace",
      lines: [
        {
          id: "reasoning",
          kind: "item",
          label: "Reasoning",
          text: "Compare <#C123> approaches 🔍",
        },
        {
          id: "commentary:1",
          kind: "item",
          label: "Update",
          text: "Checking **the fix** <@U123> & <!channel> 🔧",
        },
        toolLine("run tests"),
      ],
    });
    expect(blocks[1]).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "• *Reasoning* — Compare &lt;#C123&gt; approaches 🔍\n• *Update* — Checking *the fix* &lt;@U123&gt; &amp; &lt;!channel&gt; 🔧\n🛠️ *Exec* — run tests",
      },
    });
  });

  it.each([
    ["Run `pnpm test`", "*Run `pnpm test`*"],
    ["Run **bold** checks", "*Run bold checks*"],
    ["Read C:\\path", "*Read C:\\path*"],
    [
      "Check `code` for <@U123> & <!channel>",
      "*Check `code` for &lt;@U123&gt; &amp; &lt;!channel&gt;*",
    ],
  ])("renders authored card title %s inside one bold wrapper", (title, expected) => {
    expect(buildSlackProgressCardBlocks({ state: "working", title, lines: [] })).toEqual([
      { type: "section", text: { type: "mrkdwn", text: `🔄 ${expected}` } },
    ]);
  });

  it("renders authored narration inside one italic wrapper while preserving inline code", () => {
    const blocks = buildSlackProgressCardBlocks({
      state: "working",
      title: "Working",
      narration: "Check _x_ and *x* with `pnpm test` for <@U123> & <!channel>",
      lines: [],
    });
    expect(blocks[1]).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_Check x and x with `pnpm test` for &lt;@U123&gt; &amp; &lt;!channel&gt;_",
      },
    });
  });

  it("renders authored plan Markdown without activating Slack mentions", () => {
    const blocks = buildSlackProgressCardBlocks({
      state: "working",
      title: "Working",
      plan: [
        { step: "Run `pnpm test` for **checks** <@U123> & <!channel>", status: "in_progress" },
      ],
      lines: [],
    });
    expect(blocks[1]).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "▸ Run `pnpm test` for *checks* &lt;@U123&gt; &amp; &lt;!channel&gt;",
      },
    });
  });

  it("escapes only entities in literal attention text", () => {
    const blocks = buildSlackProgressCardBlocks({
      state: "working",
      title: "Working",
      lines: [{ ...toolLine("`pnpm test` <@U123> & <!channel>"), status: "exit 1" }],
    });
    expect(blocks[1]).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Exec — `pnpm test` &lt;@U123&gt; &amp; &lt;!channel&gt; — exit 1",
      },
    });
  });

  it.each([7, 50])(
    "keeps approval attention visible beside %s recent activity rows",
    (activityCount) => {
      const blocks = buildSlackProgressCardBlocks({
        state: "working",
        title: "Working",
        maxLineChars: 300,
        lines: [
          {
            kind: "approval",
            label: "Approval",
            text: "Approval required",
            detail: "Run the command",
            status: "requested",
          },
          ...Array.from({ length: activityCount }, (_, index) => ({
            ...progressLine(index),
            detail: "x".repeat(300),
          })),
        ],
      });
      expect(JSON.stringify(blocks)).toContain("Run the command");
    },
  );

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
        text: {
          type: "mrkdwn",
          text: "🛠️ *Exec* — run tests\n• *Preamble* — prepare the workspace",
        },
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

  it.each(["success", "error"] as const)(
    "settles approval and failure text when a card ends as %s",
    (state) => {
      const lines: ChannelProgressDraftLine[] = [
        {
          kind: "approval",
          label: "Approval",
          detail: "Run the command",
          status: "requested",
          text: "Approval required",
        },
        {
          kind: "command-output",
          label: "Bash",
          detail: "run checks",
          status: "exit 1",
          text: "Bash: run checks · exit 1",
        },
      ];
      const working = JSON.stringify(
        buildSlackProgressCardBlocks({ state: "working", title: "Working", lines }),
      );
      expect(working).toContain("Run the command");
      expect(working).toContain("exit 1");
      const finished = JSON.stringify(
        buildSlackProgressCardBlocks({ state, title: "Working", lines }),
      );
      expect(finished).not.toContain("Run the command");
      expect(finished).not.toContain("requested");
      expect(finished.includes("Recovered:")).toBe(state === "success");
      expect(finished).toContain("exit 1");
    },
  );
});

describe("native Slack progress stream chunks", () => {
  it("preserves full native plan snapshots beyond the Block Kit block limit", () => {
    const chunks = buildSlackProgressStreamChunks({
      title: "Working",
      lines: [],
      plan: Array.from({ length: 51 }, (_, index) => ({
        step: `Step ${index}`,
        status: "pending" as const,
      })),
    });
    expect(chunks).toContainEqual(taskUpdate("plan_step_1", "Step 0", "pending"));
    expect(chunks).toContainEqual(taskUpdate("plan_step_51", "Step 50", "pending"));
  });

  it("updates a retained older native tool when it fails after fifty newer rows", () => {
    const older: ChannelProgressDraftLine = {
      id: "command:older",
      kind: "command-output",
      label: "Build",
      status: "running",
      text: "Build running",
    };
    const params = { title: "Working", lines: [older] };
    const first = reconcileSlackNativeTaskChunks({
      previous: EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT,
      chunks: buildSlackProgressStreamChunks(params),
    });
    const newer = Array.from({ length: 50 }, (_, index) => progressLine(index));
    const busy = reconcileSlackNativeTaskChunks({
      previous: first.snapshot,
      chunks: buildSlackProgressStreamChunks({ ...params, lines: [older, ...newer] }),
    });
    const failed = reconcileSlackNativeTaskChunks({
      previous: busy.snapshot,
      chunks: buildSlackProgressStreamChunks({
        ...params,
        lines: [{ ...older, status: "exit 1", text: "Build exit 1" }, ...newer],
      }),
    });
    const originalId = [...first.snapshot.tasks.keys()][0];
    expect(failed.chunks).toContainEqual(
      taskUpdate(originalId, "Build", "error", { output: "exit 1" }),
    );
  });

  it.each([
    { summaryRow: false, withPlan: false },
    { summaryRow: false, withPlan: true },
    { summaryRow: true, withPlan: false },
    { summaryRow: true, withPlan: true },
  ])(
    "preserves independent attention identities through reorder and resolution (quiet=$summaryRow, plan=$withPlan)",
    ({ summaryRow, withPlan }) => {
      const deploy: ChannelProgressDraftLine = {
        id: "approval:deploy",
        kind: "approval",
        label: "Approval",
        detail: "Deploy",
        status: "requested",
        text: "Approval required: Deploy",
      };
      const restart: ChannelProgressDraftLine = {
        ...deploy,
        id: "approval:restart",
        detail: "Restart",
        text: "Approval required: Restart",
      };
      const build: ChannelProgressDraftLine = {
        id: "command:build",
        kind: "command-output",
        label: "Build",
        detail: "run build",
        status: "exit 1",
        text: "Build: run build · exit 1",
      };
      const test: ChannelProgressDraftLine = {
        ...build,
        id: "command:test",
        label: "Test",
        detail: "run tests",
        status: "exit 2",
        text: "Test: run tests · exit 2",
      };
      const params = {
        title: "Working",
        summaryRow,
        plan: withPlan ? [{ step: "Verify", status: "in_progress" as const }] : undefined,
        lines: [deploy, build, restart, test],
      };
      const first = reconcileSlackNativeTaskChunks({
        previous: EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT,
        chunks: buildSlackProgressStreamChunks(params),
      });
      const attention = [...first.snapshot.tasks.values()].filter(
        (task) => task.status === "pending" || task.status === "error",
      );
      expect(attention).toHaveLength(4);
      expect(attention).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ title: "Approval required: Deploy", status: "pending" }),
          expect.objectContaining({ title: "Approval required: Restart", status: "pending" }),
          expect.objectContaining({ title: expect.stringContaining("Build"), status: "error" }),
          expect.objectContaining({ title: expect.stringContaining("Test"), status: "error" }),
        ]),
      );
      const reordered = reconcileSlackNativeTaskChunks({
        previous: first.snapshot,
        chunks: buildSlackProgressStreamChunks({ ...params, lines: params.lines.toReversed() }),
      });
      expect(reordered.chunks).toBeUndefined();
      const withoutPlan = reconcileSlackNativeTaskChunks({
        previous: reordered.snapshot,
        chunks: buildSlackProgressStreamChunks({ ...params, plan: undefined }),
      });
      for (const [id, row] of reordered.snapshot.tasks) {
        if (row.status === "error") {
          expect(withoutPlan.snapshot.tasks.get(id)?.status).toBe("error");
        }
      }
      const busy = reconcileSlackNativeTaskChunks({
        previous: withoutPlan.snapshot,
        chunks: buildSlackProgressStreamChunks({
          ...params,
          lines: [
            ...params.lines,
            ...Array.from({ length: 50 }, (_, index) => progressLine(index)),
          ],
        }),
      });
      expect(
        [...busy.snapshot.tasks.values()].filter((task) => task.status === "pending"),
      ).toHaveLength(2);
      const resolved = reconcileSlackNativeTaskChunks({
        previous: busy.snapshot,
        chunks: buildSlackProgressStreamChunks({ ...params, lines: [restart, test] }),
      });
      const resolvedRows = [...resolved.snapshot.tasks.values()];
      expect(resolvedRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ title: "Approval required: Deploy", status: "complete" }),
          expect.objectContaining({ title: "Approval required: Restart", status: "pending" }),
          expect.objectContaining({
            title: expect.stringContaining("Build"),
            status: summaryRow ? "complete" : "error",
          }),
          expect.objectContaining({ title: expect.stringContaining("Test"), status: "error" }),
        ]),
      );
      const finished = reconcileSlackNativeTaskChunks({
        previous: resolved.snapshot,
        finalStatus: "complete",
        chunks: buildSlackProgressStreamChunks({
          ...params,
          lines: [restart, test],
          finalInProgressStatus: "complete",
        }),
      });
      expect(
        [...finished.snapshot.tasks.values()].every((task) => task.status === "complete"),
      ).toBe(true);
    },
  );

  it("settles cleared native failure attention before the turn finishes", () => {
    const first = reconcileSlackNativeTaskChunks({
      previous: EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT,
      chunks: buildSlackProgressStreamChunks({
        title: "Working",
        summaryRow: true,
        lines: [{ kind: "command-output", label: "Bash", status: "exit 1", text: "Bash exit 1" }],
      }),
    });
    const recovered = reconcileSlackNativeTaskChunks({
      previous: first.snapshot,
      chunks: buildSlackProgressStreamChunks({ title: "Working", summaryRow: true, lines: [] }),
    });
    expect(recovered.chunks).toEqual([
      taskUpdate(
        expect.stringMatching(/^openclaw-attention-/u),
        "Recovered: Bash — exit 1",
        "complete",
      ),
    ]);
    expect(recovered.snapshot.tasks.get("openclaw_summary")?.status).toBe("in_progress");
  });

  it.each([false, true])(
    "keeps approval attention beside authored plan tasks (quiet=%s)",
    (summaryRow) => {
      const params = {
        title: "Checking the workspace",
        summaryRow,
        plan: [{ step: "Run checks", status: "in_progress" as const }],
        lines: [
          {
            kind: "approval" as const,
            label: "Approval",
            detail: "Run the command",
            status: "requested",
            text: "Approval required",
          },
        ],
      };
      const first = reconcileSlackNativeTaskChunks({
        previous: EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT,
        chunks: buildSlackProgressStreamChunks(params),
      });
      expect(first.chunks).toContainEqual(
        taskUpdate(
          expect.stringMatching(/^openclaw-attention-/u),
          "Approval required: Run the command",
          "pending",
        ),
      );
      const resolved = reconcileSlackNativeTaskChunks({
        previous: first.snapshot,
        chunks: buildSlackProgressStreamChunks({ ...params, lines: [] }),
      });
      expect(resolved.chunks).toEqual([
        taskUpdate(
          expect.stringMatching(/^openclaw-attention-/u),
          "Approval required: Run the command",
          "complete",
        ),
      ]);
      const completed = reconcileSlackNativeTaskChunks({
        previous: first.snapshot,
        chunks: buildSlackProgressStreamChunks({ ...params, finalInProgressStatus: "complete" }),
      });
      expect(completed.chunks).toContainEqual(
        taskUpdate(
          expect.stringMatching(/^openclaw-attention-/u),
          "Approval required: Run the command",
          "complete",
        ),
      );
      expect(
        [...completed.snapshot.tasks.values()].every((task) => task.status === "complete"),
      ).toBe(true);
    },
  );

  it.each([false, true])(
    "shows terminal failure after every authored milestone completed (quiet=%s)",
    (summaryRow) => {
      expect(
        buildSlackProgressStreamChunks({
          title: "Checking the workspace",
          summaryRow,
          lines: [],
          finalInProgressStatus: "error",
          plan: [{ step: "Run checks", status: "completed" }],
        }),
      ).toEqual([
        planUpdate("Checking the workspace"),
        taskUpdate("plan_step_1", "Run checks", "complete"),
        taskUpdate("openclaw_attention", "Failed", "error"),
      ]);
    },
  );

  it.each([
    [false, "complete"],
    [true, "complete"],
    [false, "error"],
    [true, "error"],
  ] as const)(
    "settles failure attention beside the quiet work row (plan=%s, final=%s)",
    (withPlan, finalInProgressStatus) => {
      const params = {
        title: "Checking the workspace",
        summaryRow: true,
        plan: withPlan ? [{ step: "Run checks", status: "in_progress" as const }] : undefined,
        lines: [
          {
            kind: "command-output" as const,
            label: "Bash",
            detail: "run checks",
            status: "exit 1",
            text: "Bash: run checks · exit 1",
          },
        ],
      };
      const first = reconcileSlackNativeTaskChunks({
        previous: EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT,
        chunks: buildSlackProgressStreamChunks(params),
      });
      expect(first.chunks).toEqual([
        planUpdate("Checking the workspace"),
        withPlan
          ? taskUpdate("plan_step_1", "Run checks", "in_progress")
          : taskUpdate("openclaw_summary", "Checking the workspace", "in_progress"),
        taskUpdate(
          expect.stringMatching(/^openclaw-attention-/u),
          "Bash — run checks — exit 1",
          "error",
        ),
      ]);
      const final = reconcileSlackNativeTaskChunks({
        previous: first.snapshot,
        chunks: buildSlackProgressStreamChunks({ ...params, finalInProgressStatus }),
      });
      const attentionTitle =
        finalInProgressStatus === "complete"
          ? "Recovered: Bash — run checks — exit 1"
          : "Bash — run checks — exit 1";
      expect([...final.snapshot.tasks.values()]).toContainEqual({
        title: attentionTitle,
        status: finalInProgressStatus,
      });
      expect(
        [...final.snapshot.tasks.values()].every((task) => task.status === finalInProgressStatus),
      ).toBe(true);
    },
  );

  it("keeps the opt-in tool log alongside typed plan steps", () => {
    const chunks = buildSlackProgressStreamChunks({
      title: "Implementation",
      summaryRow: false,
      lines: [toolLine("inspect workspace")],
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
      taskUpdate(contentTaskId("exec"), "Exec", "in_progress", { details: "inspect workspace" }),
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
      previous: EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT,
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
      previous: first.snapshot,
      chunks: buildSlackProgressStreamChunks({
        title: "Implementation",
        lines: [],
        plan: [{ step: "Inspect code", status: "in_progress" }],
      }),
    });

    expect(shrunk.chunks).toEqual([
      taskUpdate("plan_step_1", "Inspect code", "in_progress"),
      taskUpdate("plan_step_2", "Patch code", "complete"),
      taskUpdate("plan_step_3", "Run tests", "complete"),
    ]);
  });

  it("terminalizes tool-line tasks when the source switches to a typed plan", () => {
    const lineChunks = reconcileSlackNativeTaskChunks({
      previous: EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT,
      chunks: buildSlackProgressStreamChunks({
        lines: [itemLine("run tests", "Running tests")],
      }),
    });
    const planChunks = reconcileSlackNativeTaskChunks({
      previous: lineChunks.snapshot,
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
      previous: EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT,
      chunks: buildSlackProgressStreamChunks({
        lines: [itemLine("first task"), itemLine("shared task")],
      }),
    });
    const shifted = reconcileSlackNativeTaskChunks({
      previous: first.snapshot,
      chunks: buildSlackProgressStreamChunks({
        lines: [itemLine("shared task"), itemLine("new task")],
      }),
    });
    const firstShared = [...first.snapshot.tasks].find(([, task]) => task.title === "shared task");
    const shiftedShared = [...shifted.snapshot.tasks].find(
      ([, task]) => task.title === "shared task",
    );

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

  it("emits nothing when the snapshot matches what the stream already holds", () => {
    const build = () =>
      buildSlackProgressStreamChunks({
        title: "Implementation",
        lines: [],
        plan: [{ step: "Inspect code", status: "in_progress" }],
      });
    const first = reconcileSlackNativeTaskChunks({
      previous: EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT,
      chunks: build(),
    });
    const repeated = reconcileSlackNativeTaskChunks({ previous: first.snapshot, chunks: build() });

    expect(first.chunks).toEqual(build());
    expect(repeated.chunks).toBeUndefined();
    expect(repeated.snapshot).toEqual(first.snapshot);
  });

  it("streams task details and output as append-only deltas", () => {
    // Slack concatenates details/output per task_update for the same id, so a
    // resent field must carry only the unsent suffix.
    const line = (status: string): ChannelProgressDraftLine => ({
      id: "call-1",
      kind: "command-output",
      label: "Bash",
      detail: "pnpm test",
      status,
      text: `🛠️ Bash: pnpm test · ${status}`,
      toolName: "bash",
    });
    const first = reconcileSlackNativeTaskChunks({
      previous: EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT,
      chunks: buildSlackProgressStreamChunks({ title: "Shelling", lines: [line("running")] }),
    });
    const repeated = reconcileSlackNativeTaskChunks({
      previous: first.snapshot,
      chunks: buildSlackProgressStreamChunks({ title: "Shelling", lines: [line("running")] }),
    });
    const failed = reconcileSlackNativeTaskChunks({
      previous: repeated.snapshot,
      chunks: buildSlackProgressStreamChunks({ title: "Shelling", lines: [line("exit 1")] }),
    });
    const finished = reconcileSlackNativeTaskChunks({
      previous: failed.snapshot,
      chunks: buildSlackProgressStreamChunks({
        title: "Shelling",
        lines: [line("exit 1")],
        diffStat: { files: 2, added: 5, removed: 2 },
        finalInProgressStatus: "complete",
      }),
    });

    const taskId = expect.stringMatching(/^call_1_[a-f0-9]{8}$/u);
    expect(first.chunks).toEqual([
      planUpdate("Shelling"),
      taskUpdate(taskId, "Bash", "in_progress", { details: "pnpm test" }),
    ]);
    expect(repeated.chunks).toBeUndefined();
    expect(failed.chunks).toEqual([taskUpdate(taskId, "Bash", "error", { output: "exit 1" })]);
    expect(finished.chunks).toEqual([
      taskUpdate(taskId, "Recovered: Bash", "complete", { output: " · +5 −2" }),
    ]);
  });

  it("settles a recovered failure after its tool row leaves the rolling window", () => {
    const failed = reconcileSlackNativeTaskChunks({
      previous: EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT,
      chunks: [
        {
          type: "task_update",
          id: "failed-call",
          title: "Bash",
          status: "error",
          output: "exit 1",
        },
      ],
    });
    const shifted = reconcileSlackNativeTaskChunks({
      previous: failed.snapshot,
      chunks: [{ type: "task_update", id: "next-call", title: "Read", status: "in_progress" }],
    });
    const finished = reconcileSlackNativeTaskChunks({
      previous: shifted.snapshot,
      chunks: [{ type: "task_update", id: "next-call", title: "Read", status: "complete" }],
      finalStatus: "complete",
    });
    expect(finished.chunks).toEqual([
      taskUpdate("next-call", "Read", "complete"),
      taskUpdate("failed-call", "Recovered: Bash", "complete"),
    ]);
    expect([...finished.snapshot.tasks.values()].every((task) => task.status === "complete")).toBe(
      true,
    );
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
      taskUpdate(contentTaskId("exec"), "Exec", "complete", {
        details: "command finished",
      }),
      taskUpdate(contentTaskId("exec"), "Exec", "error", {
        details: "command failed",
        output: "exit 1",
      }),
    ]);
  });

  it("preserves the compositor's native task window with or without an authored title", () => {
    const chunksWithTitle = buildSlackProgressStreamChunks({
      title: "Shelling...",
      lines: Array.from({ length: 60 }, (_value, index) => progressLine(index)),
    });
    expect(chunksWithTitle).toHaveLength(61);
    expect(chunksWithTitle?.[0]).toEqual(planUpdate("Shelling..."));
    expectTaskUpdate(chunksWithTitle?.[1], {
      id: contentTaskId("tool"),
      title: "Exec 0",
      status: "in_progress",
      details: "run 0",
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
    expect(chunksWithoutTitle).toHaveLength(61);
    expect(chunksWithoutTitle?.[0]).toEqual(planUpdate("Exec 59 — run 59"));
    expectTaskUpdate(chunksWithoutTitle?.[1], {
      id: contentTaskId("tool"),
      title: "Exec 0",
      status: "in_progress",
      details: "run 0",
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
    expect(completed?.[1]).toEqual({
      type: "task_update",
      id: runningTaskId,
      status: "complete",
      title: "Bash",
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
      buildSlackProgressStreamChunks({
        finalInProgressStatus: "complete",
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
      planUpdate("Exec — command failed"),
      taskUpdate(contentTaskId("item"), "tool one", "complete"),
      taskUpdate(contentTaskId("command_output"), "Recovered: Exec", "complete", {
        details: "command failed",
        output: "exit 1",
      }),
    ]);
  });

  it("puts task detail, diff output, and the session source on the terminal row", () => {
    expect(
      buildSlackProgressStreamChunks({
        finalInProgressStatus: "complete",
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
