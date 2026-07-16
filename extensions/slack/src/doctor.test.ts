import { describe, expect, it } from "vitest";
import { slackDoctor } from "./doctor.js";

describe("slack doctor", () => {
  it("warns when mutable allowlist entries rely on disabled name matching", () => {
    expect(
      slackDoctor.collectMutableAllowlistWarnings?.({
        cfg: {
          channels: {
            slack: {
              allowFrom: ["alice"],
              accounts: {
                work: {
                  dm: {
                    allowFrom: ["U12345678"],
                  },
                  channels: {
                    general: {
                      users: ["bob"],
                    },
                  },
                },
              },
            },
          },
        } as never,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("mutable allowlist entries across slack"),
        expect.stringContaining("channels.slack.allowFrom: alice"),
        expect.stringContaining("channels.slack.accounts.work.channels.general.users: bob"),
      ]),
    );
  });

  it("normalizes legacy slack streaming aliases into the nested streaming shape", () => {
    const normalize = slackDoctor.normalizeCompatibilityConfig;
    expect(normalize).toBeDefined();
    if (!normalize) {
      return;
    }

    const result = normalize({
      cfg: {
        channels: {
          slack: {
            streamMode: "status_final",
            chunkMode: "newline",
            blockStreaming: true,
            blockStreamingCoalesce: {
              idleMs: 250,
            },
            accounts: {
              work: {
                streaming: false,
                nativeStreaming: false,
              },
            },
          },
        },
      } as never,
    });

    expect(result.config.channels?.slack?.streaming).toEqual({
      mode: "progress",
      chunkMode: "newline",
      block: {
        enabled: true,
        coalesce: {
          idleMs: 250,
        },
      },
    });
    expect(result.config.channels?.slack?.accounts?.work?.streaming).toEqual({
      mode: "off",
      nativeTransport: false,
    });
    expect(result.changes).toEqual(
      expect.arrayContaining([
        "Moved channels.slack.streamMode → channels.slack.streaming.mode (progress).",
        "Moved channels.slack.chunkMode → channels.slack.streaming.chunkMode.",
        "Moved channels.slack.blockStreaming → channels.slack.streaming.block.enabled.",
        "Moved channels.slack.blockStreamingCoalesce → channels.slack.streaming.block.coalesce.",
        "Moved channels.slack.accounts.work.streaming (boolean) → channels.slack.accounts.work.streaming.mode (off).",
        "Moved channels.slack.accounts.work.nativeStreaming → channels.slack.accounts.work.streaming.nativeTransport.",
      ]),
    );
  });

  it("does not duplicate streaming.mode change messages when streamMode wins over boolean streaming", () => {
    const normalize = slackDoctor.normalizeCompatibilityConfig;
    expect(normalize).toBeDefined();
    if (!normalize) {
      return;
    }

    const result = normalize({
      cfg: {
        channels: {
          slack: {
            streamMode: "status_final",
            streaming: false,
          },
        },
      } as never,
    });

    expect(result.config.channels?.slack?.streaming).toEqual({
      mode: "progress",
      nativeTransport: false,
    });
    expect(
      result.changes.filter((change) => change.includes("channels.slack.streaming.mode")),
    ).toEqual(["Moved channels.slack.streamMode → channels.slack.streaming.mode (progress)."]);
  });
});
