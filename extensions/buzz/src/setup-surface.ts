import { isIP } from "node:net";
import { generateSecretKey, nip19 } from "nostr-tools";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  hasConfiguredSecretInput,
  runSingleChannelSecretStep,
  type ChannelSetupWizardAdapter,
  type SecretInput,
  splitSetupEntries,
} from "openclaw/plugin-sdk/setup";
import { discoverBuzzRooms, type BuzzDiscoveredRoom } from "./room-discovery.js";
import { isSameBuzzIdentity } from "./setup-core.js";
import { verifyBuzzAfterSetup } from "./setup-verify.js";
import { parseBuzzTarget } from "./target.js";
import { decodeBuzzPrivateKey, resolveBuzzAccount, resolveBuzzPublicKey } from "./types.js";

const channel = "buzz" as const;

type BuzzSetupDependencies = {
  discoverRooms?: typeof discoverBuzzRooms;
  generateSecretKey?: typeof generateSecretKey;
  runSecretStep?: typeof runSingleChannelSecretStep;
  verifyAfterWrite?: typeof verifyBuzzAfterSetup;
};

function patchBuzzConfig(cfg: OpenClawConfig, patch: Record<string, unknown>): OpenClawConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      buzz: {
        ...cfg.channels?.buzz,
        ...patch,
      },
    },
  } as OpenClawConfig;
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

function isBuzzSetupConfigured(cfg: OpenClawConfig): boolean {
  const buzzConfig = cfg.channels?.buzz;
  return Boolean(
    (buzzConfig?.relayUrl?.trim() || process.env.BUZZ_RELAY_URL?.trim()) &&
    (hasConfiguredSecretInput(buzzConfig?.privateKey, cfg.secrets?.defaults) ||
      process.env.BUZZ_PRIVATE_KEY?.trim()),
  );
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

function normalizePublicKey(value: string): string {
  const trimmed = value.trim();
  if (/^[0-9a-f]{64}$/iu.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  const decoded = nip19.decode(trimmed);
  if (decoded.type !== "npub") {
    throw new Error("Use an npub or 64-character hexadecimal public key");
  }
  return decoded.data;
}

function parseRoomIds(value: string): string[] {
  return [...new Set(splitSetupEntries(value).map((entry) => parseBuzzTarget(entry)))];
}

function resolvedConfiguredKey(cfg: OpenClawConfig): string | undefined {
  const value = cfg.channels?.buzz?.privateKey;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolvedCurrentKey(cfg: OpenClawConfig): string | undefined {
  return cfg.channels?.buzz?.privateKey === undefined
    ? process.env.BUZZ_PRIVATE_KEY?.trim() || undefined
    : resolvedConfiguredKey(cfg);
}

async function promptPrivateKey(params: {
  cfg: OpenClawConfig;
  prompter: Parameters<ChannelSetupWizardAdapter["configure"]>[0]["prompter"];
  secretInputMode?: "plaintext" | "ref";
  generate: typeof generateSecretKey;
  runSecretStep: typeof runSingleChannelSecretStep;
}): Promise<{ cfg: OpenClawConfig; resolvedPrivateKey?: string; generated: boolean }> {
  const hasExistingIdentity =
    hasConfiguredSecretInput(params.cfg.channels?.buzz?.privateKey, params.cfg.secrets?.defaults) ||
    Boolean(process.env.BUZZ_PRIVATE_KEY?.trim());
  const currentPrivateKey = resolvedCurrentKey(params.cfg);
  const identityOptions: Array<{
    value: "reuse" | "generate" | "existing";
    label: string;
    hint: string;
  }> = [
    ...(hasExistingIdentity
      ? [
          {
            value: "reuse" as const,
            label: "Keep the current bot identity (recommended)",
            hint: "Reuses the configured key without another credential prompt",
          },
        ]
      : []),
    {
      value: "generate",
      label: `Generate a new bot identity${hasExistingIdentity ? "" : " (recommended)"}`,
      hint: "Stores a dedicated nsec in channels.buzz.privateKey",
    },
    {
      value: "existing",
      label: hasExistingIdentity ? "Use a different existing bot key" : "Use an existing bot key",
      hint: "Advanced: plaintext or a standard env/file/exec SecretRef",
    },
  ];
  const identityMode = await params.prompter.select({
    message: "Choose the OpenClaw Buzz bot identity",
    options: identityOptions,
    initialValue: hasExistingIdentity ? "reuse" : "generate",
  });
  if (identityMode === "reuse") {
    const resolvedPrivateKey = currentPrivateKey;
    if (resolvedPrivateKey) {
      decodeBuzzPrivateKey(resolvedPrivateKey);
    }
    return { cfg: params.cfg, resolvedPrivateKey, generated: false };
  }
  if (identityMode === "generate") {
    const privateKey = nip19.nsecEncode(params.generate());
    return {
      cfg: patchBuzzConfig(params.cfg, { enabled: true, privateKey, authTag: undefined }),
      resolvedPrivateKey: privateKey,
      generated: true,
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
    allowEnv: true,
    envValue: process.env.BUZZ_PRIVATE_KEY,
    envPrompt: "Use BUZZ_PRIVATE_KEY?",
    keepPrompt: "Keep the existing Buzz bot private key?",
    inputPrompt: "Buzz bot private key (nsec or 64-character hex)",
    preferredEnvVar: "BUZZ_PRIVATE_KEY",
    applyUseEnv: (cfg) => {
      const envPrivateKey = process.env.BUZZ_PRIVATE_KEY?.trim();
      const keepAuthTag = isSameBuzzIdentity(currentPrivateKey, envPrivateKey);
      const { privateKey: _privateKey, authTag, ...buzz } = cfg.channels?.buzz ?? {};
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          buzz: {
            ...buzz,
            enabled: true,
            ...(keepAuthTag && authTag !== undefined ? { authTag } : {}),
          },
        },
      } as OpenClawConfig;
    },
    applySet: (cfg, value: SecretInput, resolvedValue) =>
      patchBuzzConfig(cfg, {
        enabled: true,
        privateKey: value,
        ...(isSameBuzzIdentity(currentPrivateKey, resolvedValue) ? {} : { authTag: undefined }),
      }),
  });
  const resolvedPrivateKey =
    secretStep.resolvedValue ??
    (secretStep.action === "keep"
      ? (resolvedConfiguredKey(secretStep.cfg) ?? currentPrivateKey)
      : undefined);
  if (resolvedPrivateKey) {
    decodeBuzzPrivateKey(resolvedPrivateKey);
  }
  return { cfg: secretStep.cfg, resolvedPrivateKey, generated: false };
}

async function promptRooms(params: {
  rooms: BuzzDiscoveredRoom[];
  prompter: Parameters<ChannelSetupWizardAdapter["configure"]>[0]["prompter"];
}): Promise<string[]> {
  if (params.rooms.length > 0) {
    const selected = await params.prompter.multiselect({
      message: "Select authorized Buzz rooms",
      options: params.rooms.map((room) => ({
        value: room.id,
        label: room.name,
        hint: room.about ?? room.id,
      })),
      initialValues: params.rooms.map((room) => room.id),
    });
    if (selected.length > 0) {
      return selected;
    }
  }
  const roomInput = await params.prompter.text({
    message: "Buzz room UUID(s), comma-separated",
    placeholder: "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c",
    validate: (value) => {
      try {
        return parseRoomIds(value).length > 0 ? undefined : "Enter at least one room UUID";
      } catch (error) {
        return error instanceof Error ? error.message : "Invalid room UUID";
      }
    },
  });
  return parseRoomIds(roomInput);
}

export function createBuzzSetupWizard(
  dependencies: BuzzSetupDependencies = {},
): ChannelSetupWizardAdapter {
  const discoverRooms = dependencies.discoverRooms ?? discoverBuzzRooms;
  const generate = dependencies.generateSecretKey ?? generateSecretKey;
  const runSecretStep = dependencies.runSecretStep ?? runSingleChannelSecretStep;
  const verifyAfterWrite = dependencies.verifyAfterWrite ?? verifyBuzzAfterSetup;

  return {
    channel,
    getStatus: async ({ cfg }) => {
      const buzzConfig = cfg.channels?.buzz;
      const configured = isBuzzSetupConfigured(cfg);
      const enabled = buzzConfig?.enabled !== false;
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
    configure: async ({ cfg, prompter, options }) => {
      if (!isBuzzSetupConfigured(cfg)) {
        await prompter.note(
          [
            "You need a Buzz relay URL, a Buzz admin, and at least one target room.",
            "OpenClaw creates a dedicated bot identity and shares only its public key for approval.",
            `Docs: ${formatDocsLink("/channels/buzz", "channels/buzz")}`,
          ].join("\n"),
          "Before you set up Buzz",
        );
      }
      const relayUrl = await promptRelayUrl({
        initialValue: cfg.channels?.buzz?.relayUrl,
        prompter,
      });
      let next = patchBuzzConfig(cfg, { enabled: true, relayUrl });
      const identity = await promptPrivateKey({
        cfg: next,
        prompter,
        secretInputMode: options?.secretInputMode,
        generate,
        runSecretStep,
      });
      next = identity.cfg;

      let publicKey: string | undefined;
      if (identity.resolvedPrivateKey) {
        publicKey = resolveBuzzPublicKey(identity.resolvedPrivateKey);
      }
      const publicKeyForApproval = publicKey ? nip19.npubEncode(publicKey) : "<BOT_PUBLIC_KEY>";
      await prompter.note(
        [
          `Relay: ${relayUrl}`,
          ...(publicKey
            ? [`Bot npub: ${publicKeyForApproval}`, `Bot hex public key: ${publicKey}`]
            : [
                "Bot public key: retrieve the public key for the configured external private-key reference.",
              ]),
          identity.generated
            ? "The dedicated private key is stored in channels.buzz.privateKey and is not shown here."
            : "Only the bot public key is needed for approval.",
          "",
          `Self-hosted relay: buzz-admin add-member --pubkey ${publicKeyForApproval} --role member`,
          `Each room: buzz channels add-member --channel <ROOM_UUID> --pubkey ${publicKeyForApproval} --role bot`,
          "Hosted workspace: ask the operator to approve this public key for the relay and each room.",
          "OpenClaw cannot perform either approval and never needs the human owner's private key.",
          "Room discovery below proves membership only; it does not verify the bot role.",
        ].join("\n"),
        "Send this to your Buzz admin",
      );
      const membershipReady = await prompter.confirm({
        message: "Are relay membership and room Bot-role approval complete?",
        initialValue: false,
      });
      if (!membershipReady) {
        await prompter.note(
          "Relay URL and bot identity will be saved with Buzz disabled. Rerun setup after the owner/admin approvals are complete.",
          "Buzz setup paused",
        );
        return {
          cfg: patchBuzzConfig(next, { enabled: false }),
          accountId: DEFAULT_ACCOUNT_ID,
        };
      }

      let discoveredRooms: BuzzDiscoveredRoom[] = [];
      if (identity.resolvedPrivateKey) {
        try {
          const authTag = resolveBuzzAccount({ cfg: next }).authTag;
          discoveredRooms = await discoverRooms({
            relayUrl,
            privateKey: identity.resolvedPrivateKey,
            ...(authTag ? { authTag } : {}),
          });
          if (discoveredRooms.length === 0) {
            await prompter.note(
              "No authorized rooms were returned for this bot. Enter a room UUID manually.",
              "Buzz room discovery",
            );
          }
        } catch (error) {
          await prompter.note(
            `Authenticated room discovery failed: ${error instanceof Error ? error.message : String(error)}. Enter a room UUID manually.`,
            "Buzz room discovery",
          );
        }
      }
      const roomIds = await promptRooms({ rooms: discoveredRooms, prompter });
      const requireMention = await prompter.confirm({
        message: "Require mentions in configured Buzz rooms?",
        initialValue: true,
      });
      const groupPolicy = await prompter.select({
        message: "Choose Buzz room sender access",
        options: [
          { value: "allowlist", label: "Allowlisted public keys (recommended)" },
          { value: "open", label: "All room members" },
          { value: "disabled", label: "Disabled" },
        ],
        initialValue: "allowlist",
      });
      let groupAllowFrom: string[] | undefined;
      if (groupPolicy === "allowlist") {
        const allowFromInput = await prompter.text({
          message: "Allowed Buzz sender public key(s), comma-separated",
          placeholder: "npub1... or 64-character hex",
          validate: (value) => {
            try {
              return splitSetupEntries(value).length > 0
                ? (splitSetupEntries(value).forEach(normalizePublicKey), undefined)
                : "Enter at least one sender public key";
            } catch (error) {
              return error instanceof Error ? error.message : "Invalid public key";
            }
          },
        });
        groupAllowFrom = [
          ...new Set(splitSetupEntries(allowFromInput).map((entry) => normalizePublicKey(entry))),
        ];
      }
      const defaultTo = await prompter.select({
        message: "Choose the default Buzz room target",
        options: roomIds.map((roomId) => {
          const room = discoveredRooms.find((candidate) => candidate.id === roomId);
          return { value: roomId, label: room?.name ?? roomId, hint: roomId };
        }),
        initialValue: roomIds[0],
      });
      next = patchBuzzConfig(next, {
        groupPolicy,
        ...(groupAllowFrom ? { groupAllowFrom } : { groupAllowFrom: undefined }),
        groups: Object.fromEntries(
          roomIds.map((roomId) => [roomId, { enabled: true, requireMention }]),
        ),
        defaultTo,
      });
      const sendTestMessage = await prompter.confirm({
        message: "Send a test message after the config reload and authenticated probe?",
        initialValue: true,
      });
      options?.onPostWriteHook?.({
        channel,
        accountId: DEFAULT_ACCOUNT_ID,
        run: async ({ cfg: writtenCfg, runtime }) =>
          await verifyAfterWrite({
            cfg: writtenCfg,
            accountId: DEFAULT_ACCOUNT_ID,
            target: defaultTo,
            runtime,
            sendTestMessage,
          }),
      });
      return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
    },
    disable: (cfg) => patchBuzzConfig(cfg, { enabled: false }),
  };
}

export const buzzSetupWizard = createBuzzSetupWizard();
