/** Tests parsing of inline reply directives and command tags. */
import { describe, expect, it } from "vitest";
import { parseInlineDirectives } from "./reply/directive-handling.parse.js";
import {
  extractElevatedDirective,
  extractReasoningDirective,
  extractTraceDirective,
  extractThinkDirective,
  extractVerboseDirective,
} from "./reply/directives.js";
import { extractFastDirective, extractStatusDirective } from "./reply/directives.js";
import { extractExecDirective } from "./reply/exec/directive.js";
import { extractQueueDirective } from "./reply/queue/directive.js";
import { extractReplyToTag } from "./reply/reply-tags.js";

describe("directive parsing", () => {
  it("ignores verbose directive inside URL", () => {
    const body = "https://x.com/verioussmith/status/1997066835133669687";
    const res = extractVerboseDirective(body);
    expect(res.hasDirective).toBe(false);
    expect(res.cleaned).toBe(body);
  });

  it("ignores typoed /verioussmith", () => {
    const body = "/verioussmith";
    const res = extractVerboseDirective(body);
    expect(res.hasDirective).toBe(false);
    expect(res.cleaned).toBe(body.trim());
  });

  it("ignores think directive inside URL", () => {
    const body = "see https://example.com/path/thinkstuff";
    const res = extractThinkDirective(body);
    expect(res.hasDirective).toBe(false);
  });

  it("matches verbose with leading space", () => {
    const res = extractVerboseDirective(" please /verbose on now");
    expect(res.hasDirective).toBe(true);
    expect(res.verboseLevel).toBe("on");
  });

  it("matches trace with leading space", () => {
    const res = extractTraceDirective(" please /trace on now");
    expect(res.hasDirective).toBe(true);
    expect(res.traceLevel).toBe("on");
  });

  it("matches raw trace directive", () => {
    const res = extractTraceDirective(" please /trace raw now");
    expect(res.hasDirective).toBe(true);
    expect(res.traceLevel).toBe("raw");
  });

  it("matches reasoning directive", () => {
    const res = extractReasoningDirective("/reasoning on please");
    expect(res.hasDirective).toBe(true);
    expect(res.reasoningLevel).toBe("on");
  });

  it("matches reasoning stream directive", () => {
    const res = extractReasoningDirective("/reasoning stream please");
    expect(res.hasDirective).toBe(true);
    expect(res.reasoningLevel).toBe("stream");
  });

  it("matches fast directive", () => {
    const res = extractFastDirective("/fast on please");
    expect(res.hasDirective).toBe(true);
    expect(res.fastMode).toBe(true);
  });

  it("matches auto fast directive", () => {
    const res = extractFastDirective("/fast auto please");
    expect(res.hasDirective).toBe(true);
    expect(res.fastMode).toBe("auto");
  });

  it("parses default thinking and fast directives as override clears", () => {
    const think = parseInlineDirectives("/think default");
    expect(think.hasThinkDirective).toBe(true);
    expect(think.thinkLevel).toBeUndefined();
    expect(think.rawThinkLevel).toBe("default");
    expect(think.clearThinkLevel).toBe(true);

    const fast = parseInlineDirectives("/fast inherit");
    expect(fast.hasFastDirective).toBe(true);
    expect(fast.fastMode).toBeUndefined();
    expect(fast.rawFastMode).toBe("inherit");
    expect(fast.clearFastMode).toBe(true);
  });

  it("matches elevated with leading space", () => {
    const res = extractElevatedDirective(" please /elevated on now");
    expect(res.hasDirective).toBe(true);
    expect(res.elevatedLevel).toBe("on");
  });
  it("matches elevated ask", () => {
    const res = extractElevatedDirective("/elevated ask please");
    expect(res.hasDirective).toBe(true);
    expect(res.elevatedLevel).toBe("ask");
  });
  it("matches elevated full", () => {
    const res = extractElevatedDirective("/elevated full please");
    expect(res.hasDirective).toBe(true);
    expect(res.elevatedLevel).toBe("full");
  });

  it("matches think at start of line", () => {
    const res = extractThinkDirective("/think:high run slow");
    expect(res.hasDirective).toBe(true);
    expect(res.thinkLevel).toBe("high");
  });

  it("does not match /think followed by extra letters", () => {
    // e.g. someone typing "/think" + extra letter "hink"
    const res = extractThinkDirective("/thinkstuff");
    expect(res.hasDirective).toBe(false);
  });

  it("matches /think with no argument", () => {
    const res = extractThinkDirective("/think");
    expect(res.hasDirective).toBe(true);
    expect(res.thinkLevel).toBeUndefined();
    expect(res.rawLevel).toBeUndefined();
  });

  it("matches /t with no argument", () => {
    const res = extractThinkDirective("/t");
    expect(res.hasDirective).toBe(true);
    expect(res.thinkLevel).toBeUndefined();
  });

  it("matches think with no argument and consumes colon", () => {
    const res = extractThinkDirective("/think:");
    expect(res.hasDirective).toBe(true);
    expect(res.thinkLevel).toBeUndefined();
    expect(res.rawLevel).toBeUndefined();
    expect(res.cleaned).toBe("");
  });

  it("matches verbose with no argument", () => {
    const res = extractVerboseDirective("/verbose:");
    expect(res.hasDirective).toBe(true);
    expect(res.verboseLevel).toBeUndefined();
    expect(res.rawLevel).toBeUndefined();
    expect(res.cleaned).toBe("");
  });

  it("matches fast with no argument", () => {
    const res = extractFastDirective("/fast:");
    expect(res.hasDirective).toBe(true);
    expect(res.fastMode).toBeUndefined();
    expect(res.rawLevel).toBeUndefined();
    expect(res.cleaned).toBe("");
  });

  it("matches reasoning with no argument", () => {
    const res = extractReasoningDirective("/reasoning:");
    expect(res.hasDirective).toBe(true);
    expect(res.reasoningLevel).toBeUndefined();
    expect(res.rawLevel).toBeUndefined();
    expect(res.cleaned).toBe("");
  });

  it("matches elevated with no argument", () => {
    const res = extractElevatedDirective("/elevated:");
    expect(res.hasDirective).toBe(true);
    expect(res.elevatedLevel).toBeUndefined();
    expect(res.rawLevel).toBeUndefined();
    expect(res.cleaned).toBe("");
  });

  it("matches exec directive with options", () => {
    const res = extractExecDirective(
      "please /exec host=auto security=allowlist ask=on-miss node=mac-mini now",
    );
    expect(res.hasDirective).toBe(true);
    expect(res.execHost).toBe("auto");
    expect(res.execSecurity).toBe("allowlist");
    expect(res.execAsk).toBe("on-miss");
    expect(res.execNode).toBe("mac-mini");
    expect(res.cleaned).toBe("please now");
  });

  it("captures invalid exec host values", () => {
    const res = extractExecDirective("/exec host=spaceship");
    expect(res.hasDirective).toBe(true);
    expect(res.execHost).toBeUndefined();
    expect(res.rawExecHost).toBe("spaceship");
    expect(res.invalidHost).toBe(true);
  });

  it("matches queue directive", () => {
    const res = extractQueueDirective("please /queue interrupt now");
    expect(res.hasDirective).toBe(true);
    expect(res.queueMode).toBe("interrupt");
    expect(res.queueReset).toBe(false);
    expect(res.cleaned).toBe("please now");
  });

  it("matches steer queue directive", () => {
    const res = extractQueueDirective("please /queue steer now");
    expect(res.hasDirective).toBe(true);
    expect(res.queueMode).toBe("steer");
    expect(res.rawMode).toBe("steer");
    expect(res.cleaned).toBe("please now");
  });

  it("strips inline /model and /think directives while keeping user text", () => {
    const model = parseInlineDirectives("please sync /model openai/gpt-4.1-mini now");
    expect(model.cleaned).toBe("please sync now");
    expect(model.hasModelDirective).toBe(true);
    expect(model.rawModelDirective).toBe("openai/gpt-4.1-mini");
    expect(model.modelSessionOnly).toBe(false);

    const think = parseInlineDirectives("please sync /think:high now");
    expect(think.cleaned).toBe("please sync now");
    expect(think.hasThinkDirective).toBe(true);
    expect(think.thinkLevel).toBe("high");
  });

  it("preserves the trailing /model -s session-only scope", () => {
    const model = parseInlineDirectives("please sync /model openai/gpt-4.1-mini -s now");
    expect(model.cleaned).toBe("please sync now");
    expect(model.hasModelDirective).toBe(true);
    expect(model.rawModelDirective).toBe("openai/gpt-4.1-mini");
    expect(model.modelSessionOnly).toBe(true);
  });

  it("preserves the trailing /model --session scope for native slash commands", () => {
    const model = parseInlineDirectives("/model openai/gpt-4.1-mini --session", {
      nativeCommand: "model",
    });

    expect(model.cleaned).toBe("");
    expect(model.rawModelDirective).toBe("openai/gpt-4.1-mini");
    expect(model.modelSessionOnly).toBe(true);
    expect(model.nativeCommand).toEqual({ name: "model" });
  });

  it.each(["--runtime codex -s", "-s --runtime codex", "runtime=codex -s", "-s harness=codex"])(
    "parses /model runtime and session options from %s",
    (options) => {
      const model = parseInlineDirectives(`/model openai/gpt-4.1-mini ${options}`, {
        nativeCommand: "model",
      });

      expect(model.cleaned).toBe("");
      expect(model.rawModelDirective).toBe("openai/gpt-4.1-mini");
      expect(model.rawModelRuntime).toBe("codex");
      expect(model.modelSessionOnly).toBe(true);
      expect(model.nativeCommand).toEqual({ name: "model" });
    },
  );

  it.each(["-slow", "--sessional"])(
    "preserves partial session option %s as ordinary text",
    (option) => {
      const model = parseInlineDirectives(`please sync /model openai/gpt-4.1-mini ${option} now`);

      expect(model.rawModelDirective).toBe("openai/gpt-4.1-mini");
      expect(model.modelSessionOnly).toBe(false);
      expect(model.cleaned).toBe(`please sync ${option} now`);
    },
  );

  it("rejects duplicate native /model options through unconsumed arguments", () => {
    const model = parseInlineDirectives(
      "/model openai/gpt-4.1-mini --runtime codex --runtime acp",
      { nativeCommand: "model" },
    );

    expect(model.rawModelDirective).toBe("openai/gpt-4.1-mini");
    expect(model.rawModelRuntime).toBe("codex");
    expect(model.cleaned).toBe("--runtime acp");
    expect(model.nativeCommand).toEqual({
      name: "model",
      unconsumedArguments: "--runtime acp",
    });
  });

  it("preserves duplicate inline /model options as message text", () => {
    const model = parseInlineDirectives("please sync /model openai/gpt-4.1-mini -s -s now");

    expect(model.rawModelDirective).toBe("openai/gpt-4.1-mini");
    expect(model.modelSessionOnly).toBe(true);
    expect(model.cleaned).toBe("please sync -s now");
  });

  it("keeps here as the selected model in mixed commands", () => {
    const model = parseInlineDirectives("please /model here continue");
    expect(model.cleaned).toBe("please continue");
    expect(model.rawModelDirective).toBe("here");
    expect(model.modelSessionOnly).toBe(false);
  });

  it("keeps --persist as ordinary text for inline directives", () => {
    const model = parseInlineDirectives("please sync /model openai/gpt-4.1-mini --persist now");
    expect(model.cleaned).toBe("please sync --persist now");
    expect(model.hasModelDirective).toBe(true);
    expect(model.rawModelDirective).toBe("openai/gpt-4.1-mini");

    const think = parseInlineDirectives("/think high --persist");
    expect(think.cleaned).toBe("--persist");
    expect(think.hasThinkDirective).toBe(true);
    expect(think.thinkLevel).toBe("high");
  });

  it("keeps --persist in ordinary messages", () => {
    const parsed = parseInlineDirectives("please keep --persist in this text");

    expect(parsed.cleaned).toBe("please keep --persist in this text");
  });

  it("preserves spacing when stripping think directives before paths", () => {
    const res = extractThinkDirective("thats not /think high/tmp/hello");
    expect(res.hasDirective).toBe(true);
    expect(res.cleaned).toBe("thats not /tmp/hello");
  });

  it("preserves spacing when stripping verbose directives before paths", () => {
    const res = extractVerboseDirective("thats not /verbose on/tmp/hello");
    expect(res.hasDirective).toBe(true);
    expect(res.cleaned).toBe("thats not /tmp/hello");
  });

  it("preserves spacing when stripping reasoning directives before paths", () => {
    const res = extractReasoningDirective("thats not /reasoning on/tmp/hello");
    expect(res.hasDirective).toBe(true);
    expect(res.cleaned).toBe("thats not /tmp/hello");
  });

  it("preserves spacing when stripping status directives before paths", () => {
    const res = extractStatusDirective("thats not /status:/tmp/hello");
    expect(res.hasDirective).toBe(true);
    expect(res.cleaned).toBe("thats not /tmp/hello");
  });

  it("does not treat /usage as a status directive", () => {
    const res = extractStatusDirective("thats not /usage:/tmp/hello");
    expect(res.hasDirective).toBe(false);
    expect(res.cleaned).toBe("thats not /usage:/tmp/hello");
  });

  it("parses queue options and modes", () => {
    const res = extractQueueDirective("please /queue collect debounce:2s cap:5 drop:summarize now");
    expect(res.hasDirective).toBe(true);
    expect(res.queueMode).toBe("collect");
    expect(res.debounceMs).toBe(2000);
    expect(res.cap).toBe(5);
    expect(res.dropPolicy).toBe("summarize");
    expect(res.cleaned).toBe("please now");
  });

  it("extracts reply_to_current tag", () => {
    const res = extractReplyToTag("ok [[reply_to_current]]", "msg-1");
    expect(res.replyToId).toBe("msg-1");
    expect(res.cleaned).toBe("ok");
  });

  it("extracts reply_to_current tag with whitespace", () => {
    const res = extractReplyToTag("ok [[ reply_to_current ]]", "msg-1");
    expect(res.replyToId).toBe("msg-1");
    expect(res.cleaned).toBe("ok");
  });

  it("extracts reply_to id tag", () => {
    const res = extractReplyToTag("see [[reply_to:12345]] now", "msg-1");
    expect(res.replyToId).toBe("12345");
    expect(res.cleaned).toBe("see now");
  });

  it("extracts reply_to id tag with whitespace", () => {
    const res = extractReplyToTag("see [[ reply_to : 12345 ]] now", "msg-1");
    expect(res.replyToId).toBe("12345");
    expect(res.cleaned).toBe("see now");
  });

  it("preserves newlines when stripping reply tags", () => {
    const res = extractReplyToTag("line 1\nline 2 [[reply_to_current]]\n\nline 3", "msg-2");
    expect(res.replyToId).toBe("msg-2");
    expect(res.cleaned).toBe("line 1\nline 2\n\nline 3");
  });
});

describe("level directive preserves message text after an invalid level", () => {
  it("keeps the message when /verbose is followed by prose", () => {
    const res = parseInlineDirectives("/verbose explain quantum computing");
    expect(res.hasVerboseDirective).toBe(true);
    expect(res.verboseLevel).toBeUndefined();
    expect(res.rawVerboseLevel).toBeUndefined();
    expect(res.cleaned).toBe("explain quantum computing");
  });

  it("keeps the next line when /verbose is on its own line", () => {
    const res = extractVerboseDirective("/verbose\nSummarize this document");
    expect(res.hasDirective).toBe(true);
    expect(res.verboseLevel).toBeUndefined();
    expect(res.cleaned).toBe("Summarize this document");
  });

  it("keeps the message when /think is followed by prose", () => {
    const res = extractThinkDirective("/think about my deployment plan");
    expect(res.hasDirective).toBe(true);
    expect(res.thinkLevel).toBeUndefined();
    expect(res.rawLevel).toBeUndefined();
    expect(res.cleaned).toBe("about my deployment plan");
  });

  it("still consumes a valid level argument", () => {
    const res = extractThinkDirective("/think high");
    expect(res.hasDirective).toBe(true);
    expect(res.thinkLevel).toBe("high");
    expect(res.cleaned).toBe("");
  });

  it("still consumes off so it persists rather than clears", () => {
    const elevated = extractElevatedDirective("hello there /elevated off");
    expect(elevated.elevatedLevel).toBe("off");
    expect(elevated.cleaned).toBe("hello there");
  });

  it("still reports a single unrecognized trailing token", () => {
    const res = extractElevatedDirective("/elevated maybe");
    expect(res.hasDirective).toBe(true);
    expect(res.elevatedLevel).toBeUndefined();
    expect(res.rawLevel).toBe("maybe");
  });
});

describe("native directive commands own their complete argument boundary", () => {
  it.each([
    {
      command: "think" as const,
      body: "/think about my deployment plan",
      rawKey: "rawThinkLevel" as const,
      invalidArgument: "about",
      trailingArguments: "my deployment plan",
    },
    {
      command: "verbose" as const,
      body: "/verbose explain quantum computing",
      rawKey: "rawVerboseLevel" as const,
      invalidArgument: "explain",
      trailingArguments: "quantum computing",
    },
    {
      command: "trace" as const,
      body: "/trace banana please",
      rawKey: "rawTraceLevel" as const,
      invalidArgument: "banana",
      trailingArguments: "please",
    },
    {
      command: "fast" as const,
      body: "/fast bananas please",
      rawKey: "rawFastMode" as const,
      invalidArgument: "bananas",
      trailingArguments: "please",
    },
    {
      command: "reasoning" as const,
      body: "/reasoning nonsense please",
      rawKey: "rawReasoningLevel" as const,
      invalidArgument: "nonsense",
      trailingArguments: "please",
    },
    {
      command: "elevated" as const,
      body: "/elevated perhaps explain",
      rawKey: "rawElevatedLevel" as const,
      invalidArgument: "perhaps",
      trailingArguments: "explain",
    },
  ])(
    "preserves the invalid first argument for native /$command",
    ({ body, command, invalidArgument, rawKey, trailingArguments }) => {
      const parsed = parseInlineDirectives(body, { nativeCommand: command });

      expect(parsed[rawKey]).toBe(invalidArgument);
      expect(parsed.cleaned).toBe(trailingArguments);
      expect(parsed.nativeCommand).toEqual({
        name: command,
        unconsumedArguments: trailingArguments,
      });
    },
  );

  it("retains unexpected arguments after a valid native queue mode", () => {
    const parsed = parseInlineDirectives("/queue collect please help", {
      nativeCommand: "queue",
    });

    expect(parsed.queueMode).toBe("collect");
    expect(parsed.nativeCommand).toEqual({
      name: "queue",
      unconsumedArguments: "please help",
    });
  });

  it("does not interpret another directive inside native command arguments", () => {
    const parsed = parseInlineDirectives("/queue /think high", { nativeCommand: "queue" });

    expect(parsed.hasQueueDirective).toBe(true);
    expect(parsed.rawQueueMode).toBe("/think");
    expect(parsed.hasThinkDirective).toBe(false);
  });

  it("preserves the existing prose interpretation for ordinary inline directives", () => {
    const parsed = parseInlineDirectives("/think about my deployment plan");

    expect(parsed.rawThinkLevel).toBeUndefined();
    expect(parsed.nativeCommand).toBeUndefined();
    expect(parsed.cleaned).toBe("about my deployment plan");
  });
});
