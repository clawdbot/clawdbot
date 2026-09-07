import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  createRuntimeConfigReader,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDiscordLivePolicyReader } from "./live-policy.js";
import type { resolveDiscordAllowlistConfig } from "./provider.allowlist.js";

const mocks = vi.hoisted(() => ({
  resolveAllowlist: vi.fn<typeof resolveDiscordAllowlistConfig>(),
}));
vi.mock("./provider.allowlist.js", () => ({
  resolveDiscordAllowlistConfig: mocks.resolveAllowlist,
}));

type ResolvedAllowlist = Awaited<ReturnType<typeof resolveDiscordAllowlistConfig>>;
const publish = (cfg: OpenClawConfig) => setRuntimeConfigSnapshot(cfg, cfg);
const config = (allowFrom: string[]): OpenClawConfig => ({
  channels: { discord: { token: "synthetic-token", allowFrom, dmPolicy: "allowlist" } },
});

beforeEach(() => {
  mocks.resolveAllowlist.mockReset();
  mocks.resolveAllowlist.mockImplementation(async ({ guildEntries, allowFrom }) => ({
    guildEntries: guildEntries as ResolvedAllowlist["guildEntries"],
    allowFrom: allowFrom as string[] | undefined,
  }));
});
afterEach(() => clearRuntimeConfigSnapshot());

describe("Discord live account policy", () => {
  it("keeps the admitted runtime owner across startup and allowlist resolution", async () => {
    const cfg = config(["startup-name"]);
    publish(cfg);
    const readConfig = createRuntimeConfigReader(cfg);
    const startup = createDeferred<ResolvedAllowlist>();
    const start = async () =>
      createDiscordLivePolicyReader({
        cfg,
        accountId: "default",
        readConfig,
        resolvedAllowlist: await startup.promise,
      });
    const pending = start();
    publish(config(["published-during-startup"]));
    startup.resolve({ guildEntries: undefined, allowFrom: ["old-resolved-id"] });
    const readPolicy = await pending;
    expect((await readPolicy()).allowFrom).toEqual(["published-during-startup"]);
    publish(config(["later-policy"]));
    expect((await readPolicy()).allowFrom).toEqual(["later-policy"]);
  });

  it("preserves prepared named-account policy until an authored policy changes", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        discord: {
          token: "synthetic-token",
          dmPolicy: "disabled",
          allowFrom: ["root"],
          accounts: { work: { dmPolicy: "allowlist", allowFrom: ["configured-name"] } },
        },
      },
    };
    publish(cfg);
    const read = createDiscordLivePolicyReader({
      cfg,
      accountId: "work",
      token: "synthetic-token",
      discordConfig: {
        dmPolicy: "allowlist",
        allowFrom: ["prepared-name"],
        dm: { enabled: false },
      },
      resolvedAllowlist: { guildEntries: { "111": { users: ["222"] } }, allowFrom: ["222"] },
    });
    const preparedPolicy = await read();
    expect(preparedPolicy.isCurrent()).toBe(true);
    expect(preparedPolicy).toMatchObject({
      accountId: "work",
      dmPolicy: "allowlist",
      dmEnabled: false,
      allowFrom: ["222"],
      guildEntries: { "111": { users: ["222"] } },
    });
    publish({ ...cfg, messages: { inbound: { debounceMs: 50 } } });
    expect(preparedPolicy.isCurrent()).toBe(true);
    expect(await read()).toMatchObject({ dmEnabled: false, allowFrom: ["222"] });
    expect(mocks.resolveAllowlist).not.toHaveBeenCalled();

    const cleared: OpenClawConfig = {
      channels: {
        discord: {
          ...cfg.channels?.discord,
          accounts: { work: { dmPolicy: "allowlist", allowFrom: [] } },
        },
      },
    };
    publish(cleared);
    expect(preparedPolicy.isCurrent()).toBe(false);
    expect(await read()).toMatchObject({ dmEnabled: true, allowFrom: [] });
    mocks.resolveAllowlist.mockResolvedValueOnce({ guildEntries: undefined, allowFrom: ["333"] });
    publish(cfg);
    expect(preparedPolicy.isCurrent()).toBe(false);
    expect(await read()).toMatchObject({ dmEnabled: true, allowFrom: ["333"] });
    expect(mocks.resolveAllowlist).toHaveBeenCalledTimes(2);
  });

  it("joins concurrent resolution and returns the latest published policy", async () => {
    const first = createDeferred<ResolvedAllowlist>();
    const next = createDeferred<ResolvedAllowlist>();
    mocks.resolveAllowlist.mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise);
    const cfg = config(["first-name"]);
    publish(cfg);
    const read = createDiscordLivePolicyReader({ cfg, accountId: "default" });
    const firstRead = read();
    const sameRevisionRead = read();
    expect(mocks.resolveAllowlist).toHaveBeenCalledTimes(1);
    const updated = config(["next-name"]);
    publish(updated);
    const nextRead = read();
    first.resolve({ guildEntries: undefined, allowFrom: ["stale-id"] });
    next.resolve({ guildEntries: undefined, allowFrom: ["current-id"] });
    const results = await Promise.all([firstRead, sameRevisionRead, nextRead]);
    for (const policy of results) {
      expect(policy.cfg).toBe(updated);
      expect(policy.allowFrom).toEqual(["current-id"]);
    }
    await read();
    expect(mocks.resolveAllowlist).toHaveBeenCalledTimes(2);
  });

  it("cannot resurrect a prepared seed when publication returns to an older config object", async () => {
    const next = createDeferred<ResolvedAllowlist>();
    const reverted = createDeferred<ResolvedAllowlist>();
    mocks.resolveAllowlist.mockReturnValueOnce(next.promise).mockReturnValueOnce(reverted.promise);
    const cfg = config(["original-name"]);
    publish(cfg);
    const read = createDiscordLivePolicyReader({
      cfg,
      accountId: "default",
      resolvedAllowlist: { guildEntries: undefined, allowFrom: ["prepared-id"] },
    });
    const initialRead = read();
    publish(config(["changed-name"]));
    const nextRead = read();
    publish(cfg);
    const revertedRead = read();
    next.resolve({ guildEntries: undefined, allowFrom: ["changed-id"] });
    reverted.resolve({ guildEntries: undefined, allowFrom: ["re-resolved-id"] });
    for (const policy of await Promise.all([initialRead, nextRead, revertedRead])) {
      expect(policy.allowFrom).toEqual(["re-resolved-id"]);
    }
  });

  it("does not admit a resolved policy after its account lifetime ends", async () => {
    const resolution = createDeferred<ResolvedAllowlist>();
    mocks.resolveAllowlist.mockReturnValueOnce(resolution.promise);
    const cfg = config(["pending-name"]);
    publish(cfg);
    const abort = new AbortController();
    const read = createDiscordLivePolicyReader({
      cfg,
      accountId: "default",
      abortSignal: abort.signal,
    });
    const pending = read();
    abort.abort();
    resolution.resolve({ guildEntries: undefined, allowFrom: ["resolved-id"] });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps explicitly scoped configuration independent of another runtime", async () => {
    publish(config(["global"]));
    const scoped = config(["scoped"]);
    const read = createDiscordLivePolicyReader({ cfg: scoped, accountId: "default" });
    expect((await read()).allowFrom).toEqual(["scoped"]);
    publish(config(["different-global"]));
    expect((await read()).cfg).toBe(scoped);
    expect((await read()).allowFrom).toEqual(["scoped"]);
  });
});
