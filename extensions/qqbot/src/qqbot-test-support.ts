// Qqbot plugin module implements qqbot test support behavior.
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";

type RegisterTempDirCleanup = (cleanup: () => void) => unknown;

/** Creates plugin-owned temp directories that the supplied test hook removes. */
export function useAutoCleanupTempDirTracker(registerCleanup: RegisterTempDirCleanup) {
  const dirs = new Set<string>();
  registerCleanup(() => {
    for (const dir of dirs) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    dirs.clear();
  });
  return {
    make(prefix: string): string {
      // openclaw-temp-dir: allow extension-local test support cannot import the core-only tracker.
      const dir = fs.mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), prefix));
      dirs.add(dir);
      return dir;
    },
  };
}

export function makeQqbotSecretRefConfig(): OpenClawConfig {
  return {
    channels: {
      qqbot: {
        appId: "123456",
        clientSecret: {
          source: "env",
          provider: "default",
          id: "QQBOT_CLIENT_SECRET",
        },
      },
    },
  } as OpenClawConfig;
}

export function makeQqbotDefaultAccountConfig(): OpenClawConfig {
  return {
    channels: {
      qqbot: {
        defaultAccount: "bot2",
        accounts: {
          bot2: { appId: "123456" },
        },
      },
    },
  } as OpenClawConfig;
}
