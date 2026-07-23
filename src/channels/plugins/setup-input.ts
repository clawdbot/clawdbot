type ChannelSetupEnvelope = {
  name?: string;
  token?: string;
  tokenFile?: string;
  useEnv?: boolean;
  defaultTo?: string;
  allowFrom?: string[];
};

/**
 * Compatibility fields with known published readers in the 2026-07-22 registry sweep.
 * Each field is deleted as soon as no published plugin reads it; no version boundary is needed.
 */
type DeprecatedChannelSetupFields = {
  /** @deprecated Declare this field in the owning plugin's setup input type: https://docs.openclaw.ai/plugins/sdk-setup#channel-owned-setup-input-fields. Removed once no published plugin reads it. */
  privateKey?: string;
  /** @deprecated Declare this field in the owning plugin's setup input type: https://docs.openclaw.ai/plugins/sdk-setup#channel-owned-setup-input-fields. Removed once no published plugin reads it. */
  secret?: string;
  /** @deprecated Declare this field in the owning plugin's setup input type: https://docs.openclaw.ai/plugins/sdk-setup#channel-owned-setup-input-fields. Removed once no published plugin reads it. */
  botToken?: string;
  /** @deprecated Declare this field in the owning plugin's setup input type: https://docs.openclaw.ai/plugins/sdk-setup#channel-owned-setup-input-fields. Removed once no published plugin reads it. */
  appToken?: string;
  /** @deprecated Declare this field in the owning plugin's setup input type: https://docs.openclaw.ai/plugins/sdk-setup#channel-owned-setup-input-fields. Removed once no published plugin reads it. */
  signingSecret?: string;
  /** @deprecated Declare this field in the owning plugin's setup input type: https://docs.openclaw.ai/plugins/sdk-setup#channel-owned-setup-input-fields. Removed once no published plugin reads it. */
  mode?: "socket" | "http" | "relay";
  /** @deprecated Declare this field in the owning plugin's setup input type: https://docs.openclaw.ai/plugins/sdk-setup#channel-owned-setup-input-fields. Removed once no published plugin reads it. */
  cliPath?: string;
  /** @deprecated Declare this field in the owning plugin's setup input type: https://docs.openclaw.ai/plugins/sdk-setup#channel-owned-setup-input-fields. Removed once no published plugin reads it. */
  authDir?: string;
  /** @deprecated Declare this field in the owning plugin's setup input type: https://docs.openclaw.ai/plugins/sdk-setup#channel-owned-setup-input-fields. Removed once no published plugin reads it. */
  httpUrl?: string;
  /** @deprecated Declare this field in the owning plugin's setup input type: https://docs.openclaw.ai/plugins/sdk-setup#channel-owned-setup-input-fields. Removed once no published plugin reads it. */
  httpPort?: string;
  /** @deprecated Declare this field in the owning plugin's setup input type: https://docs.openclaw.ai/plugins/sdk-setup#channel-owned-setup-input-fields. Removed once no published plugin reads it. */
  webhookPath?: string;
  /** @deprecated Declare this field in the owning plugin's setup input type: https://docs.openclaw.ai/plugins/sdk-setup#channel-owned-setup-input-fields. Removed once no published plugin reads it. */
  webhookUrl?: string;
  /** @deprecated Declare this field in the owning plugin's setup input type: https://docs.openclaw.ai/plugins/sdk-setup#channel-owned-setup-input-fields. Removed once no published plugin reads it. */
  userId?: string;
  /** @deprecated Declare this field in the owning plugin's setup input type: https://docs.openclaw.ai/plugins/sdk-setup#channel-owned-setup-input-fields. Removed once no published plugin reads it. */
  accessToken?: string;
  /** @deprecated Declare this field in the owning plugin's setup input type: https://docs.openclaw.ai/plugins/sdk-setup#channel-owned-setup-input-fields. Removed once no published plugin reads it. */
  password?: string;
  /** @deprecated Declare this field in the owning plugin's setup input type: https://docs.openclaw.ai/plugins/sdk-setup#channel-owned-setup-input-fields. Removed once no published plugin reads it. */
  deviceName?: string;
  /** @deprecated Declare this field in the owning plugin's setup input type: https://docs.openclaw.ai/plugins/sdk-setup#channel-owned-setup-input-fields. Removed once no published plugin reads it. */
  url?: string;
  /** @deprecated Declare this field in the owning plugin's setup input type: https://docs.openclaw.ai/plugins/sdk-setup#channel-owned-setup-input-fields. Removed once no published plugin reads it. */
  baseUrl?: string;
  /** @deprecated Declare this field in the owning plugin's setup input type: https://docs.openclaw.ai/plugins/sdk-setup#channel-owned-setup-input-fields. Removed once no published plugin reads it. */
  code?: string;
  /** @deprecated Declare this field in the owning plugin's setup input type: https://docs.openclaw.ai/plugins/sdk-setup#channel-owned-setup-input-fields. Removed once no published plugin reads it. */
  groupChannels?: string[];
  /** @deprecated Declare this field in the owning plugin's setup input type: https://docs.openclaw.ai/plugins/sdk-setup#channel-owned-setup-input-fields. Removed once no published plugin reads it. */
  dmAllowlist?: string[];
  /** @deprecated Declare this field in the owning plugin's setup input type: https://docs.openclaw.ai/plugins/sdk-setup#channel-owned-setup-input-fields. Removed once no published plugin reads it. */
  autoDiscoverChannels?: boolean;
};

/** Generic setup envelope used by CLI, onboarding, and channel-owned setup adapters. */
export type ChannelSetupInput = ChannelSetupEnvelope & DeprecatedChannelSetupFields;
