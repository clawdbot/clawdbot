// Widget document wrapper: byte stability and the host-bridge contract it emits.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildWidgetDocument } from "./wrap.js";

describe("buildWidgetDocument", () => {
  it("keeps the wrapped document bytes stable", () => {
    const html = buildWidgetDocument(
      "Status <live>",
      '<SvG viewBox="0 0 10 10"><circle r="4" /></SvG>',
    );

    expect(Buffer.byteLength(html)).toBe(18121);
    expect(createHash("sha256").update(html).digest("hex")).toBe(
      "c8f0ea0dea6648693a8972f602762716618563022f8248e8e7d99a8b1a723692",
    );
    expect(html).toContain("openclaw:widget-host-init-ack");
    expect(html).toContain('request("host.open",{url})');
    // Widget links follow the Control UI activation contract: primary click and
    // middle-button auxclick, on bubble so a widget's preventDefault still wins.
    expect(html).toContain('listen("click",activate);listen("auxclick",activate);');
    expect(html).toContain('event.type==="auxclick"&&event.button===1');
    expect(html).toContain("event.defaultPrevented||event.shiftKey||event.altKey");
    expect(html).not.toContain("{capture:true}");
    expect(html).toContain("controlUiBaseUrl");
    expect(html).toContain('define(host,"controlUiBaseUrl"');
    expect(html).toContain("else push.call(waiting,{send,reject})");
    expect(html).toContain("else push.call(promptWaiting,{send,inline,reject})");
    expect(html).toContain("openclaw:widget-prompt-host-ready");
    expect(html).toContain("widget host capabilities unavailable");
    expect(html).toContain("widget prompt host unavailable");
    expect(html).toContain("openclaw:widget-chat-host");
    expect(html).toContain("openclaw:widget-board-host");
    expect(html).toContain("openclaw:widget-scroll");
    expect(html).toContain("event.isTrusted");
    expect(html).not.toContain("widget is not hosted on a board");
    const bridgeKeys = JSON.parse(html.match(/const keys=(\[[^\]]+\])/)?.[1] ?? "[]") as string[];
    expect(bridgeKeys).toEqual([
      "surface",
      "card",
      "elevated",
      "text",
      "text-strong",
      "muted",
      "border",
      "border-strong",
      "accent",
      "accent-fill",
      "accent-fg",
      "ok",
      "warn",
      "danger",
      "info",
      "radius",
      "radius-full",
      "scrollbar-size",
      "scrollbar-thumb-inset",
      "scrollbar-thumb",
      "scrollbar-thumb-hover",
      "font-body",
      "font-mono",
    ]);
  });
});
