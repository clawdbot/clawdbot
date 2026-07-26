// Verifies TUI waiting indicators and elapsed-time rendering.
import { describe, expect, it } from "vitest";
import { buildWaitingStatusMessage } from "./tui-waiting.js";

const theme = {
  dim: (s: string) => `<d>${s}</d>`,
  bold: (s: string) => `<b>${s}</b>`,
  accentSoft: (s: string) => `<a>${s}</a>`,
} satisfies Parameters<typeof buildWaitingStatusMessage>[0]["theme"];

describe("tui-waiting", () => {
  it("rotates the rendered waiting phrase every 10 ticks", () => {
    const phrases = ["a", "b", "c"];
    const renderPhrase = (tick: number) =>
      buildWaitingStatusMessage({
        theme,
        tick,
        elapsed: "3s",
        connectionStatus: "connected",
        phrases,
      }).replace(/<[^>]+>/g, "");
    expect(renderPhrase(0)).toMatch(/^a…/);
    expect(renderPhrase(9)).toMatch(/^a…/);
    expect(renderPhrase(10)).toMatch(/^b…/);
    expect(renderPhrase(20)).toMatch(/^c…/);
    expect(renderPhrase(30)).toMatch(/^a…/);
  });

  it("buildWaitingStatusMessage includes shimmer markup and metadata", () => {
    const msg = buildWaitingStatusMessage({
      theme,
      tick: 1,
      elapsed: "3s",
      connectionStatus: "connected",
      phrases: ["hello"],
    });

    expect(msg).toBe(
      "<b><a>h</a></b><b><a>e</a></b><d>l</d><d>l</d><d>o</d><d>…</d> • 3s | connected",
    );
  });
});
