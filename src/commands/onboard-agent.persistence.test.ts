import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readConfigFileSnapshot,
  replaceConfigFile,
  resetConfigRuntimeState,
} from "../config/config.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { ensureOnboardingAgent } from "./onboard-agent.js";

describe("onboarding authored config persistence", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_TOKEN"]);
  });

  afterEach(() => {
    envSnapshot.restore();
    resetConfigRuntimeState();
  });

  it("retains env references and includes through the real snapshot writer", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");
      const includePath = path.join(configDir, "channels.json");
      const includeRaw = JSON.stringify({ channels: { telegram: { enabled: true } } });
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(includePath, includeRaw);
      await fs.writeFile(
        configPath,
        `{
          $include: "./channels.json",
          gateway: { auth: { mode: "token", token: "\${OPENCLAW_TOKEN}" } }
        }`,
      );
      setTestEnvValue("OPENCLAW_TOKEN", "plaintext-secret");
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();
      const candidate = {
        ...snapshot.config,
        gateway: { ...snapshot.config.gateway, mode: "local" as const },
      };
      const result = await ensureOnboardingAgent({
        config: candidate,
        workspace: path.join(home, "workspace"),
        baseConfig: snapshot.config,
      });
      await replaceConfigFile({ nextConfig: result.config, afterWrite: { mode: "auto" } });

      const persistedRaw = await fs.readFile(configPath, "utf8");
      expect(persistedRaw).toContain("${OPENCLAW_TOKEN}");
      expect(persistedRaw).not.toContain("plaintext-secret");
      expect(persistedRaw).toContain("./channels.json");
      expect(await fs.readFile(includePath, "utf8")).toBe(includeRaw);
    });
  });
});
