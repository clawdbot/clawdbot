// Slack plugin module implements prepare thread context root behavior.
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

type SlackBotAuthorIdentity = {
  botUserId?: string;
  botId?: string;
};

type SlackThreadAuthorTuple = {
  userId?: string;
  botId?: string;
};

type SlackThreadRootCandidate = SlackThreadAuthorTuple & {
  text?: string;
  ts?: string;
};

type SlackThreadHistoryFilterPolicy = {
  retainCurrentBotRootTs?: string;
};

type SlackThreadHistoryFilterResult<T> = {
  kept: T[];
  omittedCurrentBot: number;
};

export function isSlackThreadAuthorCurrentBot(params: {
  identity: SlackBotAuthorIdentity;
  author: SlackThreadAuthorTuple;
}): boolean {
  const { identity, author } = params;
  if (identity.botUserId && author.userId && author.userId === identity.botUserId) {
    return true;
  }
  if (identity.botId && author.botId && author.botId === identity.botId) {
    return true;
  }
  return false;
}

export function resolveSlackThreadHistoryFilterPolicy(params: {
  includeBotStarterAsRootContext: boolean;
  starterTs?: string;
}): SlackThreadHistoryFilterPolicy {
  if (!params.includeBotStarterAsRootContext || !params.starterTs) {
    return {};
  }
  return {
    retainCurrentBotRootTs: params.starterTs,
  };
}

export function applySlackThreadHistoryFilterPolicy<T extends SlackThreadRootCandidate>(params: {
  history: T[];
  policy: SlackThreadHistoryFilterPolicy;
  identity: SlackBotAuthorIdentity;
}): SlackThreadHistoryFilterResult<T> {
  const kept: T[] = [];
  let omittedCurrentBot = 0;
  for (const entry of params.history) {
    const isCurrentBot = isSlackThreadAuthorCurrentBot({
      identity: params.identity,
      author: entry,
    });
    if (!isCurrentBot) {
      kept.push(entry);
      continue;
    }
    if (params.policy.retainCurrentBotRootTs && entry.ts === params.policy.retainCurrentBotRootTs) {
      kept.push(entry);
    } else {
      omittedCurrentBot += 1;
    }
  }
  return { kept, omittedCurrentBot };
}

export function shouldIncludeBotThreadStarterContext(params: {
  starterIsCurrentBot: boolean;
  isNewThreadSession: boolean;
  hasStarterText: boolean;
}): boolean {
  if (!params.hasStarterText) {
    return false;
  }
  return params.starterIsCurrentBot && params.isNewThreadSession;
}

export function ensureSlackThreadHistoryHasBotRoot<T extends SlackThreadRootCandidate>(params: {
  history: T[];
  includeBotStarterAsRootContext: boolean;
  threadStarter: (T & { ts: string }) | null;
}): T[] {
  if (!params.includeBotStarterAsRootContext || !params.threadStarter?.text) {
    return params.history;
  }
  if (params.history.some((entry) => entry.ts === params.threadStarter?.ts)) {
    return params.history;
  }
  return [params.threadStarter, ...params.history];
}

export function formatSlackBotStarterThreadLabel(params: {
  roomLabel: string;
  starterText?: string;
}): string {
  const base = `Slack thread ${params.roomLabel}`;
  if (!params.starterText) {
    return base;
  }
  const snippet = formatSlackThreadLabelSnippet(params.starterText).trim();
  if (!snippet) {
    return base;
  }
  return `${base} (assistant root): ${snippet}`;
}

export function formatSlackThreadLabelSnippet(text: string): string {
  return truncateUtf16Safe(text.replace(/\s+/g, " "), 80);
}
