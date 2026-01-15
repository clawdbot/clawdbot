import { describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "../config/config.js";
import { runSecurityAudit } from "./audit.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const isWindows = process.platform === "win32";

describe("security audit", () => {
  it("includes an attack surface summary (info)", async () => {
    const cfg: ClawdbotConfig = {
      channels: { whatsapp: { groupPolicy: "open" }, telegram: { groupPolicy: "allowlist" } },
      tools: { elevated: { enabled: true, allowFrom: { whatsapp: ["+1"] } } },
      hooks: { enabled: true },
      browser: { enabled: true },
    };

    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "summary.attack_surface", severity: "info" }),
      ]),
    );
  });

  it("flags non-loopback bind without auth as critical", async () => {
    const cfg: ClawdbotConfig = {
      gateway: {
        bind: "lan",
        auth: {},
      },
    };

    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(
      res.findings.some((f) => f.checkId === "gateway.bind_no_auth" && f.severity === "critical"),
    ).toBe(true);
  });

  it("flags logging.redactSensitive=off", async () => {
    const cfg: ClawdbotConfig = {
      logging: { redactSensitive: "off" },
    };

    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "logging.redact_off", severity: "warn" }),
      ]),
    );
  });

  it("flags tools.elevated allowFrom wildcard as critical", async () => {
    const cfg: ClawdbotConfig = {
      tools: {
        elevated: {
          allowFrom: { whatsapp: ["*"] },
        },
      },
    };

    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "tools.elevated.allowFrom.whatsapp.wildcard",
          severity: "critical",
        }),
      ]),
    );
  });

  it("flags remote browser control without token as critical", async () => {
    const prev = process.env.CLAWDBOT_BROWSER_CONTROL_TOKEN;
    delete process.env.CLAWDBOT_BROWSER_CONTROL_TOKEN;
    try {
      const cfg: ClawdbotConfig = {
        browser: {
          controlUrl: "http://example.com:18791",
        },
      };

      const res = await runSecurityAudit({
        config: cfg,
        includeFilesystem: false,
        includeChannelSecurity: false,
      });

      expect(res.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            checkId: "browser.control_remote_no_token",
            severity: "critical",
          }),
        ]),
      );
    } finally {
      if (prev === undefined) delete process.env.CLAWDBOT_BROWSER_CONTROL_TOKEN;
      else process.env.CLAWDBOT_BROWSER_CONTROL_TOKEN = prev;
    }
  });

  it("warns when browser control token matches gateway auth token", async () => {
    const token = "0123456789abcdef0123456789abcdef";
    const cfg: ClawdbotConfig = {
      gateway: { auth: { token } },
      browser: { controlUrl: "https://browser.example.com", controlToken: token },
    };

    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "browser.control_token_reuse_gateway_token",
          severity: "warn",
        }),
      ]),
    );
  });

  it("warns when remote browser control uses HTTP", async () => {
    const prev = process.env.CLAWDBOT_BROWSER_CONTROL_TOKEN;
    delete process.env.CLAWDBOT_BROWSER_CONTROL_TOKEN;
    try {
      const cfg: ClawdbotConfig = {
        browser: {
          controlUrl: "http://example.com:18791",
          controlToken: "0123456789abcdef01234567",
        },
      };

      const res = await runSecurityAudit({
        config: cfg,
        includeFilesystem: false,
        includeChannelSecurity: false,
      });

      expect(res.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ checkId: "browser.control_remote_http", severity: "warn" }),
        ]),
      );
    } finally {
      if (prev === undefined) delete process.env.CLAWDBOT_BROWSER_CONTROL_TOKEN;
      else process.env.CLAWDBOT_BROWSER_CONTROL_TOKEN = prev;
    }
  });

  it("adds a warning when deep probe fails", async () => {
    const cfg: ClawdbotConfig = { gateway: { mode: "local" } };

    const res = await runSecurityAudit({
      config: cfg,
      deep: true,
      deepTimeoutMs: 50,
      includeFilesystem: false,
      includeChannelSecurity: false,
      probeGatewayFn: async () => ({
        ok: false,
        url: "ws://127.0.0.1:18789",
        connectLatencyMs: null,
        error: "connect failed",
        close: null,
        health: null,
        status: null,
        presence: null,
        configSnapshot: null,
      }),
    });

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "gateway.probe_failed", severity: "warn" }),
      ]),
    );
  });

  it("warns on legacy model configuration", async () => {
    const cfg: ClawdbotConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-3.5-turbo" } } },
    };

    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "models.legacy", severity: "warn" }),
      ]),
    );
  });

  it("warns when hooks token looks short", async () => {
    const cfg: ClawdbotConfig = {
      hooks: { enabled: true, token: "short" },
    };

    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "hooks.token_too_short", severity: "warn" }),
      ]),
    );
  });

  it("warns when state/config look like a synced folder", async () => {
    const cfg: ClawdbotConfig = {};

    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: false,
      stateDir: "/Users/test/Dropbox/.clawdbot",
      configPath: "/Users/test/Dropbox/.clawdbot/clawdbot.json",
    });

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "fs.synced_dir", severity: "warn" }),
      ]),
    );
  });

  it("flags group/world-readable config include files", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-security-audit-"));
    const stateDir = path.join(tmp, "state");
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });

    const includePath = path.join(stateDir, "extra.json5");
    await fs.writeFile(includePath, "{ logging: { redactSensitive: 'off' } }\n", "utf-8");
    await fs.chmod(includePath, 0o644);

    const configPath = path.join(stateDir, "clawdbot.json");
    await fs.writeFile(configPath, `{ "$include": "./extra.json5" }\n`, "utf-8");
    await fs.chmod(configPath, 0o600);

    const cfg: ClawdbotConfig = { logging: { redactSensitive: "off" } };
    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: true,
      includeChannelSecurity: false,
      stateDir,
      configPath,
    });

    const expectedCheckId = isWindows
      ? "fs.config_include.perms_writable"
      : "fs.config_include.perms_world_readable";

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: expectedCheckId, severity: "critical" }),
      ]),
    );
  });

  it("flags extensions without plugins.allow", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-security-audit-"));
    const stateDir = path.join(tmp, "state");
    await fs.mkdir(path.join(stateDir, "extensions", "some-plugin"), {
      recursive: true,
      mode: 0o700,
    });

    const cfg: ClawdbotConfig = {};
    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: true,
      includeChannelSecurity: false,
      stateDir,
      configPath: path.join(stateDir, "clawdbot.json"),
    });

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "plugins.extensions_no_allowlist", severity: "warn" }),
      ]),
    );
  });

  it("flags open groupPolicy when tools.elevated is enabled", async () => {
    const cfg: ClawdbotConfig = {
      tools: { elevated: { enabled: true, allowFrom: { whatsapp: ["+1"] } } },
      channels: { whatsapp: { groupPolicy: "open" } },
    };

    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "security.exposure.open_groups_with_elevated",
          severity: "critical",
        }),
      ]),
    );
  });
});
