// Real-behavior proof for Slack channel bookmarks.
// Drives the real actions.ts functions against a recording WebClient stand-in
// so the bookmarks.add/list/edit/remove wire calls and their arguments are
// captured end-to-end (not just the action-runtime dispatch mock).
import { describe, expect, it } from "vitest";
import {
  addSlackChannelBookmark,
  editSlackChannelBookmark,
  listSlackChannelBookmarks,
  removeSlackChannelBookmark,
} from "./actions.js";

type WireCall = {
  method: string;
  args: Record<string, unknown>;
};

function createRecordingBookmarksClient(): {
  client: { bookmarks: Record<string, (args: unknown) => Promise<unknown>> };
  calls: WireCall[];
} {
  const calls: WireCall[] = [];
  const record = (method: string, args: Record<string, unknown>) => {
    calls.push({ method, args });
  };
  const client = {
    bookmarks: {
      add: async (args: Record<string, unknown>) => {
        record("bookmarks.add", args);
        return { ok: true, bookmark: { id: "B001", title: args.title, link: args.link } };
      },
      list: async (args: Record<string, unknown>) => {
        record("bookmarks.list", args);
        return {
          ok: true,
          bookmarks: [{ id: "B001", title: "Runbook", link: "https://example.com" }],
        };
      },
      edit: async (args: Record<string, unknown>) => {
        record("bookmarks.edit", args);
        return { ok: true, bookmark: { id: args.bookmark_id, title: args.title } };
      },
      remove: async (args: Record<string, unknown>) => {
        record("bookmarks.remove", args);
        return { ok: true };
      },
    },
  };
  return { client, calls };
}

describe("Slack channel bookmark actions wire calls", () => {
  it("calls bookmarks.add with channel_id, title, link, and type=link", async () => {
    const { client, calls } = createRecordingBookmarksClient();
    const bookmark = await addSlackChannelBookmark("C123", "Runbook", "https://example.com", {
      client: client as never,
      emoji: "bookmark",
    });

    expect(calls).toEqual([
      {
        method: "bookmarks.add",
        args: {
          channel_id: "C123",
          title: "Runbook",
          link: "https://example.com",
          type: "link",
          emoji: "bookmark",
        },
      },
    ]);
    expect(bookmark).toEqual({ id: "B001", title: "Runbook", link: "https://example.com" });
  });

  it("calls bookmarks.list with channel_id", async () => {
    const { client, calls } = createRecordingBookmarksClient();
    const bookmarks = await listSlackChannelBookmarks("C123", { client: client as never });

    expect(calls).toEqual([{ method: "bookmarks.list", args: { channel_id: "C123" } }]);
    expect(bookmarks).toEqual([{ id: "B001", title: "Runbook", link: "https://example.com" }]);
  });

  it("calls bookmarks.edit with channel_id, bookmark_id, and patched fields", async () => {
    const { client, calls } = createRecordingBookmarksClient();
    const bookmark = await editSlackChannelBookmark("C123", "B001", {
      client: client as never,
      title: "Updated",
      emoji: "rotating_light",
    });

    expect(calls).toEqual([
      {
        method: "bookmarks.edit",
        args: {
          channel_id: "C123",
          bookmark_id: "B001",
          title: "Updated",
          emoji: "rotating_light",
        },
      },
    ]);
    expect(bookmark).toEqual({ id: "B001", title: "Updated" });
  });

  it("calls bookmarks.remove with channel_id and bookmark_id", async () => {
    const { client, calls } = createRecordingBookmarksClient();
    await removeSlackChannelBookmark("C123", "B001", { client: client as never });

    expect(calls).toEqual([
      { method: "bookmarks.remove", args: { channel_id: "C123", bookmark_id: "B001" } },
    ]);
  });

  it("omits emoji from bookmarks.add when not provided", async () => {
    const { client, calls } = createRecordingBookmarksClient();
    await addSlackChannelBookmark("C123", "Runbook", "https://example.com", {
      client: client as never,
    });

    expect(calls[0]?.args).not.toHaveProperty("emoji");
  });
});
