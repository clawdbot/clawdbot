import type { AgentMailClient } from "agentmail";

import type { AgentMailConfig } from "./utils.js";

/**
 * Checks if a sender email matches any entry in a list.
 * Entries can be exact email addresses or domains.
 */
export function matchesList(senderEmail: string, list: string[]): boolean {
  if (!list || list.length === 0) return false;

  const normalizedSender = senderEmail.toLowerCase().trim();
  const domain = normalizedSender.split("@")[1];

  return list.some((entry) => {
    const normalizedEntry = entry.toLowerCase().trim();
    return (
      normalizedEntry === normalizedSender || // exact email match
      normalizedEntry === domain || // exact domain match
      normalizedSender.endsWith(`@${normalizedEntry}`) // domain suffix match
    );
  });
}

/**
 * Determines if a sender is allowed based on allowFrom config.
 *
 * Logic:
 * 1. If allowFrom is empty → allowed (open mode)
 * 2. If sender matches allowFrom → allowed
 * 3. Otherwise → not allowed
 */
export function checkSenderAllowed(
  senderEmail: string,
  config: Pick<AgentMailConfig, "allowFrom">,
): boolean {
  const { allowFrom = [] } = config;

  // Open mode: all senders allowed when allowFrom is empty
  if (allowFrom.length === 0) {
    return true;
  }

  return matchesList(senderEmail, allowFrom);
}

/**
 * Labels a message as "allowed" via the AgentMail API.
 */
export async function labelMessageAllowed(
  client: AgentMailClient,
  inboxId: string,
  messageId: string,
): Promise<void> {
  await client.inboxes.messages.update(inboxId, messageId, {
    addLabels: ["allowed"],
  });
}
