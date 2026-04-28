import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { withEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { inspectTelegramAccount } from "./account-inspect.js";

describe("inspectTelegramAccount SecretRef resolution", () => {
  it("resolves default env SecretRef templates in read-only status paths", () => {
    withEnv({ TG_STATUS_TOKEN: "123:token" }, () => {
      const cfg: OpenClawConfig = {
        channels: {
          telegram: {
            botToken: "${TG_STATUS_TOKEN}",
          },
        },
      };

      const account = inspectTelegramAccount({ cfg, accountId: "default" });
      expect(account.tokenSource).toBe("env");
      expect(account.tokenStatus).toBe("available");
      expect(account.token).toBe("123:token");
    });
  });

  it("respects env provider allowlists in read-only status paths", () => {
    withEnv({ TG_NOT_ALLOWED: "123:token" }, () => {
      const cfg: OpenClawConfig = {
        secrets: {
          defaults: {
            env: "secure-env",
          },
          providers: {
            "secure-env": {
              source: "env",
              allowlist: ["TG_ALLOWED"],
            },
          },
        },
        channels: {
          telegram: {
            botToken: "${TG_NOT_ALLOWED}",
          },
        },
      };

      const account = inspectTelegramAccount({ cfg, accountId: "default" });
      expect(account.tokenSource).toBe("env");
      expect(account.tokenStatus).toBe("configured_unavailable");
      expect(account.token).toBe("");
    });
  });

  it("does not read env values for non-env providers", () => {
    withEnv({ TG_EXEC_PROVIDER: "123:token" }, () => {
      const cfg: OpenClawConfig = {
        secrets: {
          defaults: {
            env: "exec-provider",
          },
          providers: {
            "exec-provider": {
              source: "exec",
              command: "/usr/bin/env",
            },
          },
        },
        channels: {
          telegram: {
            botToken: "${TG_EXEC_PROVIDER}",
          },
        },
      };

      const account = inspectTelegramAccount({ cfg, accountId: "default" });
      expect(account.tokenSource).toBe("env");
      expect(account.tokenStatus).toBe("configured_unavailable");
      expect(account.token).toBe("");
    });
  });

  it.runIf(process.platform !== "win32")(
    "treats symlinked token files as configured_unavailable",
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-inspect-"));
      const tokenFile = path.join(dir, "token.txt");
      const tokenLink = path.join(dir, "token-link.txt");
      fs.writeFileSync(tokenFile, "123:token\n", "utf8");
      fs.symlinkSync(tokenFile, tokenLink);

      const cfg: OpenClawConfig = {
        channels: {
          telegram: {
            tokenFile: tokenLink,
          },
        },
      };

      const account = inspectTelegramAccount({ cfg, accountId: "default" });
      expect(account.tokenSource).toBe("tokenFile");
      expect(account.tokenStatus).toBe("configured_unavailable");
      expect(account.token).toBe("");
      fs.rmSync(dir, { recursive: true, force: true });
    },
  );
});
