/**
 * GitHub Copilot OAuth wire and option types.
 */

export type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  intervalMs: number;
  expiresAt: number;
};

export type DeviceTokenSuccessResponse = {
  access_token: string;
  token_type?: string;
  scope?: string;
};

export type DeviceTokenErrorResponse = {
  error: string;
  error_description?: string;
  interval?: number;
};

export type CopilotModelListEntry = {
  id?: unknown;
  object?: unknown;
  capabilities?: {
    type?: unknown;
  };
};

export type CopilotRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};
