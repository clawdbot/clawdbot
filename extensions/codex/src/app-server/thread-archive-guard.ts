import { isJsonObject, type CodexThreadListParams } from "./protocol.js";
import type { CodexAppServerBindingStore } from "./session-binding.js";

const DESCENDANT_PAGE_LIMIT = 100;
const MAX_DESCENDANT_PAGES = 100;
const MAX_THREAD_ID_LENGTH = 256;
const MAX_CURSOR_LENGTH = 4096;

function readBoundedId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized && normalized.length <= MAX_THREAD_ID_LENGTH ? normalized : undefined;
}

function readNextCursor(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim() || value.length > MAX_CURSOR_LENGTH) {
    throw new Error("Codex app-server returned an invalid descendant-list cursor");
  }
  return value;
}

/**
 * Native archive includes the spawned subtree. Enumerate that same subtree first so an
 * OpenClaw-owned descendant cannot be stopped as an undocumented side effect.
 */
export async function assertCodexArchiveDescendantsUnowned(params: {
  bindingStore: CodexAppServerBindingStore;
  threadId: string;
  listPage: (request: CodexThreadListParams) => Promise<unknown>;
  assertDescendantIdle: (threadId: string) => Promise<void>;
}): Promise<void> {
  const ancestorThreadId = readBoundedId(params.threadId);
  if (!ancestorThreadId) {
    throw new Error("cannot verify Codex archive descendants for an invalid thread id");
  }

  const seenCursors = new Set<string>();
  const seenThreadIds = new Set<string>([ancestorThreadId]);
  let cursor: string | undefined;

  for (let pageIndex = 0; pageIndex < MAX_DESCENDANT_PAGES; pageIndex += 1) {
    const response = await params.listPage({
      ancestorThreadId,
      archived: false,
      limit: DESCENDANT_PAGE_LIMIT,
      sortKey: "created_at",
      sortDirection: "desc",
      useStateDbOnly: true,
      ...(cursor ? { cursor } : {}),
    });
    if (!isJsonObject(response) || !Array.isArray(response.data)) {
      throw new Error("Codex app-server returned an invalid descendant-list response");
    }
    if (response.data.length > DESCENDANT_PAGE_LIMIT) {
      throw new Error("Codex app-server exceeded the descendant-list page limit");
    }

    for (const value of response.data) {
      if (!isJsonObject(value)) {
        throw new Error("Codex app-server returned an invalid descendant thread");
      }
      const descendantThreadId = readBoundedId(value.id);
      if (!descendantThreadId) {
        throw new Error("Codex app-server returned a descendant without a valid thread id");
      }
      if (seenThreadIds.has(descendantThreadId)) {
        throw new Error("Codex app-server returned a cyclic descendant thread list");
      }
      seenThreadIds.add(descendantThreadId);
      await params.assertDescendantIdle(descendantThreadId);
      if (await params.bindingStore.hasOtherThreadOwner(descendantThreadId)) {
        throw new Error(
          "cannot archive a Codex thread while a spawned descendant is owned by an OpenClaw session",
        );
      }
    }

    const nextCursor = readNextCursor(response.nextCursor);
    if (!nextCursor) {
      return;
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error("Codex app-server returned a repeated descendant-list cursor");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw new Error("Codex descendant enumeration exceeded its safety limit");
}
