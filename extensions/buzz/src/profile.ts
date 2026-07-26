import { finalizeEvent, type Event, type Relay } from "nostr-tools";

const PROFILE_KIND = 0;
const PROFILE_QUERY_TIMEOUT_MS = 5_000;

export type BuzzProfileSyncResult =
  | { status: "unchanged" }
  | { status: "published"; eventId: string };

function parseProfileContent(event: Event | undefined): Record<string, unknown> {
  if (!event) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(event.content);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? { ...parsed }
      : {};
  } catch {
    return {};
  }
}

function resolveProfileTags(event: Event | undefined, authTag: string[] | undefined): string[][] {
  const existingTags = event?.tags ?? [];
  if (!authTag) {
    return existingTags.map((tag) => [...tag]);
  }
  return [...existingTags.filter((tag) => tag[0] !== "auth").map((tag) => [...tag]), [...authTag]];
}

function hasConfiguredAuthTag(event: Event | undefined, authTag: string[] | undefined): boolean {
  if (!authTag) {
    return true;
  }
  const authTags = event?.tags.filter((tag) => tag[0] === "auth") ?? [];
  return authTags.length === 1 && JSON.stringify(authTags[0]) === JSON.stringify(authTag);
}

async function queryCurrentProfile(params: {
  relay: Relay;
  publicKey: string;
  signal?: AbortSignal;
}): Promise<Event | undefined> {
  params.signal?.throwIfAborted();
  return await new Promise<Event | undefined>((resolve, reject) => {
    const events: Event[] = [];
    const state: {
      settled: boolean;
      timeout?: ReturnType<typeof setTimeout>;
      subscription?: ReturnType<Relay["subscribe"]>;
    } = { settled: false };
    const finish = (error?: unknown) => {
      if (state.settled) {
        return;
      }
      state.settled = true;
      if (state.timeout) {
        clearTimeout(state.timeout);
      }
      params.signal?.removeEventListener("abort", onAbort);
      state.subscription?.close("profile query complete");
      if (error !== undefined) {
        reject(
          error instanceof Error ? error : new Error("Buzz profile query failed", { cause: error }),
        );
        return;
      }
      resolve(
        events.reduce<Event | undefined>(
          (latest, event) => (!latest || event.created_at > latest.created_at ? event : latest),
          undefined,
        ),
      );
    };
    const onAbort = () => finish(params.signal?.reason ?? new Error("Buzz profile query aborted"));
    params.signal?.addEventListener("abort", onAbort, { once: true });
    state.timeout = setTimeout(
      () => finish(new Error("Timed out querying the Buzz bot profile")),
      PROFILE_QUERY_TIMEOUT_MS,
    );
    state.subscription = params.relay.subscribe(
      [{ kinds: [PROFILE_KIND], authors: [params.publicKey], limit: 1 }],
      {
        onevent: (event) => events.push(event),
        oneose: () => finish(),
        onclose: (reason) => {
          if (reason !== "profile query complete") {
            finish(new Error(`Buzz profile query closed: ${reason}`));
          }
        },
      },
    );
    if (state.settled) {
      state.subscription.close("profile query complete");
    }
  });
}

export async function syncBuzzProfile(params: {
  relay: Relay;
  secretKey: Uint8Array;
  publicKey: string;
  displayName: string;
  authTag?: string[];
  signal?: AbortSignal;
}): Promise<BuzzProfileSyncResult> {
  const displayName = params.displayName.trim();
  if (!displayName) {
    return { status: "unchanged" };
  }

  const current = await queryCurrentProfile(params);
  const content = parseProfileContent(current);
  if (content.display_name === displayName && hasConfiguredAuthTag(current, params.authTag)) {
    return { status: "unchanged" };
  }

  content.display_name = displayName;
  const now = Math.floor(Date.now() / 1000);
  const event = finalizeEvent(
    {
      kind: PROFILE_KIND,
      content: JSON.stringify(content),
      created_at: current ? Math.max(now, current.created_at + 1) : now,
      tags: resolveProfileTags(current, params.authTag),
    },
    params.secretKey,
  );
  await params.relay.publish(event);
  return { status: "published", eventId: event.id };
}
