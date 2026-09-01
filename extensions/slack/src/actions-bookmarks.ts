// Slack channel bookmark operations, split from actions.ts to keep that file
// under the repo max-lines limit. Re-exported by actions.ts so the lazy
// action-runtime module loader resolves them through the actions.js barrel.
import { getClient, type SlackActionClientOpts } from "./actions-client.js";

export type SlackBookmark = {
  id?: string;
  title?: string;
  link?: string;
  emoji?: string;
  type?: string;
  channel_id?: string;
  date_created?: number;
  date_updated?: number;
};

// Slack's bookmarks.add/edit `emoji` field requires a colon-wrapped shortcode
// (e.g. `:pushpin:`); a bare shortcode like `pushpin` is rejected with
// `invalid_emoji`. Unlike reactions.add (which takes a bare name), bookmarks
// only accept the wrapped form, so normalize any caller input here at the
// owner boundary instead of forcing every caller to know the wire format.
function normalizeBookmarkEmoji(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const withoutColons = trimmed.replace(/^:+|:+$/g, "");
  if (!withoutColons) {
    return undefined;
  }
  return `:${withoutColons}:`;
}

export async function addSlackChannelBookmark(
  channelId: string,
  title: string,
  link: string,
  opts: SlackActionClientOpts & { emoji?: string } = {},
): Promise<SlackBookmark> {
  const client = await getClient(opts, "write");
  const emoji = normalizeBookmarkEmoji(opts.emoji);
  const result = await client.bookmarks.add({
    channel_id: channelId,
    title,
    link,
    type: "link",
    ...(emoji ? { emoji } : {}),
  });
  // SAFETY: Slack Web API bookmarks.add returns a Bookmark object whose shape matches SlackBookmark.
  return (result.bookmark ?? {}) as SlackBookmark;
}

export async function listSlackChannelBookmarks(
  channelId: string,
  opts: SlackActionClientOpts = {},
): Promise<SlackBookmark[]> {
  const client = await getClient(opts);
  const result = await client.bookmarks.list({ channel_id: channelId });
  // SAFETY: Slack Web API bookmarks.list returns Bookmark[] whose shape matches SlackBookmark[].
  return (result.bookmarks ?? []) as SlackBookmark[];
}

export async function editSlackChannelBookmark(
  channelId: string,
  bookmarkId: string,
  opts: SlackActionClientOpts & { title?: string; link?: string; emoji?: string } = {},
): Promise<SlackBookmark> {
  const client = await getClient(opts, "write");
  const emoji = normalizeBookmarkEmoji(opts.emoji);
  const result = await client.bookmarks.edit({
    channel_id: channelId,
    bookmark_id: bookmarkId,
    ...(opts.title ? { title: opts.title } : {}),
    ...(opts.link ? { link: opts.link } : {}),
    ...(emoji ? { emoji } : {}),
  });
  // SAFETY: Slack Web API bookmarks.edit returns a Bookmark object whose shape matches SlackBookmark.
  return (result.bookmark ?? {}) as SlackBookmark;
}

export async function removeSlackChannelBookmark(
  channelId: string,
  bookmarkId: string,
  opts: SlackActionClientOpts = {},
): Promise<void> {
  const client = await getClient(opts, "write");
  await client.bookmarks.remove({ channel_id: channelId, bookmark_id: bookmarkId });
}
