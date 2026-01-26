import { z } from "zod";
import { buildChannelConfigSchema } from "clawdbot/plugin-sdk";

const ShipSchema = z.string().min(1);
const ChannelNestSchema = z.string().min(1);

export const TlonChannelRuleSchema = z.object({
  mode: z.enum(["restricted", "open"]).optional(),
  allowedShips: z.array(ShipSchema).optional(),
});

export const TlonAuthorizationSchema = z.object({
  channelRules: z.record(z.string(), TlonChannelRuleSchema).optional(),
});

export const TlonAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  ship: ShipSchema.optional(),
  url: z.string().optional(),
  code: z.string().optional(),
  groupChannels: z.array(ChannelNestSchema).optional(),
  dmAllowlist: z.array(ShipSchema).optional(),
  autoDiscoverChannels: z.boolean().optional(),
  showModelSignature: z.boolean().optional(),
});

export const TlonConfigSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  ship: ShipSchema.optional(),
  url: z.string().optional(),
  code: z.string().optional(),
  groupChannels: z.array(ChannelNestSchema).optional(),
  dmAllowlist: z.array(ShipSchema).optional(),
  autoDiscoverChannels: z.boolean().optional(),
  showModelSignature: z.boolean().optional(),
  authorization: TlonAuthorizationSchema.optional(),
  defaultAuthorizedShips: z.array(ShipSchema).optional(),
  accounts: z.record(z.string(), TlonAccountSchema).optional(),
});

export const tlonChannelConfigSchema = buildChannelConfigSchema(TlonConfigSchema);
