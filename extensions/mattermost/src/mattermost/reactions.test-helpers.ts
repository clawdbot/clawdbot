// Mattermost helper module supports reactions helpers behavior.
import { expect, vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import type { MattermostFetch } from "./client.js";

export function requestUrl(url: string | URL | Request): string {
  if (typeof url === "string") {
    return url;
  }
  if (url instanceof URL) {
    return url.toString();
  }
  return url.url;
}

let testConfigSequence = 0;

export function createMattermostTestConfig(
  cacheKey = String(++testConfigSequence),
): OpenClawConfig {
  return {
    channels: {
      mattermost: {
        enabled: true,
        botToken: `test-token-${cacheKey}`,
        baseUrl: `https://${cacheKey}.chat.example.com`,
      },
    },
  };
}

export function createMattermostReactionFetchMock(params: {
  postId: string;
  emojiName: string;
  mode: "add" | "remove" | "both";
  userId?: string;
  postChannelId?: string | null;
  channelType?: string;
  channelName?: string;
  status?: number;
  body?: unknown;
}) {
  const userId = params.userId ?? "BOT123";
  const mode = params.mode;
  const allowAdd = mode === "add" || mode === "both";
  const allowRemove = mode === "remove" || mode === "both";
  const addStatus = params.status ?? 201;
  const removeStatus = params.status ?? 204;
  const removePath = `/api/v4/users/${userId}/posts/${params.postId}/reactions/${encodeURIComponent(params.emojiName)}`;

  return vi.fn<typeof fetch>(async (url, init) => {
    const urlText = requestUrl(url);
    if (params.postChannelId !== undefined && urlText.endsWith(`/api/v4/posts/${params.postId}`)) {
      return new Response(JSON.stringify({ id: params.postId, channel_id: params.postChannelId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (urlText.endsWith("/api/v4/users/me")) {
      return new Response(JSON.stringify({ id: userId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (params.postChannelId && urlText.endsWith(`/api/v4/channels/${params.postChannelId}`)) {
      return new Response(
        JSON.stringify({
          id: params.postChannelId,
          type: params.channelType ?? "O",
          name: params.channelName ?? "fixture-channel",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (allowAdd && urlText.endsWith("/api/v4/reactions")) {
      expect(init?.method).toBe("POST");
      const requestBody = init?.body;
      if (typeof requestBody !== "string") {
        throw new Error("expected string POST body");
      }
      expect(JSON.parse(requestBody)).toEqual({
        user_id: userId,
        post_id: params.postId,
        emoji_name: params.emojiName,
      });

      const responseBody = params.body === undefined ? { ok: true } : params.body;
      return new Response(
        responseBody === null ? null : JSON.stringify(responseBody),
        responseBody === null
          ? { status: addStatus, headers: { "content-type": "text/plain" } }
          : { status: addStatus, headers: { "content-type": "application/json" } },
      );
    }

    if (allowRemove && urlText.endsWith(removePath)) {
      expect(init?.method).toBe("DELETE");
      const responseBody = params.body === undefined ? null : params.body;
      return new Response(
        responseBody === null ? null : JSON.stringify(responseBody),
        responseBody === null
          ? { status: removeStatus, headers: { "content-type": "text/plain" } }
          : { status: removeStatus, headers: { "content-type": "application/json" } },
      );
    }

    throw new Error(`unexpected url: ${urlText}`);
  });
}

export async function withMockedGlobalFetch<T>(
  fetchImpl: MattermostFetch,
  run: () => Promise<T>,
): Promise<T> {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = prevFetch;
  }
}
