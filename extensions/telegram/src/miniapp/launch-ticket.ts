import crypto from "node:crypto";

const LAUNCH_TICKET_TTL_MS = 5 * 60_000;
const LAUNCH_TICKET_LIMIT = 1000;

type LaunchTicket = {
  accountId: string;
  userId: string;
  expiresAtMs: number;
};

export type TelegramMiniAppLaunchTickets = {
  issue: (params: { accountId: string; userId: string }) => string;
  consume: (params: { ticket: string; accountId: string; userId: string }) => boolean;
};

export function createTelegramMiniAppLaunchTickets(): TelegramMiniAppLaunchTickets {
  const tickets = new Map<string, LaunchTicket>();

  function prune(): void {
    const now = Date.now();
    for (const [ticket, launch] of tickets) {
      if (launch.expiresAtMs <= now) {
        tickets.delete(ticket);
      }
    }
  }

  return {
    issue({ accountId, userId }) {
      prune();
      const ticket = crypto.randomBytes(32).toString("base64url");
      tickets.set(ticket, {
        accountId,
        userId,
        expiresAtMs: Date.now() + LAUNCH_TICKET_TTL_MS,
      });
      while (tickets.size > LAUNCH_TICKET_LIMIT) {
        const oldest = tickets.keys().next().value;
        if (!oldest) {
          break;
        }
        tickets.delete(oldest);
      }
      return ticket;
    },
    consume({ ticket, accountId, userId }) {
      prune();
      const launch = tickets.get(ticket);
      if (!launch || launch.accountId !== accountId || launch.userId !== userId) {
        return false;
      }
      tickets.delete(ticket);
      return true;
    },
  };
}
