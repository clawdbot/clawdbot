import { finalizeEvent, type Event, type Relay } from "nostr-tools";

const PROFILE_KIND = 0;
const AGENT_PROFILE_KIND = 10_100;
const PROFILE_QUERY_TIMEOUT_MS = 5_000;
const DEFAULT_CHANNEL_ADD_POLICY = "anyone";
const CHANNEL_ADD_POLICIES = new Set(["anyone", "owner_only", "nobody"]);

type BuzzProfileSyncResult = { status: "unchanged" } | { status: "published"; eventId: string };

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
    return existingTags.map((tag) => tag.slice());
  }
  return [
    ...existingTags.filter((tag) => tag[0] !== "auth").map((tag) => tag.slice()),
    [...authTag],
  ];
}

function hasConfiguredAuthTag(event: Event | undefined, authTag: string[] | undefined): boolean {
  if (!authTag) {
    return true;
  }
  const authTags = event?.tags.filter((tag) => tag[0] === "auth") ?? [];
  return authTags.length === 1 && JSON.stringify(authTags[0]) === JSON.stringify(authTag);
}

function readNonEmptyString(content: Record<string, unknown>, key: string): string | undefined {
  const value = content[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function queryCurrentProfiles(params: {
  relay: Relay;
  publicKey: string;
  signal?: AbortSignal;
}): Promise<Map<number, Event>> {
  params.signal?.throwIfAborted();
  return await new Promise<Map<number, Event>>((resolve, reject) => {
    const latestByKind = new Map<number, Event>();
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
      resolve(latestByKind);
    };
    const onAbort = () => finish(params.signal?.reason ?? new Error("Buzz profile query aborted"));
    params.signal?.addEventListener("abort", onAbort, { once: true });
    state.timeout = setTimeout(
      () => finish(new Error("Timed out querying the Buzz bot profile")),
      PROFILE_QUERY_TIMEOUT_MS,
    );
    state.subscription = params.relay.subscribe(
      [
        { kinds: [PROFILE_KIND], authors: [params.publicKey], limit: 1 },
        { kinds: [AGENT_PROFILE_KIND], authors: [params.publicKey], limit: 1 },
      ],
      {
        onevent: (event) => {
          const current = latestByKind.get(event.kind);
          if (!current || event.created_at > current.created_at) {
            latestByKind.set(event.kind, event);
          }
        },
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

function buildProfileEvent(params: {
  kind: number;
  content: Record<string, unknown>;
  current?: Event;
  tags: string[][];
  secretKey: Uint8Array;
}): Event {
  const now = Math.floor(Date.now() / 1000);
  return finalizeEvent(
    {
      kind: params.kind,
      content: JSON.stringify(params.content),
      created_at: params.current ? Math.max(now, params.current.created_at + 1) : now,
      tags: params.tags,
    },
    params.secretKey,
  );
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

  const currentProfiles = await queryCurrentProfiles(params);
  const currentMetadata = currentProfiles.get(PROFILE_KIND);
  const currentAgentProfile = currentProfiles.get(AGENT_PROFILE_KIND);
  const metadataContent = parseProfileContent(currentMetadata);
  const agentContent = parseProfileContent(currentAgentProfile);
  const resolvedDisplayName =
    readNonEmptyString(metadataContent, "display_name") ??
    readNonEmptyString(agentContent, "display_name") ??
    readNonEmptyString(agentContent, "name") ??
    displayName;
  const events: Event[] = [];

  if (
    metadataContent.display_name !== resolvedDisplayName ||
    !hasConfiguredAuthTag(currentMetadata, params.authTag)
  ) {
    metadataContent.display_name = resolvedDisplayName;
    events.push(
      buildProfileEvent({
        kind: PROFILE_KIND,
        content: metadataContent,
        current: currentMetadata,
        tags: resolveProfileTags(currentMetadata, params.authTag),
        secretKey: params.secretKey,
      }),
    );
  }

  let agentProfileChanged = false;
  if (!readNonEmptyString(agentContent, "name")) {
    agentContent.name = resolvedDisplayName;
    agentProfileChanged = true;
  }
  if (!readNonEmptyString(agentContent, "display_name")) {
    agentContent.display_name = resolvedDisplayName;
    agentProfileChanged = true;
  }
  if (
    typeof agentContent.channel_add_policy !== "string" ||
    !CHANNEL_ADD_POLICIES.has(agentContent.channel_add_policy)
  ) {
    // OpenClaw accepts messages only from configured Bot-role rooms, so allowing
    // room admins to add this public identity does not expand Gateway ingress.
    agentContent.channel_add_policy = DEFAULT_CHANNEL_ADD_POLICY;
    agentProfileChanged = true;
  }
  if (agentProfileChanged) {
    events.push(
      buildProfileEvent({
        kind: AGENT_PROFILE_KIND,
        content: agentContent,
        current: currentAgentProfile,
        tags: currentAgentProfile?.tags.map((tag) => tag.slice()) ?? [],
        secretKey: params.secretKey,
      }),
    );
  }

  if (events.length === 0) {
    return { status: "unchanged" };
  }
  for (const event of events) {
    await params.relay.publish(event);
  }
  const lastEvent = events.at(-1);
  return lastEvent ? { status: "published", eventId: lastEvent.id } : { status: "unchanged" };
}
