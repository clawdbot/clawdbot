import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bridgeCodexAppServerStartOptions } from "./auth-bridge.js";

describe("bridgeCodexAppServerStartOptions", () => {
  it("leaves Codex app-server start options unchanged", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const startOptions = {
      transport: "stdio" as const,
      command: "codex",
      args: ["app-server"],
      headers: { authorization: "Bearer dev-token" },
      env: { CODEX_HOME: "/tmp/source-codex-home", EXISTING: "1" },
      clearEnv: ["FOO"],
    };
    try {
      await expect(
        bridgeCodexAppServerStartOptions({
          startOptions,
          agentDir,
          authProfileId: "openai-codex:default",
        }),
      ).resolves.toBe(startOptions);
      await expect(fs.access(path.join(agentDir, "harness-auth"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });
});
