import { describe, expect, it } from "vitest";
import { slackDoctor } from "./doctor.js";

function getSlackCompatibilityNormalizer(): NonNullable<
  typeof slackDoctor.normalizeCompatibilityConfig
> {
  const normalize = slackDoctor.normalizeCompatibilityConfig;
  if (!normalize) {
    throw new Error("Expected slack doctor to expose normalizeCompatibilityConfig");
  }
  return normalize;
}

describe("slack doctor", () => {
  it("warns when mutable allowlist entries rely on disabled name matching", async () => {
    const warnings = await Promise.resolve(
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
    );
    expect(
      warnings?.some((warning) => warning.includes("mutable allowlist entries across slack")),
    ).toBe(true);
    expect(warnings?.some((warning) => warning.includes("channels.slack.allowFrom: alice"))).toBe(
      true,
    );
    expect(
      warnings?.some((warning) =>
        warning.includes("channels.slack.accounts.work.channels.general.users: bob"),
      ),
    ).toBe(true);
  });

  it("normalizes legacy slack streaming aliases into the nested streaming shape", () => {
    const normalize = getSlackCompatibilityNormalizer();

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
    for (const expectedChange of [
      "Moved channels.slack.streamMode → channels.slack.streaming.mode (progress).",
      "Moved channels.slack.chunkMode → channels.slack.streaming.chunkMode.",
      "Moved channels.slack.blockStreaming → channels.slack.streaming.block.enabled.",
      "Moved channels.slack.blockStreamingCoalesce → channels.slack.streaming.block.coalesce.",
      "Moved channels.slack.accounts.work.streaming (boolean) → channels.slack.accounts.work.streaming.mode (off).",
      "Moved channels.slack.accounts.work.nativeStreaming → channels.slack.accounts.work.streaming.nativeTransport.",
    ]) {
      expect(result.changes).toContain(expectedChange);
    }
  });

  it("does not duplicate streaming.mode change messages when streamMode wins over boolean streaming", () => {
    const normalize = getSlackCompatibilityNormalizer();

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

  it("moves legacy channel allow toggles into enabled", () => {
    const normalize = getSlackCompatibilityNormalizer();

    const result = normalize({
      cfg: {
        channels: {
          slack: {
            channels: {
              ops: {
                allow: false,
              },
            },
            accounts: {
              work: {
                channels: {
                  general: {
                    allow: true,
                  },
                },
              },
            },
          },
        },
      } as never,
    });

    expect(result.changes).toEqual([
      "Moved channels.slack.channels.ops.allow → channels.slack.channels.ops.enabled.",
      "Moved channels.slack.accounts.work.channels.general.allow → channels.slack.accounts.work.channels.general.enabled.",
    ]);
    expect(result.config.channels?.slack?.channels?.ops).toEqual({
      enabled: false,
    });
    expect(result.config.channels?.slack?.accounts?.work?.channels?.general).toEqual({
      enabled: true,
    });
  });
});
