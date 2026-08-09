import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { createMattermostTestConfig, requestUrl } from "./reactions.test-helpers.js";
import { readMattermostMessages } from "./read.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 403 ? "Forbidden" : "OK",
    headers: { "content-type": "application/json" },
  });
}

function createReadFetch(params?: { channelType?: string; postStatus?: number }) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = requestUrl(input);
    const channelMatch = url.match(/\/api\/v4\/channels\/([^/?]+)$/);
    if (channelMatch) {
      return jsonResponse({ id: channelMatch[1], type: params?.channelType ?? "O" });
    }
    if (url.includes("/api/v4/channels/") && url.includes("/posts?")) {
      if (params?.postStatus === 403) {
        return jsonResponse({ message: "You do not have the appropriate permissions." }, 403);
      }
      return jsonResponse({
        order: ["post-2", "post-1"],
        posts: {
          "post-1": { id: "post-1", channel_id: "CURRENT", message: "older", create_at: 1_000 },
          "post-2": { id: "post-2", channel_id: "CURRENT", message: "newer", create_at: 2_000 },
        },
      });
    }
    throw new Error(`Unexpected Mattermost request: ${url}`);
  });
}

function delegatedContext(currentChannelId = "channel:CURRENT") {
  return {
    conversationReadOrigin: "delegated" as const,
    requesterAccountId: "default",
    toolContext: {
      currentChannelProvider: "mattermost",
      currentChannelId,
    },
  };
}

describe("readMattermostMessages", () => {
  it("reads the exact current conversation without a metadata round trip", async () => {
    const fetchImpl = createReadFetch();

    const result = await readMattermostMessages({
      cfg: createMattermostTestConfig("read-current"),
      channelId: "CURRENT",
      limit: 2,
      accountId: "default",
      context: delegatedContext(),
      fetchImpl,
    });

    expect(result.messages.map((message) => message.id)).toEqual(["post-2", "post-1"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requestUrl(fetchImpl.mock.calls[0]![0])).toContain("/channels/CURRENT/posts?per_page=2");
  });

  it("allows a configured delegated cross-channel read", async () => {
    const cfg = createMattermostTestConfig("read-configured") as OpenClawConfig;
    cfg.channels!.mattermost!.groupPolicy = "allowlist";
    cfg.channels!.mattermost!.groups = { OTHER: { requireMention: false } };
    const fetchImpl = createReadFetch();

    await expect(
      readMattermostMessages({
        cfg,
        channelId: "OTHER",
        accountId: "default",
        context: delegatedContext(),
        fetchImpl,
      }),
    ).resolves.toMatchObject({ messages: [{ id: "post-2" }, { id: "post-1" }] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("allows an unlisted member channel only when groupPolicy is open", async () => {
    const cfg = createMattermostTestConfig("read-open") as OpenClawConfig;
    cfg.channels!.mattermost!.groupPolicy = "open";
    const fetchImpl = createReadFetch();

    await expect(
      readMattermostMessages({
        cfg,
        channelId: "OTHER",
        accountId: "default",
        context: delegatedContext(),
        fetchImpl,
      }),
    ).resolves.toMatchObject({ messages: [{ id: "post-2" }, { id: "post-1" }] });
  });

  it.each([
    {
      label: "open policy",
      providerConfig: { groupPolicy: "open" as const },
    },
    {
      label: "allowlisted groups",
      providerConfig: {
        groupPolicy: "allowlist" as const,
        groups: { OTHER: { requireMention: false } },
      },
    },
  ])("inherits provider-level $label for a named account", async ({ providerConfig }) => {
    const cfg = createMattermostTestConfig("read-named-inheritance") as OpenClawConfig;
    Object.assign(cfg.channels!.mattermost!, providerConfig, {
      accounts: { work: { enabled: true } },
    });
    const fetchImpl = createReadFetch();

    await expect(
      readMattermostMessages({
        cfg,
        channelId: "OTHER",
        accountId: "work",
        context: {
          ...delegatedContext(),
          requesterAccountId: "work",
        },
        fetchImpl,
      }),
    ).resolves.toMatchObject({ messages: [{ id: "post-2" }, { id: "post-1" }] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("denies unconfigured and direct-message cross-channel targets before reading posts", async () => {
    for (const channelType of ["O", "D"]) {
      const fetchImpl = createReadFetch({ channelType });
      await expect(
        readMattermostMessages({
          cfg: createMattermostTestConfig(`read-denied-${channelType}`),
          channelId: "OTHER",
          accountId: "default",
          context: delegatedContext(),
          fetchImpl,
        }),
      ).rejects.toThrow("Mattermost read target channel is not allowed");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects delegated account switching before provider access", async () => {
    const fetchImpl = createReadFetch();

    await expect(
      readMattermostMessages({
        cfg: createMattermostTestConfig("read-account-switch"),
        channelId: "OTHER",
        accountId: "default",
        context: {
          ...delegatedContext(),
          requesterAccountId: "other-account",
        },
        fetchImpl,
      }),
    ).rejects.toThrow("Mattermost delegated reads require the current Mattermost account");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses the trusted native channel ID for the current DM", async () => {
    const fetchImpl = createReadFetch();

    const result = await readMattermostMessages({
      cfg: createMattermostTestConfig("read-current-dm"),
      channelId: "CURRENT",
      accountId: "default",
      context: {
        ...delegatedContext(),
        toolContext: {
          currentChannelProvider: "mattermost",
          currentChannelId: "channel:CURRENT",
          currentMessagingTarget: "user:PEER",
        },
      },
      fetchImpl,
    });

    expect(result.messages.map((message) => message.id)).toEqual(["post-2", "post-1"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requestUrl(fetchImpl.mock.calls[0]![0])).toContain("/channels/CURRENT/posts?");
  });

  it("fails closed when the trusted native channel ID names another conversation", async () => {
    const fetchImpl = createReadFetch();

    await expect(
      readMattermostMessages({
        cfg: createMattermostTestConfig("read-conflicting-current"),
        channelId: "CURRENT",
        accountId: "default",
        context: {
          ...delegatedContext(),
          toolContext: {
            currentChannelProvider: "mattermost",
            currentChannelId: "channel:OTHER",
            currentMessagingTarget: "channel:CURRENT",
          },
        },
        fetchImpl,
      }),
    ).rejects.toThrow("Mattermost read target channel is not allowed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("lets a direct operator rely on Mattermost membership and preserves 403 errors", async () => {
    const fetchImpl = createReadFetch({ postStatus: 403 });

    await expect(
      readMattermostMessages({
        cfg: createMattermostTestConfig("read-forbidden"),
        channelId: "OTHER",
        accountId: "default",
        context: { conversationReadOrigin: "direct-operator" },
        fetchImpl,
      }),
    ).rejects.toThrow("Mattermost API 403 Forbidden: You do not have the appropriate permissions.");
  });

  it("rejects disabled accounts before provider access", async () => {
    const cfg = createMattermostTestConfig("read-disabled") as OpenClawConfig;
    cfg.channels!.mattermost!.enabled = false;
    const fetchImpl = createReadFetch();

    await expect(
      readMattermostMessages({
        cfg,
        channelId: "CURRENT",
        accountId: "default",
        context: delegatedContext(),
        fetchImpl,
      }),
    ).rejects.toThrow('Mattermost account "default" is disabled');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
