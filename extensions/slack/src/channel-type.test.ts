// Slack tests cover channel type plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetSlackChannelTypeCacheForTest,
  resolveSlackChannelType,
  resolveSlackConversationInfo,
} from "./channel-type.js";

const slackClientMocks = vi.hoisted(() => {
  const conversationsInfo = vi.fn();
  const conversationsOpen = vi.fn();
  return {
    conversationsInfo,
    conversationsOpen,
    createSlackWebClient: vi.fn(() => ({
      conversations: {
        info: conversationsInfo,
        open: conversationsOpen,
      },
    })),
  };
});
const {
  conversationsInfo: conversationsInfoMock,
  conversationsOpen: conversationsOpenMock,
  createSlackWebClient: createSlackWebClientMock,
} = slackClientMocks;

vi.mock("./client.js", () => ({
  createSlackWebClient: slackClientMocks.createSlackWebClient,
}));

describe("resolveSlackChannelType", () => {
  beforeEach(() => {
    conversationsInfoMock.mockReset();
    conversationsOpenMock.mockReset();
    createSlackWebClientMock.mockClear();
    resetSlackChannelTypeCacheForTest();
  });

  it("uses configured defaultAccount for omitted-account cache keys", async () => {
    const channelId = "C123";

    await expect(
      resolveSlackChannelType({
        cfg: {
          channels: {
            slack: {
              enabled: true,
            },
          },
        } as never,
        channelId,
      }),
    ).resolves.toBe("unknown");

    await expect(
      resolveSlackChannelType({
        cfg: {
          channels: {
            slack: {
              enabled: true,
              defaultAccount: "work",
              accounts: {
                work: {
                  dm: {
                    groupChannels: [channelId],
                  },
                },
              },
            },
          },
        } as never,
        channelId,
      }),
    ).resolves.toBe("group");

    expect(conversationsInfoMock).not.toHaveBeenCalled();
  });

  it("returns Slack IM peer user metadata from conversations.open", async () => {
    conversationsOpenMock.mockResolvedValueOnce({
      channel: {
        id: "D0AEWSDHAQH",
        is_im: true,
        user: "U09G2DJ0275",
      },
    });

    await expect(
      resolveSlackConversationInfo({
        cfg: {
          channels: {
            slack: {
              botToken: "xoxb-test",
            },
          },
        } as never,
        channelId: "D0AEWSDHAQH",
      }),
    ).resolves.toEqual({
      type: "dm",
      user: "U09G2DJ0275",
    });
    expect(conversationsOpenMock).toHaveBeenCalledWith({
      channel: "D0AEWSDHAQH",
      prevent_creation: true,
      return_im: true,
    });
    expect(conversationsInfoMock).not.toHaveBeenCalled();
  });

  it("uses the read credential to classify C-prefixed MPIMs and returns their name", async () => {
    conversationsInfoMock.mockResolvedValueOnce({
      channel: {
        id: "C0MPIM",
        is_mpim: true,
        name: "mpdm-alice--bob-1",
      },
    });

    await expect(
      resolveSlackConversationInfo({
        cfg: {
          channels: {
            slack: {
              botToken: "xoxb-writer",
              userToken: "xoxp-reader",
            },
          },
        } as never,
        channelId: "C0MPIM",
        operation: "read",
      }),
    ).resolves.toEqual({
      type: "group",
      name: "mpdm-alice--bob-1",
    });
    expect(createSlackWebClientMock).toHaveBeenCalledWith("xoxp-reader");
    expect(conversationsInfoMock).toHaveBeenCalledWith({ channel: "C0MPIM" });
  });

  it("does not reuse cached metadata across Slack credential rotation", async () => {
    conversationsInfoMock
      .mockResolvedValueOnce({
        channel: {
          id: "C0CHANNEL",
          name: "before-rotation",
        },
      })
      .mockResolvedValueOnce({
        channel: {
          id: "C0CHANNEL",
          name: "after-rotation",
        },
      });

    await expect(
      resolveSlackConversationInfo({
        cfg: {
          channels: {
            slack: {
              botToken: "xoxb-before",
            },
          },
        } as never,
        channelId: "C0CHANNEL",
      }),
    ).resolves.toMatchObject({ name: "before-rotation" });
    await expect(
      resolveSlackConversationInfo({
        cfg: {
          channels: {
            slack: {
              botToken: "xoxb-after",
            },
          },
        } as never,
        channelId: "C0CHANNEL",
      }),
    ).resolves.toMatchObject({ name: "after-rotation" });

    expect(createSlackWebClientMock).toHaveBeenNthCalledWith(1, "xoxb-before");
    expect(createSlackWebClientMock).toHaveBeenNthCalledWith(2, "xoxb-after");
    expect(conversationsInfoMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes names used for authorization instead of caching them", async () => {
    conversationsInfoMock
      .mockResolvedValueOnce({
        channel: {
          id: "C0CHANNEL",
          name: "old-name",
        },
      })
      .mockResolvedValueOnce({
        channel: {
          id: "C0CHANNEL",
          name: "new-name",
        },
      });
    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-test",
        },
      },
    } as never;

    await expect(
      resolveSlackConversationInfo({
        cfg,
        channelId: "C0CHANNEL",
        requireFreshName: true,
      }),
    ).resolves.toMatchObject({ name: "old-name" });
    await expect(
      resolveSlackConversationInfo({
        cfg,
        channelId: "C0CHANNEL",
        requireFreshName: true,
      }),
    ).resolves.toMatchObject({ name: "new-name" });

    expect(conversationsInfoMock).toHaveBeenCalledTimes(2);
  });

  it("keeps D-prefixed channels typed as dm when Slack lookup fails", async () => {
    conversationsOpenMock.mockRejectedValueOnce(new Error("missing_scope"));

    await expect(
      resolveSlackConversationInfo({
        cfg: {
          channels: {
            slack: {
              botToken: "xoxb-test",
            },
          },
        } as never,
        channelId: "D0AEWSDHAQH",
      }),
    ).resolves.toEqual({
      type: "dm",
    });
  });

  it.each([
    {
      name: "group DM",
      channelId: "C0MPIM",
      slackConfig: {
        dm: {
          groupChannels: ["C0MPIM"],
        },
      },
    },
    {
      name: "channel",
      channelId: "C0CHANNEL",
      slackConfig: {
        channels: {
          C0CHANNEL: {},
        },
      },
    },
  ])(
    "does not use configured $name entries as topology proof when Slack lookup fails",
    async ({ channelId, slackConfig }) => {
      conversationsInfoMock.mockRejectedValueOnce(new Error("missing_scope"));

      await expect(
        resolveSlackConversationInfo({
          cfg: {
            channels: {
              slack: {
                botToken: "xoxb-test",
                ...slackConfig,
              },
            },
          } as never,
          channelId,
        }),
      ).resolves.toEqual({
        type: "unknown",
      });
      expect(conversationsInfoMock).toHaveBeenCalledWith({ channel: channelId });
    },
  );

  it("keeps successful Slack metadata authoritative over configured fallback", async () => {
    conversationsInfoMock.mockResolvedValueOnce({
      channel: {
        id: "C0CHANNEL",
        is_mpim: false,
      },
    });

    await expect(
      resolveSlackConversationInfo({
        cfg: {
          channels: {
            slack: {
              botToken: "xoxb-test",
              dm: {
                groupChannels: ["C0CHANNEL"],
              },
            },
          },
        } as never,
        channelId: "C0CHANNEL",
      }),
    ).resolves.toEqual({
      type: "channel",
    });
  });

  it("does not cache incomplete native IM channel lookups", async () => {
    conversationsOpenMock
      .mockRejectedValueOnce(new Error("temporary_failure"))
      .mockResolvedValueOnce({
        channel: {
          id: "D0AEWSDHAQH",
          is_im: true,
          user: "U09G2DJ0275",
        },
      });

    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-test",
        },
      },
    } as never;

    await expect(
      resolveSlackConversationInfo({
        cfg,
        channelId: "D0AEWSDHAQH",
      }),
    ).resolves.toEqual({
      type: "dm",
    });
    await expect(
      resolveSlackConversationInfo({
        cfg,
        channelId: "D0AEWSDHAQH",
      }),
    ).resolves.toEqual({
      type: "dm",
      user: "U09G2DJ0275",
    });
    expect(conversationsOpenMock).toHaveBeenCalledTimes(2);
  });

  it("does not let group-channel overrides reclassify native IM channel ids", async () => {
    await expect(
      resolveSlackConversationInfo({
        cfg: {
          channels: {
            slack: {
              dm: {
                groupChannels: ["D0AEWSDHAQH"],
              },
            },
          },
        } as never,
        channelId: "D0AEWSDHAQH",
      }),
    ).resolves.toEqual({
      type: "dm",
    });
    expect(conversationsOpenMock).not.toHaveBeenCalled();
    expect(conversationsInfoMock).not.toHaveBeenCalled();
  });

  it("evicts least-recently-used conversation info entries after the cache limit", async () => {
    const cacheMaxEntries = 1024;
    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-test",
        },
      },
    } as never;

    conversationsInfoMock.mockImplementation(async ({ channel }) => ({
      channel: {
        id: channel,
      },
    }));

    for (let index = 0; index < cacheMaxEntries; index++) {
      await resolveSlackConversationInfo({
        cfg,
        channelId: `C${index.toString().padStart(8, "0")}`,
      });
    }
    expect(conversationsInfoMock).toHaveBeenCalledTimes(cacheMaxEntries);

    await resolveSlackConversationInfo({
      cfg,
      channelId: "C00000000",
    });
    expect(conversationsInfoMock).toHaveBeenCalledTimes(cacheMaxEntries);

    await resolveSlackConversationInfo({
      cfg,
      channelId: `C${cacheMaxEntries.toString().padStart(8, "0")}`,
    });
    expect(conversationsInfoMock).toHaveBeenCalledTimes(cacheMaxEntries + 1);

    await resolveSlackConversationInfo({
      cfg,
      channelId: "C00000001",
    });
    expect(conversationsInfoMock).toHaveBeenCalledTimes(cacheMaxEntries + 2);

    await resolveSlackConversationInfo({
      cfg,
      channelId: "C00000000",
    });
    expect(conversationsInfoMock).toHaveBeenCalledTimes(cacheMaxEntries + 2);
  });

  it("preserves the channel-type wrapper contract", async () => {
    conversationsInfoMock.mockResolvedValueOnce({
      channel: {
        id: "G123",
        is_mpim: true,
      },
    });

    await expect(
      resolveSlackChannelType({
        cfg: {
          channels: {
            slack: {
              botToken: "xoxb-test",
            },
          },
        } as never,
        channelId: "G123",
      }),
    ).resolves.toBe("group");
  });
});
