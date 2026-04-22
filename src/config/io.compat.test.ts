import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyRuntimeLegacyConfigMigrations } from "../commands/doctor/shared/runtime-compat-api.js";
import { createConfigIO } from "./io.js";
import { normalizeExecSafeBinProfilesInConfig } from "./normalize-exec-safe-bin.js";
import type { OpenClawConfig } from "./types.openclaw.js";

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-"));
  try {
    await run(home);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function writeConfig(
  home: string,
  dirname: ".openclaw",
  port: number,
  filename: string = "openclaw.json",
) {
  const dir = path.join(home, dirname);
  await fs.mkdir(dir, { recursive: true });
  const configPath = path.join(dir, filename);
  await fs.writeFile(configPath, JSON.stringify({ gateway: { port } }, null, 2));
  return configPath;
}

function createIoForHome(home: string, env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv) {
  return createConfigIO({
    env,
    homedir: () => home,
  });
}

describe("config io paths", () => {
  it("uses ~/.openclaw/openclaw.json when config exists", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeConfig(home, ".openclaw", 19001);
      const io = createIoForHome(home);
      expect(io.configPath).toBe(configPath);
    });
  });

  it("defaults to ~/.openclaw/openclaw.json when config is missing", async () => {
    await withTempHome(async (home) => {
      const io = createIoForHome(home);
      expect(io.configPath).toBe(path.join(home, ".openclaw", "openclaw.json"));
    });
  });

  it("uses OPENCLAW_HOME for default config path", async () => {
    await withTempHome(async (home) => {
      const io = createConfigIO({
        env: { OPENCLAW_HOME: path.join(home, "svc-home") } as NodeJS.ProcessEnv,
        homedir: () => path.join(home, "ignored-home"),
      });
      expect(io.configPath).toBe(path.join(home, "svc-home", ".openclaw", "openclaw.json"));
    });
  });

  it("honors explicit OPENCLAW_CONFIG_PATH override", async () => {
    await withTempHome(async (home) => {
      const customPath = await writeConfig(home, ".openclaw", 20002, "custom.json");
      const io = createIoForHome(home, { OPENCLAW_CONFIG_PATH: customPath } as NodeJS.ProcessEnv);
      expect(io.configPath).toBe(customPath);
    });
  });

  it("normalizes safe-bin config entries at config load time", async () => {
    const cfg = {
      tools: {
        exec: {
          safeBinTrustedDirs: [" /custom/bin ", "", "/custom/bin", "/agent/bin"],
          safeBinProfiles: {
            " MyFilter ": {
              allowedValueFlags: ["--limit", " --limit ", ""],
            },
          },
        },
      },
      agents: {
        list: [
          {
            id: "ops",
            tools: {
              exec: {
                safeBinTrustedDirs: [" /ops/bin ", "/ops/bin"],
                safeBinProfiles: {
                  " Custom ": {
                    deniedFlags: ["-f", " -f ", ""],
                  },
                },
              },
            },
          },
        ],
      },
    };
    normalizeExecSafeBinProfilesInConfig(cfg);
    expect(cfg.tools?.exec?.safeBinProfiles).toEqual({
      myfilter: {
        allowedValueFlags: ["--limit"],
      },
    });
    expect(cfg.tools?.exec?.safeBinTrustedDirs).toEqual(["/custom/bin", "/agent/bin"]);
    expect(cfg.agents?.list?.[0]?.tools?.exec?.safeBinProfiles).toEqual({
      custom: {
        deniedFlags: ["-f"],
      },
    });
    expect(cfg.agents?.list?.[0]?.tools?.exec?.safeBinTrustedDirs).toEqual(["/ops/bin"]);
  });

  it("moves WhatsApp shared access defaults into accounts.default during runtime compat", () => {
    const migrated = applyRuntimeLegacyConfigMigrations({
      channels: {
        whatsapp: {
          enabled: true,
          dmPolicy: "allowlist",
          allowFrom: ["+15550001111"],
          groupPolicy: "open",
          groupAllowFrom: [],
          accounts: {
            work: {
              enabled: true,
              authDir: "/tmp/wa-work",
            },
          },
        },
      },
    });
    const next = migrated.next as OpenClawConfig | null;
    expect(next?.channels?.whatsapp?.accounts?.default).toMatchObject({
      dmPolicy: "allowlist",
      allowFrom: ["+15550001111"],
      groupPolicy: "open",
      groupAllowFrom: [],
    });
  });
});
