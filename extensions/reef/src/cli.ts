// Reef plugin module implements headless CLI behavior. Every command is
// non-interactive so agents can register a claw and manage friendships when
// asked to by their owner; --json emits machine-readable results.
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { mutateConfigFile } from "openclaw/plugin-sdk/config-mutation";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { fingerprint } from "../protocol/index.js";
import { ReefChannelConfigSchema, type ReefChannelConfig } from "./config-schema.js";
import { ReefFriendManager } from "./friends.js";
import { getReefRuntime } from "./runtime.js";
import { generateAndStoreKeys, loadKeys, resolveStateDir, writePrivateJson } from "./state.js";
import { ReefTransportClient } from "./transport.js";
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

async function loadOrCreateKeys(stateDir: string, createMissing: boolean): Promise<ReefKeys> {
  try {
    return await loadKeys(stateDir);
  } catch (error) {
    // Only a missing key file may mint a new identity. Replacing keys on
    // corruption or I/O failures would orphan the relay handle and every
    // pinned friendship bound to the old public keys.
    if (createMissing && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return await generateAndStoreKeys(stateDir);
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
  const stateDir = resolveStateDir(config.stateDir);
  const keys = await loadOrCreateKeys(stateDir, false);
  const transport = new ReefTransportClient(config.relayUrl, config.handle, keys);
  return { config, keys, manager: new ReefFriendManager(config, transport, stateDir) };
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
      // Merge friends/allowFrom from the live draft, not a pre-auth snapshot,
      // so a concurrently running gateway's approvals are not overwritten —
      // but only for the SAME identity. A different handle, relay, or state
      // dir is a new identity and must not inherit the old trust pins.
      const existing = (draft.channels?.reef ?? {}) as {
        handle?: string;
        relayUrl?: string;
        stateDir?: string;
        friends?: Record<string, unknown>;
        allowFrom?: unknown[];
      };
      const sameIdentity =
        existing.handle === candidate.handle &&
        existing.relayUrl === candidate.relayUrl &&
        resolveStateDir(existing.stateDir) === resolveStateDir(candidate.stateDir);
      draft.channels = {
        ...draft.channels,
        reef: {
          ...candidate,
          friends: sameIdentity ? (existing.friends ?? {}) : {},
          allowFrom: sameIdentity ? (existing.allowFrom ?? []) : [],
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
  const stateDir = resolveStateDir(options.stateDir);
  const requestedHandle = options.handle?.toLowerCase();
  // One state dir is one identity. Reusing existing keys for a different handle
  // or relay would link supposedly separate identities under a single
  // fingerprint. The binding is persisted beside the keys so the check holds
  // even if the channel config was deleted or points elsewhere.
  const identityPath = join(stateDir, "identity.json");
  const identity = await readFile(identityPath, "utf8").then(
    (raw) => JSON.parse(raw) as { handle?: string; relayUrl?: string },
    () => undefined,
  );
  if (
    identity?.handle &&
    (identity.handle !== requestedHandle || identity.relayUrl !== options.relay)
  ) {
    return await fail(
      output,
      `This state dir already holds the identity @${identity.handle} on ${identity.relayUrl}. Re-register the same handle and relay, or pass a fresh --state-dir for a new identity.`,
    );
  }
  const keys = await loadOrCreateKeys(stateDir, true);

  const bootstrap = new ReefTransportClient(options.relay, options.handle ?? "pending", keys);
  const sessionPath = join(stateDir, "setup-session.json");
  // A previously exchanged session is reused from the key store so retries
  // never need the single-use token again and the credential never appears in
  // command output or automation logs. It is scoped to the relay and email it
  // was minted for, and explicit --session/--token always take precedence, so
  // stale state can never reach another account or origin.
  const stored = await readFile(sessionPath, "utf8").then(
    (raw) => JSON.parse(raw) as { session?: string; relayUrl?: string; email?: string },
    () => undefined,
  );
  const token = options.token?.trim();
  const storedSession =
    !options.session?.trim() &&
    stored?.relayUrl === options.relay &&
    stored?.email === options.email
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
  const handle = options.handle?.toLowerCase();
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
    relayUrl: options.relay,
    handle,
    email: options.email,
    requestPolicy: options.policy,
    stateDir,
    friends: {},
    dmPolicy: "pairing",
    allowFrom: [],
    guard,
  };
  ReefChannelConfigSchema.parse(provisional);

  let resolvedSession = session;
  if (!resolvedSession) {
    resolvedSession = (await bootstrap.authComplete(token ?? "")).session;
    await writePrivateJson(sessionPath, {
      session: resolvedSession,
      relayUrl: options.relay,
      email: options.email,
    });
  }
  const transport = new ReefTransportClient(options.relay, handle, keys);
  let effectivePolicy = options.policy;
  try {
    await transport.createHandle(resolvedSession, options.policy);
  } catch (error) {
    // The relay rejects duplicates outright, so a retried registration (or a
    // config-write failure after a successful claim) hits handle_unavailable.
    // A device-signed read only succeeds when OUR key owns the handle; treat
    // that as the claim already being done instead of stranding the retry.
    const unavailable = error instanceof Error && error.message.includes("handle_unavailable");
    const owned =
      unavailable &&
      (await transport.listFriends().then(
        () => true,
        () => false,
      ));
    if (!owned) {
      throw error;
    }
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
  await writePrivateJson(identityPath, { handle, relayUrl: options.relay });
  await rm(sessionPath, { force: true });

  const printed = fingerprint(keys.signing.publicKey, keys.encryption.publicKey);
  emit(
    output,
    { status: "registered", handle, relayUrl: options.relay, stateDir, fingerprint: printed },
    [
      `Registered @${handle} on ${options.relay}.`,
      `Safety fingerprint (share out of band): ${printed}`,
      "Restart the gateway to connect: openclaw gateway restart",
    ],
  );
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
    .option("--relay <url>", "Relay URL", "https://reefwire.ai")
    .option("--policy <policy>", "Inbound friend-request policy", "code-only")
    .option("--state-dir <dir>", "Local key/state directory")
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
        await mutateConfigFile({
          afterWrite: { mode: "auto" },
          mutate(draft: OpenClawConfig) {
            const reefDraft = draft.channels?.reef as
              | { friends?: Record<string, unknown>; allowFrom?: unknown[] }
              | undefined;
            if (reefDraft?.friends) {
              delete reefDraft.friends[peer];
            }
            // Removal must fully revoke: the pairing-derived allowlist entry
            // would otherwise re-authorize the peer without a fresh approval.
            if (Array.isArray(reefDraft?.allowFrom)) {
              reefDraft.allowFrom = reefDraft.allowFrom.filter(
                (entry) => String(entry).replace(/^@/, "").toLowerCase() !== peer,
              );
            }
          },
        });
        emit(output, { peer, status: "removed" }, [`Removed @${peer}.`]);
      }),
    );
}
