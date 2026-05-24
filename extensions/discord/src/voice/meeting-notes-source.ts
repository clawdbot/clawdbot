import type {
  MeetingNotesSourceProviderPlugin,
  MeetingNotesStartRequest,
} from "openclaw/plugin-sdk/meeting-notes";
import type { DiscordVoiceManager } from "./manager.js";

const managersByAccountId = new Map<string, DiscordVoiceManager>();
const managerWaiters = new Set<{
  accountId?: string;
  resolve: () => void;
}>();

export function setDiscordMeetingNotesVoiceManager(params: {
  accountId: string;
  manager: DiscordVoiceManager | null;
}): void {
  if (params.manager) {
    managersByAccountId.set(params.accountId, params.manager);
    for (const waiter of managerWaiters) {
      if (!waiter.accountId || waiter.accountId === params.accountId) {
        waiter.resolve();
      }
    }
  } else {
    managersByAccountId.delete(params.accountId);
  }
}

function resolveManager(request: MeetingNotesStartRequest): DiscordVoiceManager | undefined {
  const accountId = request.session.source.accountId?.trim();
  if (accountId) {
    return managersByAccountId.get(accountId);
  }
  return [...managersByAccountId.values()][0];
}

async function waitForManager(
  request: MeetingNotesStartRequest,
): Promise<DiscordVoiceManager | undefined> {
  const existing = resolveManager(request);
  if (existing) {
    return existing;
  }
  if (request.abortSignal?.aborted) {
    return undefined;
  }
  const startupWaitMs = request.startupWaitMs ?? 0;
  if (startupWaitMs <= 0) {
    return undefined;
  }
  const accountId = request.session.source.accountId?.trim() || undefined;
  await new Promise<void>((resolve) => {
    const waiter = {
      accountId,
      resolve: () => {
        clearTimeout(timer);
        request.abortSignal?.removeEventListener("abort", waiter.resolve);
        managerWaiters.delete(waiter);
        resolve();
      },
    };
    const timer = setTimeout(waiter.resolve, startupWaitMs);
    timer.unref?.();
    request.abortSignal?.addEventListener("abort", waiter.resolve, { once: true });
    managerWaiters.add(waiter);
  });
  if (request.abortSignal?.aborted) {
    return undefined;
  }
  return resolveManager(request);
}

export const discordVoiceMeetingNotesSourceProvider: MeetingNotesSourceProviderPlugin = {
  id: "discord-voice",
  aliases: ["discord"],
  name: "Discord Voice",
  sourceKinds: ["live-audio"],
  async start(request) {
    const manager = await waitForManager(request);
    if (!manager) {
      return { ok: false, error: "Discord voice manager is not available." };
    }
    if (request.abortSignal?.aborted) {
      return { ok: false, error: "Discord meeting notes start aborted." };
    }
    const guildId = request.session.source.guildId?.trim();
    const channelId = request.session.source.channelId?.trim();
    if (!guildId || !channelId) {
      return { ok: false, error: "Discord meeting notes require guildId and channelId." };
    }
    const joined = await manager.join(
      { guildId, channelId },
      {
        meetingNotes: {
          sessionId: request.session.sessionId,
          onUtterance: request.onUtterance,
        },
      },
    );
    if (!joined.ok) {
      return { ok: false, error: joined.message };
    }
    return { ok: true, session: request.session };
  },
  async stop(request) {
    const accountId = request.source.accountId?.trim();
    const manager = accountId
      ? managersByAccountId.get(accountId)
      : [...managersByAccountId.values()][0];
    if (!manager) {
      return { ok: false, error: "Discord voice manager is not available." };
    }
    const guildId = request.source.guildId?.trim();
    if (!guildId) {
      return { ok: false, error: "Discord meeting notes require guildId." };
    }
    const result = await manager.leave(
      {
        guildId,
        channelId: request.source.channelId,
      },
      {
        meetingNotesSessionId: request.sessionId,
      },
    );
    if (!result.ok) {
      return { ok: false, error: result.message };
    }
    return { ok: true, sessionId: request.sessionId, stoppedAt: new Date().toISOString() };
  },
  async status(source) {
    const accountId = source.accountId?.trim();
    const manager = accountId
      ? managersByAccountId.get(accountId)
      : [...managersByAccountId.values()][0];
    return (
      manager?.status().map((entry) => ({
        active: entry.ok,
        message: entry.message,
        source: {
          providerId: "discord-voice",
          accountId,
          guildId: entry.guildId,
          channelId: entry.channelId,
        },
      })) ?? []
    );
  },
};
