import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { validateConfigObjectWithPlugins } from "./validation.js";

vi.unmock("../version.js");

async function chmodSafeDir(dir: string) {
  if (process.platform === "win32") {
    return;
  }
  await fs.chmod(dir, 0o755);
}

async function mkdirSafe(dir: string) {
  await fs.mkdir(dir, { recursive: true });
  await chmodSafeDir(dir);
}

async function writePluginFixture(params: {
  dir: string;
  id: string;
  schema: Record<string, unknown>;
  channels?: string[];
}) {
  await mkdirSafe(params.dir);
  await fs.writeFile(
    path.join(params.dir, "index.js"),
    `export default { id: "${params.id}", register() {} };`,
    "utf-8",
  );
  const manifest: Record<string, unknown> = {
    id: params.id,
    configSchema: params.schema,
  };
  if (params.channels) {
    manifest.channels = params.channels;
  }
  await fs.writeFile(
    path.join(params.dir, "openclaw.plugin.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
}

async function writeBundleFixture(params: {
  dir: string;
  format: "codex" | "claude";
  name: string;
}) {
  await mkdirSafe(params.dir);
  const manifestDir = path.join(
    params.dir,
    params.format === "codex" ? ".codex-plugin" : ".claude-plugin",
  );
  await mkdirSafe(manifestDir);
  await fs.writeFile(
    path.join(manifestDir, "plugin.json"),
    JSON.stringify({ name: params.name }, null, 2),
    "utf-8",
  );
}

async function writeManifestlessClaudeBundleFixture(params: { dir: string }) {
  await mkdirSafe(params.dir);
  await mkdirSafe(path.join(params.dir, "commands"));
  await fs.writeFile(
    path.join(params.dir, "commands", "review.md"),
    "---\ndescription: fixture\n---\n",
    "utf-8",
  );
  await fs.writeFile(path.join(params.dir, "settings.json"), '{"hideThinkingBlock":true}', "utf-8");
}

function expectRemovedPluginWarnings(
  result: { ok: boolean; warnings?: Array<{ path: string; message: string }> },
  removedId: string,
  removedLabel: string,
) {
  expect(result.ok).toBe(true);
  if (result.ok) {
    const message = `plugin removed: ${removedLabel} (stale config entry ignored; remove it from plugins config)`;
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        { path: `plugins.entries.${removedId}`, message },
        { path: "plugins.allow", message },
        { path: "plugins.deny", message },
        { path: "plugins.slots.memory", message },
      ]),
    );
  }
}

describe("config plugin validation", () => {
  let fixtureRoot = "";
  let suiteHome = "";
  let badPluginDir = "";
  let enumPluginDir = "";
  let bluebubblesPluginDir = "";
  let googleOverridePluginDir = "";
  let voiceCallSchemaPluginDir = "";
  let bundlePluginDir = "";
  let manifestlessClaudeBundleDir = "";
  let blockedPluginDir = "";
  const suiteEnv = () =>
    ({
      HOME: suiteHome,
      OPENCLAW_HOME: undefined,
      OPENCLAW_STATE_DIR: path.join(suiteHome, ".openclaw"),
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_VERSION: undefined,
      VITEST: "true",
    }) satisfies NodeJS.ProcessEnv;

  const validateInSuite = (raw: unknown) =>
    validateConfigObjectWithPlugins(raw, { env: suiteEnv() });

  const validateRemovedPluginConfig = (removedId: string) =>
    validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: false,
        entries: { [removedId]: { enabled: true } },
        allow: [removedId],
        deny: [removedId],
        slots: { memory: removedId },
      },
    });

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-plugin-validation-"));
    await chmodSafeDir(fixtureRoot);
    suiteHome = path.join(fixtureRoot, "home");
    await mkdirSafe(suiteHome);
    badPluginDir = path.join(suiteHome, "bad-plugin");
    enumPluginDir = path.join(suiteHome, "enum-plugin");
    bluebubblesPluginDir = path.join(suiteHome, "bluebubbles-plugin");
    await writePluginFixture({
      dir: badPluginDir,
      id: "bad-plugin",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          value: { type: "boolean" },
        },
        required: ["value"],
      },
    });
    await writePluginFixture({
      dir: enumPluginDir,
      id: "enum-plugin",
      schema: {
        type: "object",
        properties: {
          fileFormat: {
            type: "string",
            enum: ["markdown", "html"],
          },
        },
        required: ["fileFormat"],
      },
    });
    await writePluginFixture({
      dir: bluebubblesPluginDir,
      id: "bluebubbles-plugin",
      channels: ["bluebubbles"],
      schema: { type: "object" },
    });
    googleOverridePluginDir = path.join(suiteHome, "google");
    await writePluginFixture({
      dir: googleOverridePluginDir,
      id: "google",
      schema: {
        type: "object",
        properties: {
          apiKey: { type: "string" },
        },
      },
    });
    bundlePluginDir = path.join(suiteHome, "bundle-plugin");
    await writeBundleFixture({
      dir: bundlePluginDir,
      format: "codex",
      name: "Bundle Fixture",
    });
    manifestlessClaudeBundleDir = path.join(suiteHome, "manifestless-claude-bundle");
    await writeManifestlessClaudeBundleFixture({
      dir: manifestlessClaudeBundleDir,
    });
    blockedPluginDir = path.join(suiteHome, "blocked-plugin");
    await writePluginFixture({
      dir: blockedPluginDir,
      id: "blocked-plugin",
      schema: { type: "object" },
    });
    voiceCallSchemaPluginDir = path.join(suiteHome, "voice-call-schema-plugin");
    const voiceCallManifestPath = path.join(
      process.cwd(),
      "extensions",
      "voice-call",
      "openclaw.plugin.json",
    );
    const voiceCallManifest = JSON.parse(await fs.readFile(voiceCallManifestPath, "utf-8")) as {
      configSchema?: Record<string, unknown>;
    };
    if (!voiceCallManifest.configSchema) {
      throw new Error("voice-call manifest missing configSchema");
    }
    await writePluginFixture({
      dir: voiceCallSchemaPluginDir,
      id: "voice-call-schema-fixture",
      schema: voiceCallManifest.configSchema,
    });
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("reports missing plugin refs across entries and allowlist surfaces", async () => {
    const missingPath = path.join(suiteHome, "missing-plugin-dir");
    const res = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: true,
        load: { paths: [missingPath] },
        entries: { "missing-plugin": { enabled: true } },
        allow: ["missing-allow"],
        deny: ["missing-deny"],
        slots: { memory: "missing-slot" },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues).toEqual(
        expect.arrayContaining([
          { path: "plugins.deny", message: "plugin not found: missing-deny" },
          { path: "plugins.slots.memory", message: "plugin not found: missing-slot" },
        ]),
      );
      expect(res.warnings).toContainEqual({
        path: "plugins.allow",
        message:
          "plugin not found: missing-allow (stale config entry ignored; remove it from plugins config)",
      });
      expect(res.warnings).toContainEqual({
        path: "plugins.entries.missing-plugin",
        message:
          "plugin not found: missing-plugin (stale config entry ignored; remove it from plugins config)",
      });
    }
  });

  it.runIf(process.platform !== "win32")(
    "reports configured blocked plugins without stale not-found wording",
    async () => {
      await fs.chmod(blockedPluginDir, 0o777);
      try {
        const res = validateInSuite({
          agents: { list: [{ id: "pi" }] },
          plugins: {
            enabled: true,
            load: { paths: [blockedPluginDir] },
            entries: { "blocked-plugin": { enabled: true } },
            allow: ["blocked-plugin"],
          },
        });

        expect(res.ok).toBe(true);
        if (!res.ok) {
          return;
        }
        expect(res.warnings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: "plugins.entries.blocked-plugin",
              message: expect.stringContaining("plugin present but blocked: blocked-plugin"),
            }),
            expect.objectContaining({
              path: "plugins.allow",
              message: expect.stringContaining("plugin present but blocked: blocked-plugin"),
            }),
          ]),
        );
        expect(
          res.warnings.some(
            (warning) =>
              warning.message.includes("plugin not found: blocked-plugin") ||
              warning.message.includes("remove it from plugins config"),
          ),
        ).toBe(false);
      } finally {
        await chmodSafeDir(blockedPluginDir);
      }
    },
  );

  it("maps legacy blocked diagnostics without plugin ids to configured load paths", () => {
    const res = validateConfigObjectWithPlugins(
      {
        agents: { list: [{ id: "pi" }] },
        plugins: {
          enabled: true,
          load: { paths: [blockedPluginDir] },
          entries: { "blocked-plugin": { enabled: true } },
          allow: ["blocked-plugin"],
        },
      },
      {
        env: suiteEnv(),
        pluginMetadataSnapshot: {
          manifestRegistry: {
            plugins: [],
            diagnostics: [
              {
                level: "warn",
                source: path.join(blockedPluginDir, "index.js"),
                message: `blocked plugin candidate: world-writable path (${blockedPluginDir}, mode=0777)`,
              },
            ],
          },
        },
      },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "plugins.entries.blocked-plugin",
          message: expect.stringContaining("plugin present but blocked: blocked-plugin"),
        }),
        expect.objectContaining({
          path: "plugins.allow",
          message: expect.stringContaining("plugin present but blocked: blocked-plugin"),
        }),
      ]),
    );
    expect(
      res.warnings.some((warning) => warning.message.includes("plugin not found: blocked-plugin")),
    ).toBe(false);
  });

  it("does not source-match blocked diagnostics that already name a different plugin id", () => {
    const aliasDir = path.join(suiteHome, "alias-dir");
    const res = validateConfigObjectWithPlugins(
      {
        agents: { list: [{ id: "pi" }] },
        plugins: {
          enabled: true,
          load: { paths: [aliasDir] },
          entries: {
            "actual-id": { enabled: true },
            "alias-dir": { enabled: true },
          },
          allow: ["actual-id", "alias-dir"],
        },
      },
      {
        env: suiteEnv(),
        pluginMetadataSnapshot: {
          manifestRegistry: {
            plugins: [],
            diagnostics: [
              {
                level: "warn",
                pluginId: "actual-id",
                source: path.join(aliasDir, "index.js"),
                message: `blocked plugin candidate: world-writable path (${aliasDir}, mode=0777)`,
              },
            ],
          },
        },
      },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "plugins.entries.actual-id",
          message: expect.stringContaining("plugin present but blocked: actual-id"),
        }),
        expect.objectContaining({
          path: "plugins.allow",
          message: expect.stringContaining("plugin present but blocked: actual-id"),
        }),
        expect.objectContaining({
          path: "plugins.entries.alias-dir",
          message:
            "plugin not found: alias-dir (stale config entry ignored; remove it from plugins config)",
        }),
        expect.objectContaining({
          path: "plugins.allow",
          message:
            "plugin not found: alias-dir (stale config entry ignored; remove it from plugins config)",
        }),
      ]),
    );
    expect(
      res.warnings.some((warning) =>
        warning.message.includes("plugin present but blocked: alias-dir"),
      ),
    ).toBe(false);
  });

  it("warns instead of failing for stale channel config backed by missing plugin refs", async () => {
    const res = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      channels: {
        "missing-chat": { token: "stale" },
      },
      plugins: {
        allow: ["missing-chat"],
        entries: { "missing-chat": { enabled: true } },
      },
    });

    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.warnings).toContainEqual({
      path: "channels.missing-chat",
      message:
        "unknown channel id: missing-chat (stale channel plugin config ignored; run openclaw doctor --fix to remove stale config, or install the plugin)",
    });
    expect(res.warnings).toContainEqual({
      path: "plugins.allow",
      message:
        "plugin not found: missing-chat (stale config entry ignored; remove it from plugins config)",
    });
    expect(res.warnings).toContainEqual({
      path: "plugins.entries.missing-chat",
      message:
        "plugin not found: missing-chat (stale config entry ignored; remove it from plugins config)",
    });
  });

  it("keeps unknown channel typos fatal when there is no stale plugin evidence", async () => {
    const res = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      channels: {
        telegarm: { botToken: "typo" },
      },
      plugins: {
        allow: ["telegram"],
      },
    });

    expect(res.ok).toBe(false);
    if (res.ok) {
      return;
    }
    expect(res.issues).toContainEqual({
      path: "channels.telegarm",
      message: "unknown channel id: telegarm",
    });
    expect(res.warnings).not.toContainEqual(expect.objectContaining({ path: "channels.telegarm" }));
  });

  it("warns when plugins.allow contains a channel id without a plugin manifest (#76872)", async () => {
    const res = validateConfigObjectWithPlugins(
      {
        agents: { list: [{ id: "pi" }] },
        channels: {
          discord: { token: "xxx" },
        },
        plugins: {
          allow: ["discord"],
        },
      },
      {
        env: suiteEnv(),
        pluginMetadataSnapshot: {
          manifestRegistry: {
            plugins: [],
            diagnostics: [],
          },
        },
      },
    );

    expect(res.ok).toBe(true);
    expect(res.warnings ?? []).toContainEqual({
      path: "plugins.allow",
      message:
        "plugin not found: discord (stale config entry ignored; remove it from plugins config)",
    });
  });

  it("uses persisted installed-plugin records as stale channel evidence", async () => {
    const installedPluginIndexPath = path.join(suiteHome, ".openclaw", "plugins", "installs.json");
    await mkdirSafe(path.dirname(installedPluginIndexPath));
    await fs.writeFile(
      installedPluginIndexPath,
      JSON.stringify(
        {
          installRecords: {
            "missing-sms": {
              source: "npm",
              spec: "missing-sms@1.0.0",
              installedAt: "2026-04-12T00:00:00.000Z",
            },
          },
          plugins: [],
        },
        null,
        2,
      ),
      "utf-8",
    );
    try {
      const res = validateInSuite({
        agents: { list: [{ id: "pi" }] },
        channels: {
          "missing-sms": { token: "stale" },
        },
      });

      expect(res.ok).toBe(true);
      if (!res.ok) {
        return;
      }
      expect(res.warnings).toContainEqual({
        path: "channels.missing-sms",
        message:
          "unknown channel id: missing-sms (stale channel plugin config ignored; run openclaw doctor --fix to remove stale config, or install the plugin)",
      });
    } finally {
      await fs.rm(installedPluginIndexPath, { force: true });
    }
  });

  it("warns with actionable guidance when a runtime command name is used in plugins.allow", async () => {
    const res = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        allow: ["dreaming"],
        entries: {
          "memory-core": {
            config: { dreaming: { enabled: true } },
          },
        },
      },
    });
    // Should not produce the generic "plugin not found" warning.
    expect(
      res.warnings?.some(
        (w) => w.path === "plugins.allow" && w.message.includes("plugin not found: dreaming"),
      ),
    ).toBe(false);
    // Should produce a helpful redirect to the parent plugin.
    expect(
      res.warnings?.some(
        (w) =>
          w.path === "plugins.allow" &&
          w.message.includes('"dreaming" is not a plugin') &&
          w.message.includes("memory-core"),
      ),
    ).toBe(true);
  });

  it("does not fail validation for the implicit default memory slot when plugins config is explicit", async () => {
    const res = validateConfigObjectWithPlugins(
      {
        agents: { list: [{ id: "pi" }] },
        plugins: {
          entries: { acpx: { enabled: true } },
        },
      },
      {
        env: {
          ...suiteEnv(),
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(suiteHome, "missing-bundled-plugins"),
        },
      },
    );
    expect(res.ok).toBe(true);
  });

  it("warns for removed legacy plugin ids instead of failing validation", async () => {
    const removedId = "google-antigravity-auth";
    const res = validateRemovedPluginConfig(removedId);
    expectRemovedPluginWarnings(res, removedId, removedId);
  });

  it("warns for removed google gemini auth plugin ids instead of failing validation", async () => {
    const removedId = "google-gemini-cli-auth";
    const res = validateRemovedPluginConfig(removedId);
    expectRemovedPluginWarnings(res, removedId, removedId);
  });

  it("does not auto-allow config-loaded overrides of bundled web search plugin ids", async () => {
    const res = validateInSuite({
      plugins: {
        allow: ["bluebubbles", "memory-core"],
        load: {
          paths: [googleOverridePluginDir],
        },
        entries: {
          google: {
            config: {
              apiKey: "test-google-key",
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.warnings).toContainEqual({
      path: "plugins.entries.google",
      message: "plugin disabled (not in allowlist) but config is present",
    });
  });

  it("surfaces plugin config diagnostics", async () => {
    const res = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: true,
        load: { paths: [badPluginDir] },
        entries: { "bad-plugin": { config: { value: "nope" } } },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const hasIssue = res.issues.some(
        (issue) =>
          issue.path.startsWith("plugins.entries.bad-plugin.config") &&
          issue.message.includes("invalid config"),
      );
      expect(hasIssue).toBe(true);
    }
  });

  it("does not require native config schemas for enabled bundle plugins", async () => {
    const res = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: true,
        load: { paths: [bundlePluginDir] },
        entries: { "bundle-fixture": { enabled: true } },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts enabled manifestless Claude bundles without a native schema", async () => {
    const res = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: true,
        load: { paths: [manifestlessClaudeBundleDir] },
        entries: { "manifestless-claude-bundle": { enabled: true } },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("surfaces allowed enum values for plugin config diagnostics", async () => {
    const res = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: true,
        load: { paths: [enumPluginDir] },
        entries: { "enum-plugin": { config: { fileFormat: "txt" } } },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const issue = res.issues.find(
        (entry) => entry.path === "plugins.entries.enum-plugin.config.fileFormat",
      );
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('allowed: "markdown", "html"');
      expect(issue?.allowedValues).toEqual(["markdown", "html"]);
      expect(issue?.allowedValuesHiddenCount).toBe(0);
    }
  });

  it("accepts voice-call webhookSecurity and streaming guard config fields", async () => {
    const res = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: true,
        load: { paths: [voiceCallSchemaPluginDir] },
        entries: {
          "voice-call-schema-fixture": {
            config: {
              provider: "twilio",
              webhookSecurity: {
                allowedHosts: ["voice.example.com"],
                trustForwardingHeaders: false,
                trustedProxyIPs: ["127.0.0.1"],
              },
              streaming: {
                enabled: true,
                preStartTimeoutMs: 5000,
                maxPendingConnections: 16,
                maxPendingConnectionsPerIp: 4,
                maxConnections: 64,
              },
              staleCallReaperSeconds: 180,
            },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts voice-call OpenAI TTS speed, instructions, and baseUrl config fields", async () => {
    const res = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: true,
        load: { paths: [voiceCallSchemaPluginDir] },
        entries: {
          "voice-call-schema-fixture": {
            config: {
              tts: {
                providers: {
                  openai: {
                    baseUrl: "http://localhost:8880/v1",
                    voice: "alloy",
                    speed: 1.5,
                    instructions: "Speak in a cheerful tone",
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts voice-call SecretRef credentials declared by the plugin schema", async () => {
    const res = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: true,
        load: { paths: [voiceCallSchemaPluginDir] },
        entries: {
          "voice-call-schema-fixture": {
            config: {
              provider: "twilio",
              twilio: {
                accountSid: "twilio-account-sid-placeholder",
                authToken: { source: "env", provider: "default", id: "TWILIO_AUTH_TOKEN" },
              },
              tts: {
                providers: {
                  openai: {
                    apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                  },
                  elevenlabs: {
                    apiKey: { source: "env", provider: "default", id: "ELEVENLABS_API_KEY" },
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects out-of-range voice-call OpenAI TTS speed values", async () => {
    const res = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: true,
        load: { paths: [voiceCallSchemaPluginDir] },
        entries: {
          "voice-call-schema-fixture": {
            config: {
              tts: {
                providers: {
                  openai: {
                    speed: 10,
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(
        res.issues.some(
          (issue) =>
            issue.path ===
            "plugins.entries.voice-call-schema-fixture.config.tts.providers.openai.speed",
        ),
      ).toBe(true);
    }
  });

  it("rejects out-of-range voice-call ElevenLabs voice settings", async () => {
    const res = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: true,
        load: { paths: [voiceCallSchemaPluginDir] },
        entries: {
          "voice-call-schema-fixture": {
            config: {
              tts: {
                providers: {
                  elevenlabs: {
                    voiceSettings: {
                      stability: 5,
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(
        res.issues.some(
          (issue) =>
            issue.path ===
            "plugins.entries.voice-call-schema-fixture.config.tts.providers.elevenlabs.voiceSettings.stability",
        ),
      ).toBe(true);
    }
  });

  it("accepts known plugin ids and valid channel/heartbeat enums", async () => {
    const res = validateInSuite({
      agents: {
        defaults: { heartbeat: { target: "last", directPolicy: "block" } },
        list: [{ id: "pi", heartbeat: { directPolicy: "allow" } }],
      },
      channels: {
        modelByChannel: {
          openai: {
            whatsapp: "openai/gpt-5.4",
          },
        },
      },
      plugins: { enabled: false, entries: { discord: { enabled: true } } },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts plugin heartbeat targets", async () => {
    const res = validateInSuite({
      agents: { defaults: { heartbeat: { target: "bluebubbles" } }, list: [{ id: "pi" }] },
      plugins: { enabled: false, load: { paths: [bluebubblesPluginDir] } },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects unknown heartbeat targets", async () => {
    const res = validateInSuite({
      agents: {
        defaults: { heartbeat: { target: "not-a-channel" } },
        list: [{ id: "pi" }],
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues).toContainEqual({
        path: "agents.defaults.heartbeat.target",
        message: "unknown heartbeat target: not-a-channel",
      });
    }
  });

  it("rejects invalid heartbeat directPolicy values", async () => {
    const res = validateInSuite({
      agents: {
        defaults: { heartbeat: { directPolicy: "maybe" } },
        list: [{ id: "pi" }],
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(
        res.issues.some((issue) => issue.path === "agents.defaults.heartbeat.directPolicy"),
      ).toBe(true);
    }
  });
});
