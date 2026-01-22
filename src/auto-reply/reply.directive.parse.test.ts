import { describe, expect, it } from "vitest";

import { extractStatusDirective } from "./reply/directives.js";
import {
  extractElevatedDirective,
  extractExecDirective,
  extractQueueDirective,
  extractReasoningDirective,
  extractReplyToTag,
  extractThinkDirective,
  extractVerboseDirective,
} from "./reply.js";

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
      "please /exec host=gateway security=allowlist ask=on-miss node=mac-mini now",
    );
    expect(res.hasDirective).toBe(true);
    expect(res.execHost).toBe("gateway");
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
    const res = extractQueueDirective(
      "please /queue steer+backlog debounce:2s cap:5 drop:summarize now",
    );
    expect(res.hasDirective).toBe(true);
    expect(res.queueMode).toBe("steer-backlog");
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
