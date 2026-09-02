// Nextcloud Talk tests cover accounts plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listNextcloudTalkAccountIds,
  resolveDefaultNextcloudTalkAccountId,
  resolveNextcloudTalkAccount,
} from "./accounts.js";
import type { CoreConfig } from "./types.js";

describe("Nextcloud Talk account resolution", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("preserves top-level default account when named accounts are configured", () => {
    const cfg = {
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
          botSecret: "shared-secret",
          accounts: {
            work: { enabled: false },
          },
        },
      },
    } satisfies CoreConfig;

    expect(listNextcloudTalkAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultNextcloudTalkAccountId(cfg)).toBe("default");
    expect(resolveNextcloudTalkAccount({ cfg })).toMatchObject({
      accountId: "default",
      baseUrl: "https://cloud.example.com",
      secret: "shared-secret",
    });
  });

  it("inherits and overrides inbound media config through normal account resolution", () => {
    const cfg = {
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
          botSecret: "shared-secret",
          mediaAllowFrom: ["nextcloud-talk:alice"],
          mediaMaxMb: 20,
          accounts: {
            inherited: {},
            restricted: { mediaAllowFrom: ["*"], mediaMaxMb: 5 },
          },
        },
      },
    } satisfies CoreConfig;

    expect(resolveNextcloudTalkAccount({ cfg }).config.mediaAllowFrom).toEqual([
      "nextcloud-talk:alice",
    ]);
    expect(
      resolveNextcloudTalkAccount({ cfg, accountId: "inherited" }).config.mediaAllowFrom,
    ).toEqual(["nextcloud-talk:alice"]);
    expect(
      resolveNextcloudTalkAccount({ cfg, accountId: "restricted" }).config.mediaAllowFrom,
    ).toEqual(["*"]);
    expect(resolveNextcloudTalkAccount({ cfg }).config.mediaMaxMb).toBe(20);
    expect(resolveNextcloudTalkAccount({ cfg, accountId: "inherited" }).config.mediaMaxMb).toBe(20);
    expect(resolveNextcloudTalkAccount({ cfg, accountId: "restricted" }).config.mediaMaxMb).toBe(5);
  });

  it("isolates unavailable default and named account SecretRefs from ambient credentials", () => {
    vi.stubEnv("NEXTCLOUD_TALK_BOT_SECRET", "ambient-secret");
    const unavailableSecret = {
      source: "env",
      provider: "default",
      id: "MISSING_NEXTCLOUD_TALK_SECRET",
    } as const;
    const cfg = {
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
          botSecret: unavailableSecret,
          accounts: {
            work: { botSecret: unavailableSecret },
            healthy: { botSecret: "healthy-secret" },
          },
        },
      },
    } satisfies CoreConfig;

    for (const accountId of ["default", "work"]) {
      expect(resolveNextcloudTalkAccount({ cfg, accountId })).toMatchObject({
        accountId,
        secret: "",
        secretSource: "config",
        tokenStatus: "configured_unavailable",
      });
    }
    expect(resolveNextcloudTalkAccount({ cfg, accountId: "healthy" })).toMatchObject({
      secret: "healthy-secret",
      tokenStatus: "available",
    });
  });

  it("preserves default env, file, then plaintext precedence without a SecretRef", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nextcloud-talk-secret-"));
    const secretFile = path.join(directory, "bot-secret");
    fs.writeFileSync(secretFile, "file-secret\n", "utf8");

    try {
      const cfg = {
        channels: {
          "nextcloud-talk": {
            baseUrl: "https://cloud.example.com",
            botSecret: "plaintext-secret",
            botSecretFile: secretFile,
          },
        },
      } satisfies CoreConfig;

      vi.stubEnv("NEXTCLOUD_TALK_BOT_SECRET", "ambient-secret");
      expect(resolveNextcloudTalkAccount({ cfg })).toMatchObject({
        secret: "ambient-secret",
        secretSource: "env",
      });

      vi.stubEnv("NEXTCLOUD_TALK_BOT_SECRET", "");
      expect(resolveNextcloudTalkAccount({ cfg })).toMatchObject({
        secret: "file-secret",
        secretSource: "secretFile",
      });

      const withoutSecretFile = {
        channels: {
          "nextcloud-talk": { ...cfg.channels["nextcloud-talk"], botSecretFile: undefined },
        },
      } satisfies CoreConfig;
      expect(resolveNextcloudTalkAccount({ cfg: withoutSecretFile })).toMatchObject({
        secret: "plaintext-secret",
        secretSource: "config",
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
