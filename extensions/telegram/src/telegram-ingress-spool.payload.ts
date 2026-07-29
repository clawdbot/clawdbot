// Telegram plugin module defines durable ingress queue payload shape.
export type TelegramSpooledUpdatePayload = {
  version: number;
  updateId: number;
  receivedAt: number;
  update: unknown;
};

export const TELEGRAM_SPOOLED_UPDATE_PAYLOAD_VERSION = 1;

export class TelegramIngressPayloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TelegramIngressPayloadError";
  }
}
