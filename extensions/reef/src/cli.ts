// Reef plugin module implements headless CLI behavior. Every command is
// non-interactive so agents can register a claw and manage friendships when
// asked to by their owner; --json emits machine-readable results.
import type { Command } from "commander";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import { mutateConfigFile } from "openclaw/plugin-sdk/config-mutation";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { fingerprint } from "../protocol/index.js";
import {
  parseReefRelayUrl,
  ReefChannelConfigSchema,
  type ReefChannelConfig,
} from "./config-schema.js";
import { ReefAutonomySchema } from "./friend-types.js";
import { ReefFriendManager } from "./friends.js";
import { assertLegacyReefKeysMigrated, REEF_LEGACY_KEYS_PENDING_CODE } from "./legacy-key-guard.js";
import { getReefRuntime } from "./runtime.js";
import {
  assertReefIdentityBinding,
  clearReefSetupSession,
  finalizeReefIdentityBinding,
  generateAndStoreKeys,
  loadKeys,
  loadReefIdentityBinding,
  loadReefSetupSession,
  releaseReefIdentityReservation,
  reserveReefIdentityBinding,
  saveReefSetupSession,
} from "./state.js";
import {
  isDefinitiveReefRegistrationFailure,
  isReefOwnershipRejection,
  ReefTransportClient,
} from "./transport.js";
import { openReefTrustStore } from "./trust-store.js";
import type { ReefKeys } from "./types.js";

const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

// Guard defaults are provider-coupled so `--guard-provider anthropic` alone
// yields a working configuration instead of an OpenAI model/key pairing.
const GUARD_DEFAULTS = {
  openai: { pinnedModel: "gpt-5.6-terra", apiKeyEnv: "REEF_GUARD_OPENAI_KEY" },
  anthropic: { pinnedModel: "claude-haiku-4-5-20251001", apiKeyEnv: "REEF_GUARD_ANTHROPIC_KEY" },
} as const;

type ReefCliOutput = { json: boolean };

function emit(output: ReefCliOutput, payload: Record<string, unknown>, lines: string[]): void {
  if (output.json) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
}

async function fail(output: ReefCliOutput, message: string): Promise<never> {
  const stream = output.json ? process.stdout : process.stderr;
  const text = output.json ? `${JSON.stringify({ error: message })}\n` : `${message}\n`;
  // Drain before exiting: piped stdout writes are async and process.exit()
  // would truncate the machine-readable error automation depends on.
  await new Promise<void>((resolve) => {
    stream.write(text, () => resolve());
  });
  process.exit(1);
}

// Every action funnels through here so the documented --json contract holds
// for relay, filesystem, and config failures, not only explicit fail() calls.
function reefCliAction<TOptions extends { json: boolean }, TArgs extends unknown[]>(
  run: (output: ReefCliOutput, options: TOptions, ...args: TArgs) => Promise<void>,
): (...args: [...TArgs, TOptions]) => Promise<void> {
  return async (...args: [...TArgs, TOptions]) => {
    // Commander invokes actions as (positionals..., options, command); the
    // trailing Command instance must not be mistaken for the options bag.
    const optionsIndex = args.length - 2;
    const options = args[optionsIndex] as TOptions;
    const positional = args.slice(0, optionsIndex) as TArgs;
    const output: ReefCliOutput = { json: options.json };
    try {
      await run(output, options, ...positional);
    } catch (error) {
      await fail(output, error instanceof Error ? error.message : String(error));
    }
  };
}

async function loadOrCreateKeys(
  createMissing: boolean,
  legacyStateDir?: string,
): Promise<ReefKeys> {
  const runtime = getReefRuntime();
  try {
    return await loadKeys(runtime);
  } catch (error) {
    // Only a missing key file may mint a new identity. Replacing keys on
    // corruption or I/O failures would orphan the relay handle and every
    // pinned friendship bound to the old public keys.
    if (createMissing && (error as NodeJS.ErrnoException).code === "ENOENT") {
      await assertLegacyReefKeysMigrated(legacyStateDir);
      return await generateAndStoreKeys(runtime);
    }
    throw error;
  }
}

function currentReefConfig(): ReefChannelConfig | undefined {
  const cfg = getReefRuntime().config.current() as { channels?: { reef?: unknown } };
  const raw = cfg.channels?.reef;
  if (!raw) {
    return undefined;
  }
  const parsed = ReefChannelConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

async function loadConfiguredManager(output: ReefCliOutput): Promise<{
  config: ReefChannelConfig;
  keys: ReefKeys;
  manager: ReefFriendManager;
}> {
  const config = currentReefConfig();
  if (!config?.handle) {
    return await fail(output, "Reef is not configured. Run `openclaw reef register` first.");
  }
  const keys = await loadOrCreateKeys(false);
  const runtime = getReefRuntime();
  const relayUrl = parseReefRelayUrl(config.relayUrl);
  assertReefIdentityBinding(runtime, { handle: config.handle, relayUrl });
  const transport = new ReefTransportClient(relayUrl, config.handle, keys);
  const pairing = createChannelPairingController({
    core: runtime,
    channel: "reef",
    accountId: "default",
  });
  const manager = new ReefFriendManager(transport, openReefTrustStore(runtime, config), {
    list: pairing.readAllowFromStore,
    remove: async (peer) => {
      return (await pairing.removeAllowFromStoreEntry(peer)).changed;
    },
  });
  return { config, keys, manager };
}

type RegisterOptions = {
  email: string;
  handle?: string;
  session?: string;
  token?: string;
  relay: string;
  policy: string;
  stateDir?: string;
  guardProvider: string;
  guardModel?: string;
  guardEnv?: string;
  guardPolicy: string;
  json: boolean;
};

async function writeReefRegistration(candidate: ReefChannelConfig): Promise<void> {
  await mutateConfigFile({
    afterWrite: { mode: "auto" },
    mutate(draft: OpenClawConfig) {
      draft.channels = {
        ...draft.channels,
        reef: candidate,
      };
    },
  });
}

async function writeReefMigrationStateDir(stateDir: string): Promise<void> {
  await mutateConfigFile({
    afterWrite: { mode: "auto" },
    mutate(draft: OpenClawConfig) {
      const existing = draft.channels?.reef;
      draft.channels = {
        ...draft.channels,
        reef: {
          ...(existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {}),
          stateDir,
        },
      };
    },
  });
}

async function runRegister(output: ReefCliOutput, options: RegisterOptions): Promise<void> {
  if (!options.email.includes("@")) {
    return await fail(output, "A valid --email is required.");
  }
  const provider = options.guardProvider as keyof typeof GUARD_DEFAULTS;
  const guardDefaults = GUARD_DEFAULTS[provider];
  if (!guardDefaults) {
    return await fail(output, "--guard-provider must be one of: anthropic, openai.");
  }
  const relayUrl = parseReefRelayUrl(options.relay);
  const legacyStateDir = options.stateDir ?? currentReefConfig()?.stateDir;
  const explicitHandle = options.handle?.toLowerCase();
  // One plugin-state identity may bind to one handle and relay. This check
  // survives config deletion and prevents linking peers under reused keys.
  const runtime = getReefRuntime();
  const identity = loadReefIdentityBinding(runtime);
  if (
    identity?.handle &&
    (identity.relayUrl !== relayUrl ||
      (explicitHandle !== undefined && identity.handle !== explicitHandle))
  ) {
    return await fail(
      output,
      `This OpenClaw state already holds the Reef identity @${identity.handle} on ${identity.relayUrl}. Re-register the same handle and relay.`,
    );
  }
  const requestedHandle = explicitHandle ?? identity?.handle;
  let keys: ReefKeys;
  try {
    keys = await loadOrCreateKeys(true, legacyStateDir);
  } catch (error) {
    if (
      options.stateDir &&
      (error as NodeJS.ErrnoException).code === REEF_LEGACY_KEYS_PENDING_CODE
    ) {
      try {
        await writeReefMigrationStateDir(options.stateDir);
      } catch (writeError) {
        throw new Error("Failed to save the Reef legacy state directory for Doctor", {
          cause: writeError,
        });
      }
    }
    throw error;
  }

  const bootstrap = new ReefTransportClient(relayUrl, requestedHandle ?? "pending", keys);
  // A previously exchanged session is reused from plugin state so retries
  // never need the single-use token again and the credential never appears in
  // command output or automation logs. It is scoped to the relay and email it
  // was minted for, and explicit --session/--token always take precedence, so
  // stale state can never reach another account or origin.
  const stored = loadReefSetupSession(runtime);
  const token = options.token?.trim();
  const storedSession =
    !options.session?.trim() && stored?.relayUrl === relayUrl && stored?.email === options.email
      ? stored.session
      : undefined;
  // A scoped cached session beats a --token that a prior run already consumed,
  // so rerunning the exact same command recovers instead of re-exchanging.
  const session = options.session?.trim() || storedSession;
  if (!session && !token) {
    const started = await bootstrap.authStart(options.email);
    emit(
      output,
      {
        status: "email_sent",
        email: options.email,
        ...(started.magicLink ? { magicLink: started.magicLink } : {}),
        next: "Open the magic link, copy the token from the URL fragment, then rerun the exact same command with --token <token> added (or --session from the welcome page).",
      },
      [
        `Sign-in link sent to ${options.email}.`,
        ...(started.magicLink ? [`Development magic link: ${started.magicLink}`] : []),
        "Open the link, copy the token from the URL fragment, then rerun the exact",
        "same command with --token <token> added.",
      ],
    );
    return;
  }

  // Validate everything that completion needs BEFORE consuming the single-use
  // token or mutating relay state, so a bad flag cannot burn the credential or
  // claim a handle that a retry then finds taken.
  const handle = requestedHandle;
  if (!handle || !HANDLE_PATTERN.test(handle)) {
    return await fail(output, "A valid --handle is required (lowercase letters, digits, - or _).");
  }
  const guard = {
    provider,
    pinnedModel: options.guardModel ?? guardDefaults.pinnedModel,
    apiKeyEnv: options.guardEnv ?? guardDefaults.apiKeyEnv,
    policyVersion: options.guardPolicy,
    timeoutMs: 30_000,
  };
  // Validate the full provisional candidate before consuming the single-use
  // token or touching relay state; the final candidate is re-parsed after the
  // claim so a recovered handle keeps the RELAY's request policy instead of
  // silently recording an unapplied one.
  const provisional = {
    enabled: true,
    relayUrl,
    handle,
    email: options.email,
    requestPolicy: options.policy,
    ...(legacyStateDir ? { stateDir: legacyStateDir } : {}),
    guard,
  };
  ReefChannelConfigSchema.parse(provisional);
  // Reserve keys to this handle before consuming auth or mutating the relay.
  // Retries are idempotent; mismatched concurrent registrations fail closed.
  const reservation = reserveReefIdentityBinding(runtime, { handle, relayUrl });

  let resolvedSession = session;
  if (!resolvedSession) {
    try {
      resolvedSession = (await bootstrap.authComplete(token ?? "")).session;
    } catch (error) {
      if (isDefinitiveReefRegistrationFailure(error)) {
        releaseReefIdentityReservation(runtime, reservation);
      } else {
        finalizeReefIdentityBinding(runtime, reservation);
      }
      throw error;
    }
    try {
      saveReefSetupSession(runtime, {
        session: resolvedSession,
        relayUrl,
        email: options.email,
      });
    } catch (error) {
      releaseReefIdentityReservation(runtime, reservation);
      throw error;
    }
  }
  const transport = new ReefTransportClient(relayUrl, handle, keys);
  let effectivePolicy = options.policy;
  try {
    await transport.createHandle(resolvedSession, options.policy);
  } catch (error) {
    // The relay rejects duplicates outright, so a retried registration (or a
    // config-write failure after a successful claim) hits handle_unavailable.
    // A device-signed read only succeeds when OUR key owns the handle; treat
    // that as the claim already being done instead of stranding the retry.
    const unavailable = error instanceof Error && error.message.includes("handle_unavailable");
    let owned = false;
    if (unavailable) {
      try {
        await transport.listFriends();
        owned = true;
      } catch (verificationError) {
        if (isReefOwnershipRejection(verificationError)) {
          releaseReefIdentityReservation(runtime, reservation);
        } else {
          // A failed probe proves non-ownership only for the relay's explicit
          // unknown-handle result. Keep all other outcomes bound to these keys.
          finalizeReefIdentityBinding(runtime, reservation);
        }
        throw verificationError;
      }
    }
    if (!owned) {
      if (isDefinitiveReefRegistrationFailure(error)) {
        releaseReefIdentityReservation(runtime, reservation);
      } else {
        finalizeReefIdentityBinding(runtime, reservation);
      }
      throw error;
    }
    // Signed access proves these keys already own the handle. Persist that
    // invariant before the account-list request, which can fail ambiguously.
    finalizeReefIdentityBinding(runtime, reservation);
    const { handles } = await transport.listOwnHandles(resolvedSession);
    const existingHandle = handles.find((entry) => entry.handle === handle);
    if (!existingHandle) {
      // Our keys own the handle but this session's account does not list it:
      // the supplied session belongs to a different relay account. Completing
      // would record an email/policy the relay never associated with the claw.
      return await fail(
        output,
        `Handle @${handle} is owned by this claw's keys, but the supplied session belongs to a different relay account. Use a session for the account that registered the handle.`,
      );
    }
    effectivePolicy = existingHandle.request_policy;
  }
  finalizeReefIdentityBinding(runtime, reservation);

  const candidate = ReefChannelConfigSchema.parse({
    ...provisional,
    requestPolicy: effectivePolicy,
  });

  try {
    await writeReefRegistration(candidate);
  } catch (error) {
    await fail(
      output,
      `Handle @${handle} is claimed, but writing the local config failed: ${error instanceof Error ? error.message : String(error)}. Fix the local issue and rerun the exact same command — the retry reuses the stored session and recognizes the existing claim.`,
    );
  }
  clearReefSetupSession(runtime);

  const printed = fingerprint(keys.signing.publicKey, keys.encryption.publicKey);
  emit(output, { status: "registered", handle, relayUrl, fingerprint: printed }, [
    `Registered @${handle} on ${relayUrl}.`,
    `Safety fingerprint (share out of band): ${printed}`,
    "Restart the gateway to connect: openclaw gateway restart",
  ]);
}

export function registerReefCli({ program }: { program: Command }): void {
  const reef = program
    .command("reef")
    .description("Register on a Reef relay and manage guarded claw-to-claw friendships");

  reef
    .command("register")
    .description("Claim a handle and configure the Reef channel without the wizard")
    .requiredOption("--email <email>", "Owner email registered with the relay")
    .option("--handle <handle>", "Unlisted handle for this claw")
    .option("--session <session>", "Setup session from the relay welcome page")
    .option("--token <token>", "Magic-link token to exchange for a session")
    .option("--relay <url>", "Relay origin URL", "https://reefwire.ai")
    .option("--policy <policy>", "Inbound friend-request policy", "code-only")
    .option("--state-dir <dir>", "Legacy Reef file directory for Doctor import")
    .option("--guard-provider <provider>", "Guard provider (anthropic|openai)", "openai")
    .option("--guard-model <model>", "Immutable guard model id (default depends on provider)")
    .option("--guard-env <name>", "Env var holding the guard API key (default depends on provider)")
    .option("--guard-policy <version>", "Guard policy version", "reef-v1")
    .option("--json", "Emit JSON", false)
    .action(reefCliAction<RegisterOptions, []>(runRegister));

  reef
    .command("status")
    .description("Show Reef configuration and relay-side friendships")
    .option("--json", "Emit JSON", false)
    .action(
      reefCliAction<{ json: boolean }, []>(async (output) => {
        const { config, keys, manager } = await loadConfiguredManager(output);
        const friends = await manager.list();
        const printed = fingerprint(keys.signing.publicKey, keys.encryption.publicKey);
        emit(
          output,
          {
            handle: config.handle,
            relayUrl: config.relayUrl,
            requestPolicy: config.requestPolicy,
            guard: { provider: config.guard?.provider, pinnedModel: config.guard?.pinnedModel },
            fingerprint: printed,
            friends: friends.map((friend) => ({
              peer: friend.peer,
              status: friend.status,
              autonomy: friend.autonomy ?? null,
              fingerprint: friend.fingerprint,
            })),
          },
          [
            `@${config.handle} on ${config.relayUrl} (policy ${config.requestPolicy})`,
            `Guard: ${config.guard?.provider}/${config.guard?.pinnedModel}`,
            `Fingerprint: ${printed}`,
            ...friends.map(
              (friend) =>
                `- @${friend.peer}: ${friend.status}${friend.autonomy ? ` (${friend.autonomy})` : ""}`,
            ),
            ...(friends.length === 0 ? ["No friendships yet."] : []),
          ],
        );
      }),
    );

  const friend = reef.command("friend").description("Manage Reef friendships");

  friend
    .command("code")
    .description("Mint a short-lived code a friend can use to request pairing")
    .option("--json", "Emit JSON", false)
    .action(
      reefCliAction<{ json: boolean }, []>(async (output) => {
        const { manager } = await loadConfiguredManager(output);
        const minted = await manager.mintCode();
        const expires = new Date(minted.expires * 1000).toISOString();
        emit(output, { code: minted.code, expires }, [
          `Friend code: ${minted.code} (expires ${expires})`,
        ]);
      }),
    );

  friend
    .command("autonomy <handle> <tier>")
    .description("Set a trusted friend's autonomy tier")
    .option("--json", "Emit JSON", false)
    .action(
      reefCliAction<{ json: boolean }, [string, string]>(async (output, _options, handle, tier) => {
        const { manager } = await loadConfiguredManager(output);
        const peer = handle.replace(/^@/, "").toLowerCase();
        const autonomy = ReefAutonomySchema.parse(tier);
        await manager.setAutonomy(peer, autonomy);
        emit(output, { peer, autonomy }, [`Set @${peer} autonomy to ${autonomy}.`]);
      }),
    );

  friend
    .command("request <handle>")
    .description("Request a friendship (adopted automatically once accepted)")
    .option("--code <code>", "Friend code minted by the recipient")
    .option("--json", "Emit JSON", false)
    .action(
      reefCliAction<{ code?: string; json: boolean }, [string]>(async (output, options, handle) => {
        const { manager } = await loadConfiguredManager(output);
        const peer = handle.replace(/^@/, "").toLowerCase();
        const result = await manager.request(peer, options.code);
        emit(output, { peer, status: result.status }, [
          `Friend request to @${peer}: ${result.status}. Adopted automatically once the peer accepts.`,
        ]);
      }),
    );

  friend
    .command("list")
    .description("List relay-side friendships with local autonomy")
    .option("--json", "Emit JSON", false)
    .action(
      reefCliAction<{ json: boolean }, []>(async (output) => {
        const { manager } = await loadConfiguredManager(output);
        const friends = await manager.list();
        emit(
          output,
          {
            friends: friends.map((entry) => ({
              peer: entry.peer,
              status: entry.status,
              autonomy: entry.autonomy ?? null,
              keyEpoch: entry.key_epoch,
              fingerprint: entry.fingerprint,
            })),
          },
          friends.length
            ? friends.map(
                (entry) =>
                  `@${entry.peer} ${entry.status} epoch=${entry.key_epoch} fingerprint=${entry.fingerprint}${entry.autonomy ? ` autonomy=${entry.autonomy}` : ""}`,
              )
            : ["No friendships yet."],
        );
      }),
    );

  friend
    .command("remove <handle>")
    .description("Remove or block a friendship")
    .option("--json", "Emit JSON", false)
    .action(
      reefCliAction<{ json: boolean }, [string]>(async (output, _options, handle) => {
        const { manager } = await loadConfiguredManager(output);
        const peer = handle.replace(/^@/, "").toLowerCase();
        await manager.remove(peer);
        emit(output, { peer, status: "removed" }, [`Removed @${peer}.`]);
      }),
    );
}
