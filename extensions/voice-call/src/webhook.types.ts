// Shared webhook response contract for voice-call providers.

/** HTTP response payload returned by provider webhook handlers. */
export type WebhookResponsePayload = {
  statusCode: number;
  body: string;
  headers?: Record<string, string>;
};
