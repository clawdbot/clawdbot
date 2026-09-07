// Signal doctor repair moves authored account map keys onto their normalized account id.
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
import type { ChannelDoctorConfigMutation } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

/**
 * One decision per normalized account id, shared by the repair, the collision report and the setup
 * precondition so they cannot disagree about which authored key a reader selects. `selected` and
 * `collision` carry every key naming the id, so reporting needs no second grouping pass.
 */
type SignalAccountKeyState =
  | { kind: "selected"; keys: string[] }
  | { kind: "repairable"; key: string; dropEmptyAccount: boolean }
  | { kind: "collision"; keys: string[] };

function groupKeysBy(keys: string[], accountIdOf: (key: string) => string | undefined) {
  const grouped = new Map<string, string[]>();
  for (const key of keys) {
    const accountId = accountIdOf(key);
    if (accountId !== undefined) {
      grouped.set(accountId, [...(grouped.get(accountId) ?? []), key]);
    }
  }
  return grouped;
}

function quoteAccountKeys(keys: string[]): string {
  return keys.map((key) => `"${key}"`).join(", ");
}

/**
 * The id Signal lists a map key under. The list helper keeps every non-empty key and maps it
 * through `normalizeAccountId` (`listConfiguredAccountIds` in
 * src/channels/plugins/account-helpers.ts), which sends a key with no canonical form such as "!!!"
 * and a prototype-named key such as "__proto__" to `default` (src/routing/account-id.ts:30-35,
 * :50-56). An empty key is never listed. The assessment reads the same id, so an id the list helper
 * surfaces is either repaired onto its key or reported, and an unlisted key is left alone.
 */
function listedAccountIdOf(key: string): string | undefined {
  return key ? normalizeAccountId(key) : undefined;
}

// Signal lists accounts under normalizeAccountId(key) but the shared account resolver and the
// policy readers select the entry with the exact/case-folded lookup, so a key that normalizes to
// something else loses its account settings. Doctor owns the one-time key move and runtime keeps
// reading the canonical map. Only ids with at least one such key get a state, as every other id
// is already selected as authored.
function assessSignalAccountKeys(
  accounts: unknown,
  rootAccount?: unknown,
): Map<string, SignalAccountKeyState> {
  const states = new Map<string, SignalAccountKeyState>();
  if (!isRecord(accounts)) {
    return states;
  }
  const keys = Object.keys(accounts);
  const selectedKeysByAccountId = groupKeysBy(keys, normalizeLowercaseStringOrEmpty);
  const authoredKeysByAccountId = groupKeysBy(keys, (key) => {
    const accountId = listedAccountIdOf(key);
    // An unlisted key names no account to move the entry to, and a key the shared lookup already
    // selects under its listed id keeps its own entry.
    return !accountId || normalizeLowercaseStringOrEmpty(key) === accountId ? undefined : accountId;
  });
  const inheritedAccount = normalizeOptionalString(rootAccount);
  for (const [accountId, authoredKeys] of authoredKeysByAccountId) {
    const selectedKeys = selectedKeysByAccountId.get(accountId) ?? [];
    const authoredKey = authoredKeys[0];
    // An established winner keeps its entry and ambiguous keys keep theirs: doctor reports both
    // shapes instead of picking one, because either choice would discard authored settings.
    if (selectedKeys.length > 0) {
      states.set(accountId, { kind: "selected", keys: [...selectedKeys, ...authoredKeys] });
      continue;
    }
    if (authoredKeys.length > 1 || !authoredKey) {
      states.set(accountId, { kind: "collision", keys: authoredKeys });
      continue;
    }
    const entry = accounts[authoredKey];
    // Every account inherits the channel root number unless its own entry overrides it. The merge
    // spreads the entry over the root (src/config/channel-account-config.ts:24), and a named
    // account gets the root fields minus the transport (extensions/signal/src/accounts.ts:58-78).
    // The unselected entry never overrode that number, so the move must not let an explicitly
    // empty account override start winning, on the default account or a named one. The rule stops
    // at an empty or whitespace-only string beside a root number. Any other value is an authored
    // identity the ordinary validator owns, and doctor must not guess how to repair it.
    const dropEmptyAccount =
      Boolean(inheritedAccount) &&
      isRecord(entry) &&
      typeof entry.account === "string" &&
      !entry.account.trim();
    states.set(accountId, { kind: "repairable", key: authoredKey, dropEmptyAccount });
  }
  return states;
}

/** True when doctor can move at least one Signal account key to its normalized id. */
export function hasRepairableSignalAccountKeys(accounts: unknown): boolean {
  return [...assessSignalAccountKeys(accounts).values()].some(
    (state) => state.kind === "repairable",
  );
}

/** Report Signal account keys that share one normalized id, which doctor must not merge. */
export function listSignalAccountKeyCollisionWarnings(accounts: unknown): string[] {
  return [...assessSignalAccountKeys(accounts)].flatMap(([accountId, state]) =>
    state.kind === "repairable"
      ? []
      : [
          `- channels.signal.accounts: ${quoteAccountKeys(state.keys)} resolve to account id "${accountId}". Doctor keeps them as authored; only an existing exact or case-insensitive matching key remains selected. Rename them so one key owns the account.`,
        ],
  );
}

/** The account-map writes a setup operation runs, named by the generic writer behind each. */
type SignalSetupWrite =
  | { kind: "name" }
  | { kind: "account-config"; promote: (cfg: OpenClawConfig) => OpenClawConfig };

/**
 * Setup must not write `accountId` while its settings sit under a key the shared account resolver
 * and the policy readers do not select, since a canonical write would strand them. `write` is the
 * generic writers' account-map target set: a name write lands `accountId` alone, and an
 * account-config write also lands `default` for a default display name, plus whatever the
 * promotion a named add runs first creates or changes, with that writer (`promote`) as the oracle
 * for its own target instead of a model of it. The promotion resolves its key with the lookup the
 * adapter declares (`accountEntryLookup: "case-insensitive"` in setup-core.ts, applied by
 * `resolveExistingAccountKey` in src/channels/plugins/setup-helpers.ts), the exact key, else the
 * first case-folded key, else the canonical id, so it can only land on a key the account resolver
 * selects or on the id itself, and the guard only has to check the state of each id a writer lands
 * on.
 */
export function findSignalAccountKeySetupBlock(params: {
  cfg: OpenClawConfig;
  accountId: string;
  name?: string;
  write: SignalSetupWrite;
}): string | undefined {
  const signal = params.cfg.channels?.signal;
  const accountId = normalizeAccountId(params.accountId);
  const namedAccount = accountId !== DEFAULT_ACCOUNT_ID;
  const writesName = Boolean(params.name?.trim());
  const writesAccountConfig = params.write.kind === "account-config";
  // Only a named add promotes (src/channels/plugins/account-config-mutation.ts:141-147). The writer
  // rebuilds just the entry it targets, so an entry that kept its identity was not written.
  const promotedAccounts =
    namedAccount && params.write.kind === "account-config"
      ? params.write.promote(params.cfg).channels?.signal?.accounts
      : undefined;
  const promotedIds = Object.entries(promotedAccounts ?? {})
    .filter(([key, entry]) => signal?.accounts?.[key] !== entry)
    .flatMap(([key]) => {
      const id = listedAccountIdOf(key);
      return id ? [id] : [];
    });
  // Default numbers and transports are written at the channel root, so a default entry reaches the
  // map only through the account-map name write in applyAccountNameToChannelSection. The root-name
  // migration a named add runs in migrateBaseNameToDefaultAccount follows the promotion, which has
  // already moved that name.
  const writesDefaultEntry = !namedAccount && writesName;
  const writtenIds = [
    ...promotedIds,
    ...(namedAccount && (writesAccountConfig || writesName) ? [accountId] : []),
    ...(writesDefaultEntry ? [DEFAULT_ACCOUNT_ID] : []),
  ];
  const states = assessSignalAccountKeys(signal?.accounts);
  for (const id of writtenIds) {
    const state = states.get(id);
    const stored = `Signal account "${id}" is stored under channels.signal.accounts`;
    if (state?.kind === "repairable") {
      return `${stored}."${state.key}"; run openclaw doctor --fix to move it to its normalized key, then rerun setup.`;
    }
    if (state?.kind === "collision") {
      return `${stored} ${quoteAccountKeys(state.keys)}, which doctor cannot choose between. Rename them so one key is "${id}", then rerun setup.`;
    }
  }
  return undefined;
}

/** Move unambiguous Signal account keys onto the normalized id every reader already looks up. */
export function repairSignalAccountKeys({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const signal = cfg.channels?.signal;
  const accounts = signal?.accounts;
  const moves = new Map<string, { to: string; dropEmptyAccount: boolean }>();
  for (const [accountId, state] of assessSignalAccountKeys(accounts, signal?.account)) {
    if (state.kind === "repairable") {
      moves.set(state.key, { to: accountId, dropEmptyAccount: state.dropEmptyAccount });
    }
  }
  if (moves.size === 0 || !accounts) {
    return { config: cfg, changes: [] };
  }
  const repairedAccounts = Object.fromEntries(
    Object.entries(accounts).map(([key, entry]) => {
      const move = moves.get(key);
      if (!move) {
        return [key, entry];
      }
      if (!move.dropEmptyAccount) {
        return [move.to, entry];
      }
      const { account: _inheritedAccount, ...preserved } = entry;
      return [move.to, preserved];
    }),
  );
  return {
    config: {
      ...cfg,
      channels: { ...cfg.channels, signal: { ...signal, accounts: repairedAccounts } },
    },
    changes: [...moves].map(
      ([from, { to }]) =>
        `Moved Signal account "${from}" to its normalized key channels.signal.accounts.${to}.`,
    ),
  };
}
