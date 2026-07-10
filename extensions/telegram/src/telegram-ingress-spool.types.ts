// Telegram plugin module defines ingress spool record contracts.

export type TelegramSpooledUpdateClaimOwner = {
  processId: string;
  processPid: number;
  claimedAt: number;
  claimToken?: string;
};

export type TelegramSpooledUpdate = {
  updateId: number;
  path: string;
  update: unknown;
  receivedAt: number;
  attempts?: number;
  lastAttemptAt?: number;
  lastError?: string;
  claim?: TelegramSpooledUpdateClaimOwner;
};

export type ClaimedTelegramSpooledUpdate = TelegramSpooledUpdate & {
  pendingPath: string;
};
