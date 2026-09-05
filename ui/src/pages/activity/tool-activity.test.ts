// @vitest-environment node
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseActivityEvent, updateToolActivity, type ActivityEntry } from "./tool-activity.ts";

function buildResultPreview(result: unknown): string {
  const entries: ActivityEntry[] = updateToolActivity([], {
    stream: "tool",
    runId: "run-1",
    ts: 1,
    receivedAt: 1,
    data: {
      toolCallId: "tool-1",
      name: "bash",
      phase: "result",
      result,
    },
  });

  const entry = entries[0];
  if (!entry?.outputPreview) {
    throw new Error("Expected activity output preview");
  }
  return entry.outputPreview;
}

describe("activity model output preview redaction", () => {
  it.each([
    ["short UTF-16 text", "\ud800 visible 🦞 text", "\ud800 visible 🦞 text"],
    ["a surrogate pair at the cap", "a".repeat(1_999) + "🦞tail", "a".repeat(1_999)],
    ["a lone surrogate inside the cap", "\ud800" + "a".repeat(2_100), "\ud800" + "a".repeat(1_999)],
  ])("preserves %s", (_label, source, expected) => {
    expect(buildResultPreview({ text: source })).toBe(expected);
  });

  it("redacts dotted API key assignments emitted by tool output", () => {
    const preview = buildResultPreview({
      text: [
        "app.api.key=visible-leaked-value-1234567890",
        "spring.datasource.password=visible-db-password-1234567890",
        "server.port=8080",
      ].join("\n"),
    });

    expect(preview).toContain("app.api.key=[redacted]");
    expect(preview).toContain("spring.datasource.password=[redacted]");
    expect(preview).toContain("server.port=8080");
    expect(preview).not.toContain("visible-leaked-value-1234567890");
    expect(preview).not.toContain("visible-db-password-1234567890");
  });

  it("redacts dotted API keys in object-shaped tool results", () => {
    const preview = buildResultPreview({
      "app.api.key": 'visible secret with spaces, apostrophe: don\'t, quote: "keep hidden"',
      "server.port": 8080,
    });

    expect(preview).toContain('"app.api.key": "[redacted]"');
    expect(preview).toContain('"server.port": 8080');
    expect(preview).not.toContain("visible secret");
    expect(preview).not.toContain("keep hidden");
  });
});

describe("activity preview retention", () => {
  it.each(["tool", "answer_candidate"])(
    "releases large %s payloads while retaining their previews",
    (kind) => {
      const result = spawnSync(
        process.execPath,
        [
          "--expose-gc",
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          `
            import { setImmediate as yieldTurn } from "node:timers/promises";
            import { updateToolActivity } from ${JSON.stringify(new URL("./tool-activity.ts", import.meta.url).href)};
            let entries = [];
            async function heapUsed() {
              await yieldTurn();
              globalThis.gc();
              await yieldTurn();
              globalThis.gc();
              return process.memoryUsage().heapUsed;
            }
            function append(index, size) {
              const text = JSON.parse(JSON.stringify("Synthetic " + index + ": " + "x".repeat(size)));
              entries = updateToolActivity(entries, {
                stream: ${JSON.stringify(kind === "tool" ? "tool" : "item")},
                runId: "run-" + index, ts: index, receivedAt: index,
                data: ${JSON.stringify(kind)} === "tool"
                  ? { toolCallId: "tool-" + index, name: "read", phase: "result", result: { text } }
                  : { kind: "answer_candidate", itemId: "answer-" + index, status: "selected", progressText: text },
              });
            }
            append(0, 5_000);
            entries = [];
            const before = await heapUsed();
            for (let index = 0; index < 64; index++) append(index, 512 * 1024);
            const retainedBytes = (await heapUsed()) - before;
            // Serialize only after measuring: consuming a slice can flatten it.
            process.stdout.write(JSON.stringify({ retainedBytes, previews: entries.map((entry) => ({ text: entry.outputPreview, truncated: entry.outputTruncated })) }));
          `,
        ],
        { cwd: process.cwd(), encoding: "utf8", timeout: 20_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout) as {
        retainedBytes: number;
        previews: { text: string; truncated: boolean }[];
      };
      expect(output.previews).toEqual(
        Array.from({ length: 64 }, (_, index) => ({
          text: (`Synthetic ${index}: ` + "x".repeat(2_000)).slice(0, 2_000),
          truncated: true,
        })),
      );
      // The discarded source bodies total 32 MiB; previews need only 128 KiB.
      expect(output.retainedBytes).toBeLessThan(8 * 1024 * 1024);
    },
    30_000,
  );
});

describe("answer candidate activity", () => {
  it("updates one ephemeral entry from candidate through authoritative selection", () => {
    const candidate = parseActivityEvent(
      {
        stream: "item",
        runId: "run-1",
        ts: 10,
        data: {
          kind: "answer_candidate",
          itemId: "answer-1",
          status: "candidate",
          progressText: "First draft",
        },
      },
      10,
    );
    if (!candidate) {
      throw new Error("Expected answer candidate event");
    }
    const selected = parseActivityEvent(
      {
        stream: "item",
        runId: "run-1",
        ts: 10,
        data: {
          kind: "answer_candidate",
          itemId: "answer-1",
          status: "selected",
          progressText: "Final answer",
        },
      },
      20,
    );
    if (!selected) {
      throw new Error("Expected selected answer event");
    }

    const entries = updateToolActivity(updateToolActivity([], candidate), selected);

    expect(entries).toEqual([
      expect.objectContaining({
        id: "run-1:answer_candidate:answer-1",
        entryKind: "answer_candidate",
        itemId: "answer-1",
        candidateStatus: "selected",
        status: "done",
        outputPreview: "Final answer",
      }),
    ]);
  });

  it("ignores unrelated item events", () => {
    expect(
      parseActivityEvent({
        stream: "item",
        runId: "run-1",
        data: { kind: "preamble", itemId: "note-1" },
      }),
    ).toBeNull();
  });
});
