/**
 * Minimal public surface we depend on from the Microsoft SDK types.
 *
 * Note: we intentionally avoid coupling to SDK classes with private members
 * (like TurnContext) in our own public signatures. The SDK's TS surface is also
 * stricter than what the runtime accepts (e.g. it allows plain activity-like
 * objects), so we model the minimal structural shape we rely on.
 */

export type MSTeamsActivity = {
  type: string;
  id?: string;
  timestamp?: string;
  localTimestamp?: string;
  channelId?: string;
  from?: { id?: string; name?: string; aadObjectId?: string; role?: string };
  conversation?: {
    id?: string;
    conversationType?: string;
    tenantId?: string;
    name?: string;
    isGroup?: boolean;
  };
  recipient?: { id?: string; name?: string };
  text?: string;
  textFormat?: string;
  locale?: string;
  serviceUrl?: string;
  channelData?: {
    team?: { id?: string; name?: string };
    channel?: { id?: string; name?: string };
    tenant?: { id?: string };
    [key: string]: unknown;
  };
  attachments?: Array<{
    contentType?: string;
    contentUrl?: string;
    content?: unknown;
    name?: string;
    thumbnailUrl?: string;
  }>;
  entities?: Array<Record<string, unknown>>;
  value?: unknown;
  name?: string;
  membersAdded?: Array<{ id?: string; name?: string }>;
  membersRemoved?: Array<{ id?: string; name?: string }>;
  replyToId?: string;
  [key: string]: unknown;
};

export type MSTeamsTurnContext = {
  activity: MSTeamsActivity;
  sendActivity: (textOrActivity: string | object) => Promise<unknown>;
  sendActivities: (
    activities: Array<{ type: string } & Record<string, unknown>>,
  ) => Promise<unknown>;
  updateActivity: (activity: object) => Promise<{ id?: string } | void>;
  deleteActivity: (activityId: string) => Promise<void>;
};
