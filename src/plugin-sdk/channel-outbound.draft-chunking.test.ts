// Tests shared channel draft chunking resolution exposed through plugin-sdk/channel-outbound.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { resolveChannelDraftStreamingChunking } from "./channel-outbound.js";

describe("resolveChannelDraftStreamingChunking", () => {
  it("returns draft stream defaults when channel config is unset", () => {
    expect(
      resolveChannelDraftStreamingChunking(undefined, "telegram", "default", {
        fallbackLimit: 4096,
      }),
    ).toEqual({
      minChars: 200,
      maxChars: 800,
      breakPreference: "paragraph",
    });
  });

  it("clamps requested draft chunk sizes to the resolved text limit", () => {
    const cfg: OpenClawConfig = {
      channels: {
        discord: {
          textChunkLimit: 500,
          streaming: {
            preview: {
              chunk: {
                minChars: 900,
                maxChars: 1200,
                breakPreference: "sentence",
              },
            },
          },
        },
      },
    };

    expect(
      resolveChannelDraftStreamingChunking(cfg, "discord", undefined, {
        fallbackLimit: 2000,
      }),
    ).toEqual({
      minChars: 500,
      maxChars: 500,
      breakPreference: "sentence",
    });
  });

  it("prefers account draft chunking over channel defaults", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          allowFrom: ["*"],
          streaming: {
            preview: {
              chunk: {
                minChars: 200,
                maxChars: 800,
                breakPreference: "paragraph",
              },
            },
          },
          accounts: {
            default: {
              allowFrom: ["*"],
              streaming: {
                preview: {
                  chunk: {
                    minChars: 10,
                    maxChars: 20,
                    breakPreference: "newline",
                  },
                },
              },
            },
          },
        },
      },
    };

    expect(
      resolveChannelDraftStreamingChunking(cfg, "telegram", "default", {
        fallbackLimit: 4096,
      }),
    ).toEqual({
      minChars: 10,
      maxChars: 20,
      breakPreference: "newline",
    });
  });
});
