// Status-all channels table tests verify gateway issue overlays and channel row rendering.
import { describe, expect, it } from "vitest";
import { buildStatusChannelsTableRows } from "./channels-table.js";

describe("buildStatusChannelsTableRows", () => {
  const ok = (text: string) => `[ok:${text}]`;
  const warn = (text: string) => `[warn:${text}]`;
  const muted = (text: string) => `[muted:${text}]`;
  const accentDim = (text: string) => `[setup:${text}]`;

  it("overlays gateway issues and preserves off rows", () => {
    expect(
      buildStatusChannelsTableRows({
        rows: [
          {
            id: "signal",
            label: "Signal",
            enabled: true,
            state: "ok",
            detail: "configured",
          },
          {
            id: "discord",
            label: "Discord",
            enabled: false,
            state: "off",
            detail: "disabled",
          },
        ],
        channelIssues: [
          { channel: "signal", message: "signal-cli unreachable from gateway runtime" },
          { channel: "discord", message: "should not override off" },
        ],
        ok,
        warn,
        muted,
        accentDim,
        formatIssueMessage: (message) => message.slice(0, 20),
      }),
    ).toEqual([
      {
        Channel: "Signal",
        Enabled: "[ok:ON]",
        State: "[warn:WARN]",
        Detail: "configured · [warn:gateway: signal-cli unreachab]",
      },
      {
        Channel: "Discord",
        Enabled: "[muted:OFF]",
        State: "[muted:OFF]",
        Detail: "disabled · [warn:gateway: should not override ]",
      },
    ]);
  });
});
