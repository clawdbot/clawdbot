import type { AgentMail } from "agentmail";
import type { z } from "zod";

import type { AgentMailConfigSchema } from "./config-schema.js";

/** AgentMail channel configuration. */
export type AgentMailConfig = z.infer<typeof AgentMailConfigSchema>;

/** Core config shape with AgentMail channel. */
export type CoreConfig = {
  channels?: {
    agentmail?: AgentMailConfig;
  };
  session?: {
    store?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

/** Resolved AgentMail account with runtime state. */
export type ResolvedAgentMailAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  config: AgentMailConfig;
  inboxId?: string;
};

/** SDK Message type alias. */
export type Message = AgentMail.messages.Message;

/** Re-export SDK webhook event type. */
export type MessageReceivedEvent = AgentMail.events.MessageReceivedEvent;

/** Formats a date as a UTC string. */
export function formatUtcDate(date: Date | string | number): string {
  return new Date(date).toUTCString().replace("GMT", "UTC");
}

/**
 * Parses email address from a "from" string.
 * Handles formats: "email@example.com" or "Display Name <email@example.com>"
 */
export function parseEmailFromAddress(from: string): string {
  // Match email in angle brackets: "Display Name <email@example.com>"
  const bracketMatch = /<([^>]+)>/.exec(from);
  if (bracketMatch?.[1]) {
    return bracketMatch[1].toLowerCase();
  }
  // Otherwise assume the whole string is the email
  return from.trim().toLowerCase();
}

/**
 * Parses display name from a "from" string.
 * Returns email local part if no display name.
 */
export function parseNameFromAddress(from: string): string {
  // Match display name before angle brackets
  const nameMatch = /^([^<]+)</.exec(from);
  if (nameMatch?.[1]) {
    return nameMatch[1].trim();
  }
  // Fall back to email local part
  const email = parseEmailFromAddress(from);
  return email.split("@")[0] || email;
}
