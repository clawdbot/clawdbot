/** Host fallback secret contracts for external channels without contract artifacts. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getOfficialExternalChannelSecretContract,
  getOfficialExternalPluginCatalogManifest,
  listOfficialExternalChannelCatalogEntries,
} from "../plugins/official-external-plugin-catalog.js";
import {
  createChannelSecretTargetRegistryEntries,
  getChannelRecord,
} from "./channel-secret-basic-runtime.js";
import {
  collectSecretInputAssignment,
  isChannelAccountEffectivelyEnabled,
  isEnabledFlag,
  type ResolverContext,
  type SecretDefaults,
} from "./runtime-shared.js";
import { isRecord } from "./shared.js";
import type { SecretTargetRegistryEntry } from "./target-registry-types.js";

type OfficialExternalChannelSecretContractApi = {
  collectRuntimeConfigAssignments: (params: {
    config: OpenClawConfig;
    defaults: SecretDefaults | undefined;
    context: ResolverContext;
  }) => void;
  secretTargetRegistryEntries: readonly SecretTargetRegistryEntry[];
};

function hasActivationValue(params: {
  record: Record<string, unknown>;
  activationField?: string;
  activationEnv?: string;
  env: NodeJS.ProcessEnv;
  allowEnv: boolean;
}): boolean {
  if (!params.activationField) {
    return true;
  }
  if (normalizeOptionalString(params.record[params.activationField])) {
    return true;
  }
  return Boolean(
    params.allowEnv &&
    params.activationEnv &&
    normalizeOptionalString(params.env[params.activationEnv]),
  );
}

export function loadOfficialExternalChannelSecretContractApi(
  channelId: string,
): OfficialExternalChannelSecretContractApi | undefined {
  const contract = getOfficialExternalChannelSecretContract(channelId);
  if (!contract) {
    return undefined;
  }
  const fieldNames = contract.fields.map((field) => field.field);
  return {
    secretTargetRegistryEntries: createChannelSecretTargetRegistryEntries({
      channelKey: contract.channelId,
      channel: fieldNames,
      account: fieldNames,
    }),
    collectRuntimeConfigAssignments({ config, defaults, context }) {
      const channel = getChannelRecord(config, contract.channelId);
      if (!channel) {
        return;
      }
      for (const field of contract.fields) {
        const activationEnvValue = field.activationEnv
          ? normalizeOptionalString(context.env[field.activationEnv])
          : undefined;
        if (
          isEnabledFlag(channel) &&
          field.activationField &&
          !normalizeOptionalString(channel[field.activationField]) &&
          activationEnvValue
        ) {
          // External discovery may enumerate accounts before its resolver reads
          // env fallbacks. Materialize only into the ephemeral runtime config.
          channel[field.activationField] = activationEnvValue;
        }
        collectSecretInputAssignment({
          value: channel[field.field],
          path: `channels.${contract.channelId}.${field.field}`,
          expected: "string",
          defaults,
          context,
          active:
            isEnabledFlag(channel) &&
            hasActivationValue({
              record: channel,
              activationField: field.activationField,
              activationEnv: field.activationEnv,
              env: context.env,
              allowEnv: true,
            }),
          inactiveReason: `external channel is disabled or ${field.activationField ?? "its credential surface"} is not configured.`,
          apply: (value) => {
            channel[field.field] = value;
          },
        });
        const accounts = isRecord(channel.accounts) ? channel.accounts : undefined;
        if (!accounts) {
          continue;
        }
        for (const [accountId, accountValue] of Object.entries(accounts)) {
          const account = isRecord(accountValue) ? accountValue : undefined;
          if (!account || !Object.hasOwn(account, field.field)) {
            continue;
          }
          collectSecretInputAssignment({
            value: account[field.field],
            path: `channels.${contract.channelId}.accounts.${accountId}.${field.field}`,
            expected: "string",
            defaults,
            context,
            active:
              isChannelAccountEffectivelyEnabled(channel, account) &&
              hasActivationValue({
                record: account,
                activationField: field.activationField,
                activationEnv: field.activationEnv,
                env: context.env,
                allowEnv: false,
              }),
            inactiveReason: `external channel account is disabled or ${field.activationField ?? "its credential surface"} is not configured.`,
            apply: (value) => {
              account[field.field] = value;
            },
          });
        }
      }
    },
  };
}

export function listOfficialExternalChannelSecretTargetRegistryEntries(): SecretTargetRegistryEntry[] {
  return listOfficialExternalChannelCatalogEntries().flatMap((entry) => {
    const channelId = normalizeOptionalString(
      getOfficialExternalPluginCatalogManifest(entry)?.channel?.id,
    );
    return channelId
      ? (loadOfficialExternalChannelSecretContractApi(channelId)?.secretTargetRegistryEntries ?? [])
      : [];
  });
}
