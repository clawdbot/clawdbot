import { isIP } from "node:net";
import { generateSecretKey, nip19 } from "nostr-tools";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  DEFAULT_ACCOUNT_ID,
  hasConfiguredSecretInput,
  moveSingleAccountChannelSectionToDefaultAccount,
  normalizeAccountId,
  patchScopedAccountConfig,
  patchTopLevelChannelConfigSection,
  promptAccountId,
  runSingleChannelSecretStep,
  type ChannelSetupWizardAdapter,
  type SecretInput,
} from "openclaw/plugin-sdk/setup";
import { waitForBuzzRoomAccess } from "./room-access-wait.js";
import { discoverBuzzRooms, type BuzzDiscoveredRoom } from "./room-discovery.js";
import { buzzSetupContract, isSameBuzzIdentity } from "./setup-core.js";
import { verifyBuzzAfterSetup } from "./setup-verify.js";
import {
  decodeBuzzPrivateKey,
  listBuzzAccountIds,
  resolveBuzzAccount,
  resolveBuzzAccountConfig,
  resolveBuzzPublicKey,
  resolveDefaultBuzzAccountId,
} from "./types.js";

const channel = "buzz" as const;
type BuzzSetupResult = Awaited<ReturnType<ChannelSetupWizardAdapter["configure"]>>;
type BuzzSetupPrompter = Parameters<ChannelSetupWizardAdapter["configure"]>[0]["prompter"];

type BuzzSetupDependencies = {
  discoverRooms?: typeof discoverBuzzRooms;
  generateSecretKey?: typeof generateSecretKey;
  runSecretStep?: typeof runSingleChannelSecretStep;
  waitForRoomAccess?: typeof waitForBuzzRoomAccess;
  verifyAfterWrite?: typeof verifyBuzzAfterSetup;
};

function patchBuzzChannelConfig(
  cfg: OpenClawConfig,
  patch: Record<string, unknown>,
): OpenClawConfig {
  return patchTopLevelChannelConfigSection({ cfg, channel, patch });
}

function patchBuzzAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  patch: Record<string, unknown>;
  clearFields?: readonly string[];
}): OpenClawConfig {
  return patchScopedAccountConfig({
    cfg: params.cfg,
    channelKey: channel,
    accountId: params.accountId,
    patch: params.patch,
    ...(params.clearFields ? { clearFields: params.clearFields } : {}),
    scopeDefaultToAccounts: Boolean(params.cfg.channels?.buzz?.accounts),
  });
}

function ensureBuzzAccountScope(cfg: OpenClawConfig, accountId: string): OpenClawConfig {
  return accountId !== DEFAULT_ACCOUNT_ID || cfg.channels?.buzz?.accounts
    ? moveSingleAccountChannelSectionToDefaultAccount({
        cfg,
        channelKey: channel,
        setupSurface: buzzSetupContract,
      })
    : cfg;
}

function validateRelayUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    return url.protocol === "ws:" || url.protocol === "wss:"
      ? undefined
      : "Use a ws:// or wss:// relay URL";
  } catch {
    return "Enter a valid Buzz relay WebSocket URL";
  }
}

function isRemoteInsecureRelayUrl(value: string): boolean {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  const isIpv4Loopback = isIP(hostname) === 4 && hostname.startsWith("127.");
  const isLoopback =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "::1" ||
    isIpv4Loopback;
  return url.protocol === "ws:" && !isLoopback;
}

function isBuzzSetupConfigured(cfg: OpenClawConfig, accountId: string): boolean {
  const account = resolveBuzzAccount({ cfg, accountId });
  return Boolean(
    account.relayUrl &&
    (account.privateKey ||
      hasConfiguredSecretInput(account.config.privateKey, cfg.secrets?.defaults)),
  );
}

async function resolveBuzzSetupAccountId(params: {
  cfg: OpenClawConfig;
  prompter: BuzzSetupPrompter;
  accountOverride?: string;
  shouldPromptAccountIds: boolean;
}): Promise<string> {
  const override = params.accountOverride?.trim();
  const defaultAccountId = resolveDefaultBuzzAccountId(params.cfg);
  if (override) {
    return normalizeAccountId(override);
  }
  if (!params.shouldPromptAccountIds || listBuzzAccountIds(params.cfg).length === 0) {
    return defaultAccountId;
  }
  return await promptAccountId({
    cfg: params.cfg,
    prompter: params.prompter,
    label: "Buzz",
    currentId: defaultAccountId,
    listAccountIds: listBuzzAccountIds,
    defaultAccountId,
  });
}

async function promptRelayUrl(params: {
  initialValue?: string;
  prompter: Parameters<ChannelSetupWizardAdapter["configure"]>[0]["prompter"];
}): Promise<string> {
  while (true) {
    const relayUrl = (
      await params.prompter.text({
        message: "Buzz relay WebSocket URL",
        placeholder: "wss://buzz.example.com",
        initialValue: params.initialValue,
        validate: validateRelayUrl,
      })
    ).trim();
    if (!isRemoteInsecureRelayUrl(relayUrl)) {
      return relayUrl;
    }
    const continueInsecure = await params.prompter.confirm({
      message: "This remote ws:// relay is unencrypted. Continue anyway?",
      initialValue: false,
    });
    if (continueInsecure) {
      return relayUrl;
    }
  }
}

async function resolveRelayUrl(params: {
  configuredValue?: string;
  prompter: BuzzSetupPrompter;
}): Promise<string> {
  const configuredValue = params.configuredValue?.trim();
  if (configuredValue && validateRelayUrl(configuredValue) === undefined) {
    if (!isRemoteInsecureRelayUrl(configuredValue)) {
      return configuredValue;
    }
    const continueInsecure = await params.prompter.confirm({
      message: "This remote ws:// relay is unencrypted. Continue anyway?",
      initialValue: false,
    });
    if (continueInsecure) {
      return configuredValue;
    }
  }
  return await promptRelayUrl({
    ...(configuredValue ? { initialValue: configuredValue } : {}),
    prompter: params.prompter,
  });
}

function resolvedConfiguredKey(cfg: OpenClawConfig, accountId: string): string | undefined {
  const value = resolveBuzzAccount({ cfg, accountId }).config.privateKey;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolvedCurrentKey(cfg: OpenClawConfig, accountId: string): string | undefined {
  return resolveBuzzAccount({ cfg, accountId }).privateKey || undefined;
}

async function resolvePrivateKey(params: {
  cfg: OpenClawConfig;
  accountId: string;
  prompter: BuzzSetupPrompter;
  secretInputMode?: "plaintext" | "ref";
  generate: typeof generateSecretKey;
  generatedPrivateKeys: WeakMap<BuzzSetupPrompter, Map<string, string>>;
  runSecretStep: typeof runSingleChannelSecretStep;
}): Promise<{ cfg: OpenClawConfig; resolvedPrivateKey?: string }> {
  const account = resolveBuzzAccount({ cfg: params.cfg, accountId: params.accountId });
  const hasExistingIdentity =
    hasConfiguredSecretInput(account.config.privateKey, params.cfg.secrets?.defaults) ||
    Boolean(account.privateKey);
  const currentPrivateKey = resolvedCurrentKey(params.cfg, params.accountId);
  if (hasExistingIdentity) {
    const resolvedPrivateKey = currentPrivateKey;
    if (resolvedPrivateKey) {
      decodeBuzzPrivateKey(resolvedPrivateKey);
    }
    return { cfg: params.cfg, resolvedPrivateKey };
  }
  if (params.secretInputMode !== "ref") {
    // Back navigation replays the full channel setup function. Keep one generated
    // identity per wizard session so replay cannot invalidate already granted access.
    let generatedByAccount = params.generatedPrivateKeys.get(params.prompter);
    if (!generatedByAccount) {
      generatedByAccount = new Map();
      params.generatedPrivateKeys.set(params.prompter, generatedByAccount);
    }
    let privateKey = generatedByAccount.get(params.accountId);
    if (!privateKey) {
      privateKey = nip19.nsecEncode(params.generate());
      generatedByAccount.set(params.accountId, privateKey);
    }
    return {
      cfg: patchBuzzAccountConfig({
        cfg: params.cfg,
        accountId: params.accountId,
        patch: { privateKey },
        clearFields: ["authTag"],
      }),
      resolvedPrivateKey: privateKey,
    };
  }

  const secretStep = await params.runSecretStep({
    cfg: params.cfg,
    prompter: params.prompter,
    providerHint: channel,
    credentialLabel: "Buzz bot private key",
    secretInputMode: params.secretInputMode,
    accountConfigured: false,
    hasConfigToken: false,
    allowEnv: params.accountId === DEFAULT_ACCOUNT_ID,
    envValue: params.accountId === DEFAULT_ACCOUNT_ID ? process.env.BUZZ_PRIVATE_KEY : undefined,
    envPrompt: "Use BUZZ_PRIVATE_KEY?",
    keepPrompt: "Keep the existing Buzz bot private key?",
    inputPrompt: "Buzz bot private key (nsec or 64-character hex)",
    preferredEnvVar: "BUZZ_PRIVATE_KEY",
    applyUseEnv: (cfg) => {
      const envPrivateKey = process.env.BUZZ_PRIVATE_KEY?.trim();
      const keepAuthTag = isSameBuzzIdentity(currentPrivateKey, envPrivateKey);
      return patchBuzzAccountConfig({
        cfg,
        accountId: params.accountId,
        patch:
          keepAuthTag && account.config.authTag !== undefined
            ? { authTag: account.config.authTag }
            : {},
        clearFields: ["privateKey", "authTag"],
      });
    },
    applySet: (cfg, value: SecretInput, resolvedValue) =>
      patchBuzzAccountConfig({
        cfg,
        accountId: params.accountId,
        patch: { privateKey: value },
        ...(isSameBuzzIdentity(currentPrivateKey, resolvedValue)
          ? {}
          : { clearFields: ["authTag"] }),
      }),
  });
  const resolvedPrivateKey =
    secretStep.resolvedValue ??
    (secretStep.action === "keep"
      ? (resolvedConfiguredKey(secretStep.cfg, params.accountId) ?? currentPrivateKey)
      : undefined);
  if (resolvedPrivateKey) {
    decodeBuzzPrivateKey(resolvedPrivateKey);
  }
  return { cfg: secretStep.cfg, resolvedPrivateKey };
}

async function promptRooms(params: {
  rooms: BuzzDiscoveredRoom[];
  configuredRoomIds: string[];
  prompter: Parameters<ChannelSetupWizardAdapter["configure"]>[0]["prompter"];
}): Promise<string[]> {
  if (params.rooms.length === 1) {
    return [params.rooms[0]!.id];
  }
  const configuredRooms = new Set(params.configuredRoomIds);
  const preservedRoomIds = params.rooms
    .map((room) => room.id)
    .filter((roomId) => configuredRooms.has(roomId));
  return await params.prompter.multiselect({
    message: "Select authorized Buzz rooms",
    options: params.rooms.map((room) => ({
      value: room.id,
      label: room.name,
      hint: room.about ?? room.id,
    })),
    initialValues:
      preservedRoomIds.length > 0 ? preservedRoomIds : params.rooms.map((room) => room.id),
  });
}

function pauseBuzzSetup(cfg: OpenClawConfig, accountId: string): BuzzSetupResult {
  return {
    cfg: patchBuzzAccountConfig({ cfg, accountId, patch: { enabled: false } }),
    completion: "paused",
  };
}

async function noteBuzzAccessInstructions(params: {
  relayUrl: string;
  publicKey?: string;
  prompter: Parameters<ChannelSetupWizardAdapter["configure"]>[0]["prompter"];
  discoveryError?: string;
}) {
  const npub = params.publicKey ? nip19.npubEncode(params.publicKey) : "<BOT_PUBLIC_KEY>";
  const hex = params.publicKey ?? "<64_CHAR_BOT_PUBLIC_KEY>";
  await params.prompter.note(
    [
      ...(params.discoveryError ? [`Status: ${params.discoveryError}`, ""] : []),
      `Relay: ${params.relayUrl}`,
      `Bot npub: ${npub}`,
      `Bot hex public key: ${hex}`,
      "",
      "Run as the existing human room owner/admin:",
      `buzz channels add-member --channel <ROOM_UUID> --pubkey ${hex} --role bot`,
      "",
      "OpenClaw is waiting for Buzz to confirm the Bot role automatically.",
      "Local `just dev` needs no separate community-member step.",
      `Closed relay only: first run buzz-admin add-member --pubkey ${hex} --role member.`,
      "Never paste that human private key into OpenClaw.",
    ].join("\n"),
    "Buzz room access required",
  );
}

export function createBuzzSetupWizard(
  dependencies: BuzzSetupDependencies = {},
): ChannelSetupWizardAdapter {
  const discoverRooms = dependencies.discoverRooms ?? discoverBuzzRooms;
  const generate = dependencies.generateSecretKey ?? generateSecretKey;
  const runSecretStep = dependencies.runSecretStep ?? runSingleChannelSecretStep;
  const waitForRoomAccess = dependencies.waitForRoomAccess ?? waitForBuzzRoomAccess;
  const verifyAfterWrite = dependencies.verifyAfterWrite ?? verifyBuzzAfterSetup;
  const generatedPrivateKeys = new WeakMap<BuzzSetupPrompter, Map<string, string>>();

  return {
    channel,
    getStatus: async ({ cfg, accountOverrides }) => {
      const accountId = accountOverrides.buzz?.trim()
        ? normalizeAccountId(accountOverrides.buzz)
        : resolveDefaultBuzzAccountId(cfg);
      const account = resolveBuzzAccount({ cfg, accountId });
      const configured =
        (accountId === DEFAULT_ACCOUNT_ID || listBuzzAccountIds(cfg).includes(accountId)) &&
        isBuzzSetupConfigured(cfg, accountId);
      const enabled = account.enabled;
      const status = !configured
        ? "needs relay URL and bot identity"
        : enabled
          ? "configured"
          : "configured but disabled";
      return {
        channel,
        configured,
        statusLines: [`Buzz: ${status}`],
        selectionHint: status,
      };
    },
    configure: async ({ cfg, prompter, options, accountOverrides, shouldPromptAccountIds }) => {
      const accountId = await resolveBuzzSetupAccountId({
        cfg,
        prompter,
        accountOverride: accountOverrides.buzz,
        shouldPromptAccountIds,
      });
      let next = ensureBuzzAccountScope(cfg, accountId);
      const existingAccount = resolveBuzzAccount({ cfg: next, accountId });
      const existingBuzzConfig = resolveBuzzAccountConfig(next, accountId);
      const hasExistingAccessConfig =
        existingBuzzConfig?.groupPolicy !== undefined ||
        existingBuzzConfig?.groupAllowFrom !== undefined ||
        existingBuzzConfig?.groups !== undefined;
      const useFreshAccessDefaults =
        !isBuzzSetupConfigured(next, accountId) && !hasExistingAccessConfig;
      const configuredRelayUrl = existingAccount.relayUrl || undefined;
      const relayUrl = await resolveRelayUrl({ configuredValue: configuredRelayUrl, prompter });
      next = patchBuzzAccountConfig({ cfg: next, accountId, patch: { enabled: true, relayUrl } });
      const identity = await resolvePrivateKey({
        cfg: next,
        accountId,
        prompter,
        secretInputMode: options?.secretInputMode,
        generate,
        generatedPrivateKeys,
        runSecretStep,
      });
      next = identity.cfg;

      const privateKey = identity.resolvedPrivateKey;
      let publicKey: string | undefined;
      if (privateKey) {
        publicKey = resolveBuzzPublicKey(privateKey);
      }
      if (!privateKey) {
        await prompter.note(
          "OpenClaw cannot resolve the configured private-key reference during setup, so room access cannot be verified. The relay URL and identity reference will be saved with Buzz disabled. Make the secret available and rerun setup.",
          "Buzz setup paused",
        );
        return pauseBuzzSetup(next, accountId);
      }

      let discoveredRooms: BuzzDiscoveredRoom[] = [];
      let discoveryError: string | undefined;
      const authTag = resolveBuzzAccount({ cfg: next, accountId }).authTag;
      const discoverAuthorizedRooms = async (): Promise<BuzzDiscoveredRoom[]> => {
        try {
          const rooms = await discoverRooms({
            relayUrl,
            privateKey,
            ...(authTag ? { authTag } : {}),
          });
          discoveryError =
            rooms.length === 0 ? "No authorized rooms were returned for this bot." : undefined;
          return rooms;
        } catch (error) {
          discoveryError = `Authenticated room discovery failed: ${error instanceof Error ? error.message : String(error)}.`;
          return [];
        }
      };
      discoveredRooms = await discoverAuthorizedRooms();
      if (discoveredRooms.length === 0) {
        await noteBuzzAccessInstructions({
          relayUrl,
          publicKey,
          prompter,
          discoveryError,
        });
        const progress = prompter.progress("Waiting for Buzz room access...");
        try {
          discoveredRooms = await waitForRoomAccess({
            relayUrl,
            privateKey,
            ...(authTag ? { authTag } : {}),
          });
          progress.stop(
            discoveredRooms.length > 0
              ? "Buzz room access confirmed"
              : "Buzz room access wait expired",
          );
        } catch (error) {
          progress.stop("Buzz room access check failed");
          await prompter.note(
            error instanceof Error ? error.message : String(error),
            "Buzz room access check failed",
          );
        }
      }
      while (discoveredRooms.length === 0) {
        await prompter.select({
          message: "Buzz room access is not ready",
          options: [
            {
              value: "retry",
              label: "Retry authenticated room discovery",
              hint: "Use after the bot has been added to a room with the Bot role",
            },
          ],
          initialValue: "retry",
        });
        const progress = prompter.progress("Checking Buzz room access...");
        discoveredRooms = await discoverAuthorizedRooms();
        progress.stop(
          discoveredRooms.length > 0 ? "Buzz room access confirmed" : "Buzz room access not found",
        );
        if (discoveredRooms.length === 0 && discoveryError) {
          await prompter.note(discoveryError, "Buzz room access not ready");
        }
      }

      const configuredAccount = resolveBuzzAccount({ cfg: next, accountId });
      const configuredGroups = configuredAccount.config.groups ?? {};
      const roomIds = await promptRooms({
        rooms: discoveredRooms,
        configuredRoomIds: Object.keys(configuredGroups),
        prompter,
      });
      if (roomIds.length === 0) {
        await prompter.note(
          "No rooms were selected. Relay URL and bot identity will be saved with Buzz disabled.",
          "Buzz setup paused",
        );
        return pauseBuzzSetup(next, accountId);
      }
      const existingDefault = configuredAccount.config.defaultTo;
      const defaultTo =
        roomIds.length === 1
          ? roomIds[0]!
          : await prompter.select({
              message: "Choose the default Buzz room target",
              options: roomIds.map((roomId) => {
                const room = discoveredRooms.find((candidate) => candidate.id === roomId);
                return { value: roomId, label: room?.name ?? roomId, hint: roomId };
              }),
              initialValue:
                existingDefault && roomIds.includes(existingDefault) ? existingDefault : roomIds[0],
            });
      next = patchBuzzAccountConfig({
        cfg: next,
        accountId,
        patch: {
          ...(useFreshAccessDefaults ? { groupPolicy: "open", groupAllowFrom: undefined } : {}),
          groups: Object.fromEntries(
            roomIds.map((roomId) => [
              roomId,
              {
                enabled: configuredGroups[roomId]?.enabled ?? true,
                requireMention: configuredGroups[roomId]?.requireMention ?? !useFreshAccessDefaults,
              },
            ]),
          ),
          defaultTo,
        },
      });
      options?.onPostWriteHook?.({
        channel,
        accountId,
        run: async ({ runtime }) =>
          await verifyAfterWrite({
            accountId,
            target: defaultTo,
            runtime,
          }),
      });
      return { cfg: next, accountId };
    },
    disable: (cfg) => patchBuzzChannelConfig(cfg, { enabled: false }),
  };
}

export const buzzSetupWizard = createBuzzSetupWizard();
