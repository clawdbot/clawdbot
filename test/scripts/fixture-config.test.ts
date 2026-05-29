import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const fixturePath = path.resolve("scripts/e2e/lib/fixture.mjs");

function makeTempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "openclaw-fixture-config-"));
}

function runFixture(
  root: string,
  command: string,
  args: string[] = [],
  env: Record<string, string> = {},
) {
  return spawnSync(process.execPath, [fixturePath, command, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_CONFIG_BATCH_PATH: path.join(root, "batch.json"),
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      OPENCLAW_GATEWAY_TOKEN: "test-token",
      OPENCLAW_OPENWEBUI_MODEL: "openai/gpt-5.4-mini",
      OPENCLAW_STATE_DIR: root,
      ...env,
    },
  });
}

describe("scripts/e2e/lib/fixture.mjs config commands", () => {
  it("rejects loose gateway port env values instead of parsing prefixes", () => {
    const root = makeTempRoot();
    try {
      const result = runFixture(root, "config-reload", [], { PORT: "18789tcp" });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("invalid PORT: 18789tcp");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes strict positive browser CDP ports into generated config", () => {
    const root = makeTempRoot();
    try {
      const result = runFixture(root, "browser-cdp", [], { CDP_PORT: "19223", PORT: "19000" });

      expect(result.status).toBe(0);
      const config = JSON.parse(readFileSync(path.join(root, "openclaw.json"), "utf8"));
      expect(config.gateway.port).toBe(19000);
      expect(config.browser.profiles["docker-cdp"].cdpUrl).toBe("http://127.0.0.1:19223");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects loose browser CDP port env values", () => {
    const root = makeTempRoot();
    try {
      const result = runFixture(root, "browser-cdp", [], { CDP_PORT: "19222http" });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("invalid CDP_PORT: 19222http");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects loose Open WebUI provider timeout values", () => {
    const root = makeTempRoot();
    try {
      const result = runFixture(root, "openwebui-config", ["test-key"], {
        OPENCLAW_OPENWEBUI_PROVIDER_TIMEOUT_SECONDS: "300s",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("invalid OPENCLAW_OPENWEBUI_PROVIDER_TIMEOUT_SECONDS: 300s");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes strict positive Open WebUI provider timeouts into generated config", () => {
    const root = makeTempRoot();
    try {
      const result = runFixture(root, "openwebui-config", ["test-key"], {
        OPENCLAW_OPENWEBUI_PROVIDER_TIMEOUT_SECONDS: "300",
      });

      expect(result.status).toBe(0);
      const batch = JSON.parse(readFileSync(path.join(root, "batch.json"), "utf8"));
      expect(
        batch.find(
          (entry: { path: string }) => entry.path === "models.providers.openai.timeoutSeconds",
        )?.value,
      ).toBe(300);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
