import type { DmPolicy, GroupPolicy, MarkdownConfig } from "clawdbot/plugin-sdk";

// RingCentral Team Messaging API types

export type RingCentralUser = {
  id?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
};

export type RingCentralChat = {
  id?: string;
  name?: string;
  description?: string;
  type?: "Everyone" | "Team" | "Group" | "Personal" | "Direct" | "PersonalChat";
  status?: "Active" | "Archived";
  members?: string[];
  isPublic?: boolean;
  creationTime?: string;
  lastModifiedTime?: string;
};

export type RingCentralPost = {
  id?: string;
  groupId?: string;
  type?: "TextMessage" | "PersonJoined" | "PersonsAdded";
  text?: string;
  creatorId?: string;
  addedPersonIds?: string[];
  creationTime?: string;
  lastModifiedTime?: string;
  attachments?: RingCentralAttachment[];
  activity?: string;
  title?: string;
  iconUri?: string;
  iconEmoji?: string;
  mentions?: RingCentralMention[];
};

export type RingCentralAttachment = {
  id?: string;
  type?: string;
  name?: string;
  contentUri?: string;
  contentType?: string;
  size?: number;
};

export type RingCentralMention = {
  id?: string;
  type?: "Person" | "Team" | "File" | "Link" | "Event" | "Task" | "Note" | "Card";
  name?: string;
};

export type RingCentralWebhookEvent = {
  uuid?: string;
  event?: string;
  timestamp?: string;
  subscriptionId?: string;
  ownerId?: string;
  body?: RingCentralEventBody;
};

export type RingCentralEventBody = {
  id?: string;
  groupId?: string;
  type?: string;
  text?: string;
  creatorId?: string;
  eventType?: "PostAdded" | "PostChanged" | "PostRemoved" | "GroupJoined" | "GroupLeft" | "GroupChanged";
  creationTime?: string;
  lastModifiedTime?: string;
  attachments?: RingCentralAttachment[];
  mentions?: RingCentralMention[];
  name?: string;
  members?: string[];
  status?: string;
};

// Config types

export type RingCentralGroupConfig = {
  chatId?: string;
  requireMention?: boolean;
  allow?: boolean;
  enabled?: boolean;
  users?: Array<string | number>;
  systemPrompt?: string;
};

export type RingCentralAccountConfig = {
  enabled?: boolean;
  name?: string;
  clientId?: string;
  clientSecret?: string;
  jwt?: string;
  server?: string;
  credentialsFile?: string;
  webhookPath?: string;
  webhookVerificationToken?: string;
  markdown?: MarkdownConfig;
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
  dm?: { policy?: DmPolicy; allowFrom?: Array<string | number>; enabled?: boolean };
  groupPolicy?: GroupPolicy;
  groups?: Record<string, RingCentralGroupConfig>;
  groupAllowFrom?: Array<string | number>;
  requireMention?: boolean;
  mediaMaxMb?: number;
  textChunkLimit?: number;
  chunkMode?: "length" | "newline";
  blockStreaming?: boolean;
  blockStreamingCoalesce?: { minChars?: number; idleMs?: number };
  allowBots?: boolean;
  botExtensionId?: string;
  replyToMode?: "off" | "all";
  selfOnly?: boolean; // JWT mode: only accept messages from the JWT user (default: true)
};

export type RingCentralConfig = RingCentralAccountConfig & {
  accounts?: Record<string, RingCentralAccountConfig>;
  defaultAccount?: string;
};
