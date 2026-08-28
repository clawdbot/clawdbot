import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  captureBrowserScreenshot,
  fetchBrowserScreenshotDataUrl,
} from "../../components/browser/browser-client.ts";
import type { ToolCard } from "./chat-types.ts";
import { extractToolCardsCached, resolveToolCardOutcome } from "./tool-cards.ts";

export function browserTabCardRevision(card: ToolCard): string | undefined {
  return card.callId ?? card.messageId ?? card.previewRevision;
}

export function latestBrowserTabCards(
  messages: readonly unknown[],
  toolMessages: readonly unknown[],
): ReadonlyMap<string, string> {
  const latest = new Map<string, string>();
  // History precedes the current live stream. Select before search/virtualization
  // so expanding an old row cannot turn it into a new capture request.
  for (const source of [messages, toolMessages]) {
    for (const message of source) {
      if (!isRecord(message)) {
        continue;
      }
      for (const card of extractToolCardsCached(message)) {
        const revision = browserTabCardRevision(card);
        if (
          card.preview?.kind === "browser-tab" &&
          revision &&
          resolveToolCardOutcome(card, false) === "succeeded"
        ) {
          latest.set(card.preview.targetId, revision);
        }
      }
    }
  }
  return latest;
}

type ThumbnailEntry = {
  revisions: Set<string>;
  pending?: Promise<string | undefined>;
};

// Screenshots belong to a connection, never a bare target id shared by Gateways.
// Image eviction keeps attempt receipts: a long transcript must not recapture
// every row on every render once it exceeds the image budget.
const thumbnails = new WeakMap<
  GatewayBrowserClient,
  {
    tabs: Map<string, ThumbnailEntry>;
    images: Map<string, string>;
  }
>();
const MAX_THUMBNAIL_TABS = 32;

export function loadBrowserTabThumbnail(params: {
  client: GatewayBrowserClient;
  targetId: string;
  revision: string;
  resourceBasePath: string;
  authToken: string | null;
}): Promise<string | undefined> {
  let cache = thumbnails.get(params.client);
  if (!cache) {
    cache = { tabs: new Map(), images: new Map() };
    thumbnails.set(params.client, cache);
  }
  const { tabs, images } = cache;
  let entry = tabs.get(params.targetId);
  if (!entry) {
    entry = { revisions: new Set() };
    tabs.set(params.targetId, entry);
  }
  if (entry.revisions.has(params.revision)) {
    return entry.pending ?? Promise.resolve(images.get(params.targetId));
  }
  entry.revisions.add(params.revision);
  // Serialize revisions as well as sharing a revision's flight. A new result
  // must capture after the older flight, and failures count as an attempt.
  const pending = (entry.pending ?? Promise.resolve()).then(async () => {
    try {
      const capture = await captureBrowserScreenshot(params.client, params.targetId);
      const image = await fetchBrowserScreenshotDataUrl({
        resourceBasePath: params.resourceBasePath,
        authToken: params.authToken,
        path: capture.path,
      });
      images.delete(params.targetId);
      images.set(params.targetId, image);
      if (images.size > MAX_THUMBNAIL_TABS) {
        const oldest = images.keys().next().value;
        if (oldest !== undefined) {
          images.delete(oldest);
        }
      }
      return image;
    } catch {
      images.delete(params.targetId);
      return undefined;
    } finally {
      if (entry.pending === pending) {
        entry.pending = undefined;
      }
    }
  });
  entry.pending = pending;
  return pending;
}
