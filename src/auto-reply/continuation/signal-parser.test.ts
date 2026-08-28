import { describe, expect, it } from "vitest";
import { CONTINUE_WORK_TOKEN, parseContinuationSignal, stripContinuationSignal } from "./signal.js";

const VALID_TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("parseContinuationSignal", () => {
  it("returns null for empty text", () => {
    expect(parseContinuationSignal(undefined)).toBeNull();
    expect(parseContinuationSignal("")).toBeNull();
  });

  it("parses bare CONTINUE_WORK", () => {
    const signal = parseContinuationSignal("Some reply text\nCONTINUE_WORK");
    expect(signal).toEqual({ kind: "work", delayMs: undefined });
  });

  it("parses CONTINUE_WORK with delay", () => {
    const signal = parseContinuationSignal("Reply\nCONTINUE_WORK:30");
    expect(signal).toEqual({ kind: "work", delayMs: 30_000 });
  });

  it("parses CONTINUE_WORK:0 as zero delay", () => {
    const signal = parseContinuationSignal("CONTINUE_WORK:0");
    expect(signal).toEqual({ kind: "work", delayMs: 0 });
  });

  it("parses bracket CONTINUE_WORK", () => {
    const signal = parseContinuationSignal("Some reply text\n[[CONTINUE_WORK]]");
    expect(signal).toEqual({ kind: "work", delayMs: undefined });
  });

  it("parses bracket CONTINUE_WORK with delay", () => {
    const signal = parseContinuationSignal("Reply\n[[CONTINUE_WORK:30]]");
    expect(signal).toEqual({ kind: "work", delayMs: 30_000 });
  });

  it("parses bracket CONTINUE_WORK:0 as zero delay", () => {
    const signal = parseContinuationSignal("[[CONTINUE_WORK:0]]");
    expect(signal).toEqual({ kind: "work", delayMs: 0 });
  });

  it("parses simple delegate bracket", () => {
    const signal = parseContinuationSignal(
      "Here is my reply.\n\n[[CONTINUE_DELEGATE: check CI status]]",
    );
    expect(signal).toEqual({
      kind: "delegate",
      task: "check CI status",
      delayMs: undefined,
      silent: undefined,
      silentWake: undefined,
    });
  });

  it("parses delegate with delay", () => {
    const signal = parseContinuationSignal("Reply\n[[CONTINUE_DELEGATE: run tests +60s]]");
    expect(signal).toEqual({
      kind: "delegate",
      task: "run tests",
      delayMs: 60_000,
      silent: undefined,
      silentWake: undefined,
    });
  });

  it("parses delegate with silent mode", () => {
    const signal = parseContinuationSignal("[[CONTINUE_DELEGATE: background enrichment | silent]]");
    expect(signal).toEqual({
      kind: "delegate",
      task: "background enrichment",
      delayMs: undefined,
      silent: true,
      silentWake: undefined,
    });
  });

  it("parses delegate with silent-wake mode", () => {
    const signal = parseContinuationSignal(
      "[[CONTINUE_DELEGATE: check repo history | silent-wake]]",
    );
    expect(signal).toEqual({
      kind: "delegate",
      task: "check repo history",
      delayMs: undefined,
      silent: undefined,
      silentWake: true,
    });
  });

  it("parses delegate with post-compaction mode", () => {
    const signal = parseContinuationSignal("[[CONTINUE_DELEGATE: task | post-compaction]]");
    expect(signal).toEqual({
      kind: "delegate",
      task: "task",
      delayMs: undefined,
      silent: undefined,
      silentWake: undefined,
      postCompaction: true,
    });
  });

  it("accepts post-compaction directive spelling variants", () => {
    const variants = ["post-compaction", "postcompaction", "post compaction"] as const;
    for (const variant of variants) {
      const signal = parseContinuationSignal(`[[CONTINUE_DELEGATE: task | ${variant}]]`);
      expect(signal).toMatchObject({
        kind: "delegate",
        task: "task",
        postCompaction: true,
      });
    }
  });

  it("post-compaction directive clears prior silent/silent-wake state", () => {
    // Directives are parsed right-to-left in parseDelegateBodyDirectives,
    // so post-compaction at the END of the directive chain wins by being
    // applied last and explicitly clearing silent/silentWake.
    expect(
      parseContinuationSignal("[[CONTINUE_DELEGATE: task | post-compaction | silent]]"),
    ).toEqual({
      kind: "delegate",
      task: "task",
      delayMs: undefined,
      silent: undefined,
      silentWake: undefined,
      postCompaction: true,
    });
    expect(
      parseContinuationSignal("[[CONTINUE_DELEGATE: task | post-compaction | silent-wake]]"),
    ).toEqual({
      kind: "delegate",
      task: "task",
      delayMs: undefined,
      silent: undefined,
      silentWake: undefined,
      postCompaction: true,
    });
  });

  it("token-form delegate mode parity covers normal / silent / silent-wake / post-compaction", () => {
    // Parity check: every continue_delegate mode the tool form accepts
    // (see DELEGATE_MODES in agents/tools/continue-delegate-tool.ts) must
    // round-trip through the token form. If the tool grows a new mode and
    // the token form does not, this assertion fails.
    expect(parseContinuationSignal("[[CONTINUE_DELEGATE: task | normal]]")).toEqual({
      kind: "delegate",
      task: "task",
      delayMs: undefined,
      silent: undefined,
      silentWake: undefined,
    });
    expect(parseContinuationSignal("[[CONTINUE_DELEGATE: task | silent]]")).toEqual({
      kind: "delegate",
      task: "task",
      delayMs: undefined,
      silent: true,
      silentWake: undefined,
    });
    expect(parseContinuationSignal("[[CONTINUE_DELEGATE: task | silent-wake]]")).toEqual({
      kind: "delegate",
      task: "task",
      delayMs: undefined,
      silent: undefined,
      silentWake: true,
    });
    expect(parseContinuationSignal("[[CONTINUE_DELEGATE: task | post-compaction]]")).toEqual({
      kind: "delegate",
      task: "task",
      delayMs: undefined,
      silent: undefined,
      silentWake: undefined,
      postCompaction: true,
    });
  });

  it("parses delegate with delay + silent-wake", () => {
    const signal = parseContinuationSignal(
      "Reply text\n[[CONTINUE_DELEGATE: delayed task +10s | silent-wake]]",
    );
    expect(signal).toEqual({
      kind: "delegate",
      task: "delayed task",
      delayMs: 10_000,
      silent: undefined,
      silentWake: true,
    });
  });

  it("parses delegate target syntax", () => {
    const signal = parseContinuationSignal(
      "[[CONTINUE_DELEGATE: summarize sibling work | target=agent:main:root]]",
    );
    expect(signal).toEqual({
      kind: "delegate",
      task: "summarize sibling work",
      delayMs: undefined,
      silent: undefined,
      silentWake: undefined,
      targetSessionKey: "agent:main:root",
    });
  });

  it("parses delegate targets syntax", () => {
    const signal = parseContinuationSignal(
      "[[CONTINUE_DELEGATE: return to root and sibling | silent-wake | targets=agent:main:root, agent:main:sibling]]",
    );
    expect(signal).toEqual({
      kind: "delegate",
      task: "return to root and sibling",
      delayMs: undefined,
      silent: undefined,
      silentWake: true,
      targetSessionKeys: ["agent:main:root", "agent:main:sibling"],
    });
  });

  it("parses delegate fanout syntax", () => {
    expect(parseContinuationSignal("[[CONTINUE_DELEGATE: return up chain | fanout=tree]]")).toEqual(
      {
        kind: "delegate",
        task: "return up chain",
        delayMs: undefined,
        silent: undefined,
        silentWake: undefined,
        fanoutMode: "tree",
      },
    );
    expect(parseContinuationSignal("[[CONTINUE_DELEGATE: return to host | fanout=all]]")).toEqual({
      kind: "delegate",
      task: "return to host",
      delayMs: undefined,
      silent: undefined,
      silentWake: undefined,
      fanoutMode: "all",
    });
  });

  it("parses delegate model override", () => {
    const signal = parseContinuationSignal(
      "[[CONTINUE_DELEGATE: route to a cheaper model | model=github-copilot/gpt-5.4-nano]]",
    );
    expect(signal).toEqual({
      kind: "delegate",
      task: "route to a cheaper model",
      delayMs: undefined,
      silent: undefined,
      silentWake: undefined,
      model: "github-copilot/gpt-5.4-nano",
    });
  });

  it("composes delegate model override with a silent-wake return modifier", () => {
    const signal = parseContinuationSignal(
      "[[CONTINUE_DELEGATE: enrich silently | silent-wake | model=github-copilot/gpt-5.4-nano]]",
    );
    expect(signal).toEqual({
      kind: "delegate",
      task: "enrich silently",
      delayMs: undefined,
      silent: undefined,
      silentWake: true,
      model: "github-copilot/gpt-5.4-nano",
    });
  });

  it("composes delegate model override with fanout", () => {
    const signal = parseContinuationSignal(
      "[[CONTINUE_DELEGATE: fan out cheaply | model=sonnet | fanout=tree]]",
    );
    expect(signal).toEqual({
      kind: "delegate",
      task: "fan out cheaply",
      delayMs: undefined,
      silent: undefined,
      silentWake: undefined,
      fanoutMode: "tree",
      model: "sonnet",
    });
  });

  it("keeps attachment= text in the token task instead of treating it as typed input", () => {
    const signal = parseContinuationSignal(
      "[[CONTINUE_DELEGATE: inspect workspace file handoff.md | attachment=inline-blob]]",
    );

    expect(signal).toEqual({
      kind: "delegate",
      task: "inspect workspace file handoff.md | attachment=inline-blob",
      delayMs: undefined,
      silent: undefined,
      silentWake: undefined,
    });
    expect(signal).not.toHaveProperty("attachments");
    expect(signal).not.toHaveProperty("attachAs");
  });

  it("omits model when the delegate token carries no model modifier", () => {
    const signal = parseContinuationSignal("[[CONTINUE_DELEGATE: inherit parent model]]");
    expect(signal).toEqual({
      kind: "delegate",
      task: "inherit parent model",
      delayMs: undefined,
      silent: undefined,
      silentWake: undefined,
    });
    expect(signal?.kind === "delegate" ? signal.model : "unset").toBeUndefined();
  });

  it("rejects a delegate token with an empty model value", () => {
    expect(parseContinuationSignal("[[CONTINUE_DELEGATE: bad model | model=]]")).toBeNull();
  });

  it('treats delegate token model="default" as inherit (no override)', () => {
    const signal = parseContinuationSignal(
      "[[CONTINUE_DELEGATE: inherit via sentinel | model=default]]",
    );
    expect(signal).toEqual({
      kind: "delegate",
      task: "inherit via sentinel",
      delayMs: undefined,
      silent: undefined,
      silentWake: undefined,
    });
    expect(signal?.kind === "delegate" ? signal.model : "unset").toBeUndefined();
  });

  it("rejects conflicting delegate target and fanout syntax", () => {
    expect(
      parseContinuationSignal(
        "[[CONTINUE_DELEGATE: ambiguous targeting | target=agent:main:root | fanout=tree]]",
      ),
    ).toBeNull();
  });

  it("consumes but ignores model-supplied traceparent directive options", () => {
    const signal = parseContinuationSignal(
      `[[CONTINUE_DELEGATE: traced handoff | silent-wake | target=agent:main:root | traceparent=${VALID_TRACEPARENT}]]`,
    );

    expect(signal).toEqual({
      kind: "delegate",
      task: "traced handoff",
      delayMs: undefined,
      silent: undefined,
      silentWake: true,
      targetSessionKey: "agent:main:root",
    });
  });

  it.each(["", "not-a-traceparent"])(
    "consumes an untrusted traceparent value %j without rejecting the delegate",
    (traceparent) => {
      expect(
        parseContinuationSignal(
          `[[CONTINUE_DELEGATE: untrusted trace | silent | traceparent=${traceparent}]]`,
        ),
      ).toEqual({
        kind: "delegate",
        task: "untrusted trace",
        delayMs: undefined,
        silent: true,
        silentWake: undefined,
      });
    },
  );

  it("does not match CONTINUE_WORK mid-text", () => {
    expect(parseContinuationSignal("I used CONTINUE_WORK earlier. Done now.")).toBeNull();
  });

  it("does not match partial bracket syntax", () => {
    expect(parseContinuationSignal("[[CONTINUE_DELEGATE: incomplete")).toBeNull();
  });

  it("truncates overly long task strings", () => {
    const longTask = "x".repeat(5000);
    const signal = parseContinuationSignal(`[[CONTINUE_DELEGATE: ${longTask}]]`);
    expect(signal?.kind).toBe("delegate");
    if (signal?.kind === "delegate") {
      expect(signal.task.length).toBe(4096);
    }
  });

  it("matches the LAST bracket when multiple appear", () => {
    const text =
      "Earlier I mentioned [[CONTINUE_DELEGATE: old task]]\n\n" +
      "Now the real one:\n[[CONTINUE_DELEGATE: actual task]]";
    const signal = parseContinuationSignal(text);
    expect(signal?.kind).toBe("delegate");
    if (signal?.kind === "delegate") {
      expect(signal.task).toBe("actual task");
    }
  });
});

describe("stripContinuationSignal", () => {
  it("returns original text when no signal present", () => {
    const result = stripContinuationSignal("Normal reply text.");
    expect(result).toEqual({ text: "Normal reply text.", signal: null });
  });

  it("strips CONTINUE_WORK from end", () => {
    const result = stripContinuationSignal("My reply\nCONTINUE_WORK");
    expect(result.signal).toEqual({ kind: "work", delayMs: undefined });
    expect(result.text).toBe("My reply");
  });

  it("strips CONTINUE_WORK:N from end", () => {
    const result = stripContinuationSignal("Reply\nCONTINUE_WORK:15");
    expect(result.signal?.kind).toBe("work");
    expect(result.text).toBe("Reply");
  });

  it("strips bracket CONTINUE_WORK from end", () => {
    const result = stripContinuationSignal("My reply\n[[CONTINUE_WORK]]");
    expect(result.signal).toEqual({ kind: "work", delayMs: undefined });
    expect(result.text).toBe("My reply");
  });

  it("strips bracket CONTINUE_WORK:N from end without leaking delimiters", () => {
    const result = stripContinuationSignal("Reply\n[[CONTINUE_WORK:15]]");
    expect(result.signal).toEqual({ kind: "work", delayMs: 15_000 });
    expect(result.text).toBe("Reply");
  });

  it("strips delegate bracket from end", () => {
    const result = stripContinuationSignal(
      "Here is the summary.\n\n[[CONTINUE_DELEGATE: verify tests]]",
    );
    expect(result.signal?.kind).toBe("delegate");
    expect(result.text).toBe("Here is the summary.");
  });

  it("preserves text before stripped signal", () => {
    const result = stripContinuationSignal(
      "Line 1\nLine 2\n\n[[CONTINUE_DELEGATE: task +5s | silent-wake]]",
    );
    expect(result.text).toBe("Line 1\nLine 2");
    expect(result.signal).toEqual({
      kind: "delegate",
      task: "task",
      delayMs: 5_000,
      silent: undefined,
      silentWake: true,
    });
  });
});

describe("continuation token constant", () => {
  it("exports the parser token from the continuation owner", () => {
    expect(CONTINUE_WORK_TOKEN).toBe("CONTINUE_WORK");
  });
});
