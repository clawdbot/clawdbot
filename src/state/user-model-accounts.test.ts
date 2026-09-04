import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseByPath,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import {
  clearUserProfileAuthLink,
  connectUserModelAccount,
  isUserModelAuthProfileOwner,
  listUserModelAccounts,
  listUserProfileAuthLinks,
  readUserModelAccountSummary,
  readUserModelAuthProfile,
  resolveUserProfileAuthLink,
  setUserProfileAuthLink,
  updateUserModelAuthProfile,
} from "./user-model-accounts.js";
import { ensureProfileForEmail, linkEmail } from "./user-profiles.js";

const tempDirs = createTempDirTracker();
const statePaths: string[] = [];

function stateOptions() {
  const path = join(tempDirs.make("user-model-accounts-"), "openclaw.sqlite");
  statePaths.push(path);
  return { path };
}

function hasPrivateAccountState(
  profileId: string,
  options: ReturnType<typeof stateOptions>,
): boolean {
  const { db } = openOpenClawStateDatabase(options);
  return (
    tableExists(db, "secret_store_entries") &&
    executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<Pick<DB, "secret_store_entries">>(db)
        .selectFrom("secret_store_entries")
        .select("name")
        .where("scope_kind", "=", "identity")
        .where("scope_id", "=", profileId)
        .where((eb) =>
          eb.or([eb("name", "=", "model-accounts"), eb("name", "like", "model-account:%")]),
        ),
    ) !== undefined
  );
}

afterEach(() => {
  for (const path of statePaths.splice(0)) {
    closeOpenClawStateDatabaseByPath(path);
  }
  tempDirs.cleanup();
});

function connectToken(
  ownerProfileId: string,
  options: ReturnType<typeof stateOptions>,
  token = "synthetic-personal-token",
) {
  return connectUserModelAccount(
    {
      ownerProfileId,
      credential: { type: "token", provider: "anthropic", token },
      matchesCredential: (current) => current.type === "token",
      assertCurrent: vi.fn(),
    },
    options,
  );
}

describe("personal model accounts", () => {
  it("links, replaces per provider, and unlinks", () => {
    const options = stateOptions();
    const profile = ensureProfileForEmail("alice@example.test", options);
    expect(
      setUserProfileAuthLink(
        { profileId: profile.id, provider: "openai", authProfileId: "openai:alice" },
        options,
      ),
    ).toMatchObject([{ provider: "openai", authProfileId: "openai:alice" }]);
    const replaced = setUserProfileAuthLink(
      { profileId: profile.id, provider: "openai", authProfileId: "openai:alice-work" },
      options,
    );
    expect(replaced).toMatchObject([{ provider: "openai", authProfileId: "openai:alice-work" }]);
    const twoProviders = setUserProfileAuthLink(
      { profileId: profile.id, provider: "anthropic", authProfileId: "anthropic:alice" },
      options,
    );
    expect(twoProviders.map((link) => link.provider)).toEqual(["anthropic", "openai"]);
    expect(
      clearUserProfileAuthLink({ profileId: profile.id, provider: "openai" }, options),
    ).toMatchObject([{ provider: "anthropic", authProfileId: "anthropic:alice" }]);
    expect(listUserProfileAuthLinks(profile.id, options)).toHaveLength(1);
  });

  it("keeps absent credential storage absent on reads", () => {
    const options = stateOptions();
    const profile = ensureProfileForEmail("lazy@example.com", options);

    expect(listUserProfileAuthLinks(profile.id, options)).toEqual([]);
    expect(listUserModelAccounts({ profileId: profile.id }, options)).toEqual({ accounts: [] });
    expect(hasPrivateAccountState(profile.id, options)).toBe(false);
  });

  it("retains a normalized personal API key across reopen without exposing it in inventory", () => {
    const options = stateOptions();
    const alice = ensureProfileForEmail("key-alice@example.test", options);
    const bob = ensureProfileForEmail("key-bob@example.test", options);
    const { authProfileId } = connectUserModelAccount(
      {
        ownerProfileId: alice.id,
        credential: {
          type: "api_key",
          provider: "xai",
          key: "  synthetic-personal-api-key\r\n",
          displayName: "Personal Grok",
          metadata: { account: "synthetic-account" },
        },
        assertCurrent() {},
      },
      options,
    );

    closeOpenClawStateDatabaseByPath(options.path);

    expect(readUserModelAuthProfile(authProfileId, options)?.credential).toEqual({
      type: "api_key",
      provider: "xai",
      key: "synthetic-personal-api-key",
      displayName: "Personal Grok",
      metadata: { account: "synthetic-account" },
    });
    expect(listUserModelAccounts({ profileId: alice.id }, options)).toEqual({
      accounts: [
        {
          authProfileId,
          provider: "xai",
          label: "Personal Grok",
          authType: "api_key",
          selected: true,
        },
      ],
    });
    expect(listUserModelAccounts({ profileId: bob.id }, options)).toEqual({ accounts: [] });
  });

  it.each([
    {
      name: "API-key SecretRef",
      credential: {
        type: "api_key",
        provider: "xai",
        keyRef: { source: "env", provider: "default", id: "XAI_API_KEY" },
      },
    },
    {
      name: "token SecretRef",
      credential: {
        type: "token",
        provider: "synthetic",
        tokenRef: { source: "env", provider: "default", id: "SYNTHETIC_TOKEN" },
      },
    },
    {
      name: "inline API-key reference",
      credential: { type: "api_key", provider: "xai", key: "${XAI_API_KEY}" },
    },
    {
      name: "inline token reference",
      credential: { type: "token", provider: "synthetic", token: "$SYNTHETIC_TOKEN" },
    },
    {
      name: "portable credential",
      credential: {
        type: "api_key",
        provider: "xai",
        key: "synthetic-personal-key",
        copyToAgents: true,
      },
    },
  ] satisfies Array<{ name: string; credential: AuthProfileCredential }>)(
    "rejects personal $name without changing owner state",
    ({ credential }) => {
      const options = stateOptions();
      const owner = ensureProfileForEmail("inline-owner@example.test", options);
      expect(() =>
        connectUserModelAccount(
          { ownerProfileId: owner.id, credential, assertCurrent() {} },
          options,
        ),
      ).toThrow();
      expect(listUserProfileAuthLinks(owner.id, options)).toEqual([]);
      expect(hasPrivateAccountState(owner.id, options)).toBe(false);
    },
  );

  it("lists retained owned accounts without secrets and can select them again after clearing a default", () => {
    const options = stateOptions();
    const alice = ensureProfileForEmail("inventory-alice@example.test", options);
    const bob = ensureProfileForEmail("inventory-bob@example.test", options);
    const first = connectUserModelAccount(
      {
        ownerProfileId: alice.id,
        credential: {
          type: "oauth",
          provider: "openai",
          email: "account@example.test",
          access: "synthetic-inventory-access",
          refresh: "synthetic-inventory-refresh",
          expires: 123,
        },
        assertCurrent() {},
      },
      options,
    );
    const second = connectToken(alice.id, options);
    const expected = [
      {
        authProfileId: first.authProfileId,
        provider: "openai",
        label: "account@example.test",
        authType: "oauth",
        selected: true,
      },
      {
        authProfileId: second.authProfileId,
        provider: "anthropic",
        label: "anthropic",
        authType: "token",
        selected: true,
      },
    ].toSorted((a, b) => a.authProfileId.localeCompare(b.authProfileId));
    expect(listUserModelAccounts({ profileId: alice.id }, options)).toEqual({ accounts: expected });
    expect(listUserModelAccounts({ profileId: bob.id }, options)).toEqual({ accounts: [] });
    expect(
      readUserModelAccountSummary(
        { profileId: bob.id, authProfileId: first.authProfileId },
        options,
      ),
    ).toBeUndefined();
    expect(
      isUserModelAuthProfileOwner(
        { profileId: bob.id, authProfileId: first.authProfileId },
        options,
      ),
    ).toBe(false);

    clearUserProfileAuthLink({ profileId: alice.id, provider: "openai" }, options);
    closeOpenClawStateDatabaseByPath(options.path);
    expect(
      readUserModelAccountSummary(
        { profileId: alice.id, authProfileId: first.authProfileId },
        options,
      ),
    ).toMatchObject({ label: "account@example.test", selected: false });
    expect(
      isUserModelAuthProfileOwner(
        { profileId: alice.id, authProfileId: first.authProfileId },
        options,
      ),
    ).toBe(true);
    setUserProfileAuthLink(
      { profileId: alice.id, provider: "openai", authProfileId: first.authProfileId },
      options,
    );
    expect(listUserModelAccounts({ profileId: alice.id }, options)).toEqual({ accounts: expected });
  });

  it("paginates only the current owner's retained accounts without losing the selected one", () => {
    const options = stateOptions();
    const alice = ensureProfileForEmail("pages-alice@example.test", options);
    const bob = ensureProfileForEmail("pages-bob@example.test", options);
    connectToken(bob.id, options);
    const ids = Array.from(
      { length: 51 },
      (_, index) =>
        connectUserModelAccount(
          {
            ownerProfileId: alice.id,
            credential: { type: "token", provider: "anthropic", token: `synthetic-page-${index}` },
            assertCurrent() {},
          },
          options,
        ).authProfileId,
    );
    const first = listUserModelAccounts({ profileId: alice.id }, options);
    expect(first.accounts).toHaveLength(50);
    expect(first.nextCursor).toBeDefined();
    const second = listUserModelAccounts(
      { profileId: alice.id, cursor: first.nextCursor },
      options,
    );
    expect(second.accounts).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    const all = [...first.accounts, ...second.accounts];
    expect(all.map((account) => account.authProfileId)).toEqual(ids.toSorted());
    expect(
      all.filter((account) => account.selected).map((account) => account.authProfileId),
    ).toEqual([ids.at(-1)]);
  });

  it("rejects links for unknown profiles", () => {
    const options = stateOptions();
    expect(() =>
      setUserProfileAuthLink(
        { profileId: "missing", provider: "openai", authProfileId: "openai:x" },
        options,
      ),
    ).toThrow("owner is unavailable");
  });

  it("resolves through provider preference order without creating storage", () => {
    const options = stateOptions();
    const profile = ensureProfileForEmail("bob@example.test", options);
    expect(
      resolveUserProfileAuthLink({ profileId: profile.id, providers: ["openai"] }, options),
    ).toBeUndefined();
    expect(hasPrivateAccountState(profile.id, options)).toBe(false);
    setUserProfileAuthLink(
      { profileId: profile.id, provider: "openai", authProfileId: "openai:bob" },
      options,
    );
    setUserProfileAuthLink(
      { profileId: profile.id, provider: "anthropic", authProfileId: "anthropic:bob" },
      options,
    );
    expect(
      resolveUserProfileAuthLink(
        { profileId: profile.id, providers: ["anthropic", "openai"] },
        options,
      ),
    ).toBe("anthropic:bob");
    expect(
      resolveUserProfileAuthLink({ profileId: profile.id, providers: ["openai"] }, options),
    ).toBe("openai:bob");
    expect(
      resolveUserProfileAuthLink({ profileId: profile.id, providers: ["mistral"] }, options),
    ).toBeUndefined();
  });

  it("returns undefined when the state database does not exist", () => {
    const options = stateOptions();
    expect(
      resolveUserProfileAuthLink({ profileId: "anyone", providers: ["openai"] }, options),
    ).toBeUndefined();
    expect(existsSync(options.path)).toBe(false);
  });

  it("follows profile merges: target links win, source links backfill", () => {
    const options = stateOptions();
    const source = ensureProfileForEmail("carol-old@example.test", options);
    const target = ensureProfileForEmail("carol@example.test", options);
    setUserProfileAuthLink(
      { profileId: source.id, provider: "openai", authProfileId: "openai:carol-old" },
      options,
    );
    setUserProfileAuthLink(
      { profileId: source.id, provider: "anthropic", authProfileId: "anthropic:carol" },
      options,
    );
    setUserProfileAuthLink(
      { profileId: target.id, provider: "openai", authProfileId: "openai:carol" },
      options,
    );
    // Merging the source into the target repoints the alias and its links.
    linkEmail("carol-old@example.test", target.id, options);
    const links = listUserProfileAuthLinks(target.id, options);
    expect(links).toMatchObject([
      { provider: "anthropic", authProfileId: "anthropic:carol" },
      { provider: "openai", authProfileId: "openai:carol" },
    ]);
    // The merged source id resolves to the target's links.
    expect(
      resolveUserProfileAuthLink({ profileId: source.id, providers: ["openai"] }, options),
    ).toBe("openai:carol");
  });

  it("replaces only owned credentials, retaining exact session pins after unlink", () => {
    const options = stateOptions();
    const alice = ensureProfileForEmail("alice@example.test", options);
    const bob = ensureProfileForEmail("bob@example.test", options);
    setUserProfileAuthLink(
      { profileId: alice.id, provider: "anthropic", authProfileId: "anthropic:shared" },
      options,
    );
    const first = connectToken(alice.id, options);
    expect(first.authProfileId).not.toBe("anthropic:shared");
    const reconnect = connectToken(alice.id, options, "synthetic-new-token");
    expect(reconnect.authProfileId).toBe(first.authProfileId);
    expect(() =>
      setUserProfileAuthLink(
        {
          profileId: bob.id,
          provider: "anthropic",
          authProfileId: first.authProfileId,
        },
        options,
      ),
    ).toThrow("does not belong");
    expect(listUserProfileAuthLinks(bob.id, options)).toEqual([]);

    clearUserProfileAuthLink({ profileId: alice.id, provider: "anthropic" }, options);
    expect(
      resolveUserProfileAuthLink({ profileId: alice.id, providers: ["anthropic"] }, options),
    ).toBeUndefined();
    expect(readUserModelAuthProfile(first.authProfileId, options)?.credential).toMatchObject({
      token: "synthetic-new-token",
    });
  });

  it("commits neither credential nor link when final authorization is revoked", () => {
    const options = stateOptions();
    const alice = ensureProfileForEmail("alice@example.test", options);
    expect(() =>
      connectUserModelAccount(
        {
          ownerProfileId: alice.id,
          credential: { type: "token", provider: "anthropic", token: "synthetic-revoked-token" },
          assertCurrent: () => {
            throw new Error("revoked");
          },
        },
        options,
      ),
    ).toThrow("revoked");
    expect(listUserProfileAuthLinks(alice.id, options)).toEqual([]);
    expect(hasPrivateAccountState(alice.id, options)).toBe(false);
  });

  it("preserves private refresh and usage updates across reopen without changing the link", () => {
    const options = stateOptions();
    const alice = ensureProfileForEmail("alice@example.test", options);
    const { authProfileId } = connectToken(alice.id, options);
    expect(
      updateUserModelAuthProfile(
        authProfileId,
        (current) => {
          current.credential = {
            type: "token",
            provider: "anthropic",
            token: "synthetic-rotated-token",
          };
          current.usageStats = { lastUsed: 42, cooldownUntil: 99, cooldownReason: "rate_limit" };
          return true;
        },
        options,
      ),
    ).toBe(true);
    expect(
      updateUserModelAuthProfile(
        authProfileId,
        (current) => {
          current.credential = {
            type: "token",
            provider: "anthropic",
            token: "synthetic-stale-token",
          };
          return false;
        },
        options,
      ),
    ).toBe(false);
    closeOpenClawStateDatabaseByPath(options.path);
    expect(readUserModelAuthProfile(authProfileId, options)).toMatchObject({
      credential: { token: "synthetic-rotated-token" },
      usageStats: { lastUsed: 42, cooldownUntil: 99, cooldownReason: "rate_limit" },
    });
    expect(
      resolveUserProfileAuthLink({ profileId: alice.id, providers: ["anthropic"] }, options),
    ).toBe(authProfileId);
  });

  it("transfers old session pins on identity merge without reviving explicit disconnections", () => {
    const options = stateOptions();
    const source = ensureProfileForEmail("source@example.test", options);
    const target = ensureProfileForEmail("target@example.test", options);
    const { authProfileId } = connectToken(source.id, options);
    clearUserProfileAuthLink({ profileId: target.id, provider: "anthropic" }, options);
    linkEmail("source@example.test", target.id, options);
    expect(isUserModelAuthProfileOwner({ profileId: target.id, authProfileId }, options)).toBe(
      true,
    );
    expect(listUserProfileAuthLinks(target.id, options)).toEqual([]);
    expect(readUserModelAuthProfile(authProfileId, options)?.credential).toMatchObject({
      token: "synthetic-personal-token",
    });
    const { db } = openOpenClawStateDatabase(options);
    const stranded = executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<Pick<DB, "secret_store_entries">>(db)
        .selectFrom("secret_store_entries")
        .select("scope_id")
        .where("scope_kind", "=", "identity")
        .where("scope_id", "=", source.id)
        .where((eb) =>
          eb.or([eb("name", "=", "model-accounts"), eb("name", "like", "model-account:%")]),
        ),
    );
    expect(stranded).toBeUndefined();
    expect(() => connectToken(source.id, options)).toThrow("owner changed");
  });

  it("merges individually valid credentials without imposing a combined secret-size limit", () => {
    const options = stateOptions();
    const source = ensureProfileForEmail("source@example.test", options);
    const target = ensureProfileForEmail("target@example.test", options);
    const sourceToken = "synthetic-source-".repeat(2800);
    const targetToken = "synthetic-target-".repeat(2800);
    const sourceAccount = connectToken(source.id, options, sourceToken);
    const targetAccount = connectToken(target.id, options, targetToken);

    linkEmail("source@example.test", target.id, options);

    expect(
      readUserModelAuthProfile(sourceAccount.authProfileId, options)?.credential,
    ).toMatchObject({ token: sourceToken });
    expect(
      readUserModelAuthProfile(targetAccount.authProfileId, options)?.credential,
    ).toMatchObject({ token: targetToken });
    expect(
      resolveUserProfileAuthLink({ profileId: target.id, providers: ["anthropic"] }, options),
    ).toBe(targetAccount.authProfileId);
  });
});
