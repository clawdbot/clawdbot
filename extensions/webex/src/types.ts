/**
 * Webex channel type definitions
 */

/** Webex channel configuration */
export type WebexConfig = {
  enabled?: boolean;
  defaultAccount?: string;

  // Single account config (legacy/simple mode)
  botToken?: string;
  webhookSecret?: string;
  webhookPath?: string;
  webhookUrl?: string;
  botId?: string;
  botEmail?: string;

  // DM policy
  dm?: WebexDmConfig;

  // Group policy
  groupPolicy?: "disabled" | "allowlist" | "open";

  // Room-specific configs
  rooms?: Record<string, WebexRoomConfig>;

  // Multi-account mode
  accounts?: Record<string, WebexAccountConfig>;
};

export type WebexAccountConfig = {
  enabled?: boolean;
  name?: string;
  botToken?: string;
  webhookSecret?: string;
  webhookPath?: string;
  webhookUrl?: string;
  botId?: string;
  botEmail?: string;
  dm?: WebexDmConfig;
  groupPolicy?: "disabled" | "allowlist" | "open";
  rooms?: Record<string, WebexRoomConfig>;
};

export type WebexDmConfig = {
  policy?: "open" | "pairing" | "allowlist" | "disabled";
  allowFrom?: string[];
};

export type WebexRoomConfig = {
  allow?: boolean;
  requireMention?: boolean;
  systemPrompt?: string;
  users?: string[];
};

/** Resolved account for runtime use */
export type ResolvedWebexAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  config: WebexAccountConfig;
  credentialSource: WebexCredentialSource;
  botToken?: string;
  botId?: string;
  botEmail?: string;
};

export type WebexCredentialSource = "config" | "env" | "none";

/** Webex API types */
export type WebexPerson = {
  id: string;
  emails?: string[];
  displayName?: string;
  nickName?: string;
  firstName?: string;
  lastName?: string;
  avatar?: string;
  orgId?: string;
  created?: string;
  lastModified?: string;
  lastActivity?: string;
  status?: "active" | "inactive" | "OutOfOffice" | "DoNotDisturb" | "meeting" | "presenting" | "call" | "pending" | "unknown";
  type?: "person" | "bot";
};

export type WebexRoom = {
  id: string;
  title?: string;
  type?: "direct" | "group";
  isLocked?: boolean;
  lastActivity?: string;
  creatorId?: string;
  created?: string;
  ownerId?: string;
  teamId?: string;
};

export type WebexMessage = {
  id: string;
  roomId: string;
  roomType?: "direct" | "group";
  text?: string;
  html?: string;
  markdown?: string;
  files?: string[];
  personId: string;
  personEmail?: string;
  mentionedPeople?: string[];
  mentionedGroups?: string[];
  created?: string;
  updated?: string;
  parentId?: string;
  isVoiceClip?: boolean;
  attachments?: WebexAttachment[];
};

export type WebexAttachment = {
  contentType: string;
  content: unknown;
};

export type WebexWebhookEvent = {
  id: string;
  name: string;
  targetUrl: string;
  resource: "messages" | "memberships" | "rooms" | "attachmentActions";
  event: "created" | "updated" | "deleted";
  orgId?: string;
  createdBy?: string;
  appId?: string;
  ownedBy?: string;
  filter?: string;
  status?: "active" | "inactive";
  secret?: string;
  actorId?: string;
  data: WebexWebhookData;
};

export type WebexWebhookData = {
  id: string;
  roomId?: string;
  roomType?: "direct" | "group";
  personId?: string;
  personEmail?: string;
  created?: string;
  mentionedPeople?: string[];
};

export type WebexSendMessageParams = {
  roomId?: string;
  toPersonId?: string;
  toPersonEmail?: string;
  text?: string;
  markdown?: string;
  files?: string[];
  parentId?: string;
  attachments?: WebexAttachment[];
};

export type WebexApiError = {
  message: string;
  trackingId?: string;
  errors?: Array<{ description: string }>;
};

/** Default account ID for single-account mode */
export const DEFAULT_ACCOUNT_ID = "default";
