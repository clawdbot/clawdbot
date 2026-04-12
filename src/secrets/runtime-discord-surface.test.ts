import { describe, expect, it } from "vitest";
import "./runtime-discord.test-support.ts";
import {
  asConfig,
  loadAuthStoreWithProfiles,
  setupSecretsRuntimeSnapshotTestHooks,
} from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

describe("secrets runtime snapshot discord surface", () => {
  it("fails when non-default Discord account inherits an unresolved top-level token ref", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          channels: {
            discord: {
              token: {
                source: "env",
                provider: "default",
                id: "MISSING_DISCORD_BASE_TOKEN",
              },
              accounts: {
                work: {
                  enabled: true,
                },
              },
            },
          },
        }),
        env: {},
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: () => loadAuthStoreWithProfiles({}),
      }),
    ).rejects.toThrow('Environment variable "MISSING_DISCORD_BASE_TOKEN" is missing or empty.');
  });

  it("treats top-level Discord token refs as inactive when account token is explicitly blank", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          discord: {
            token: {
              source: "env",
              provider: "default",
              id: "MISSING_DISCORD_DEFAULT_TOKEN",
            },
            accounts: {
              default: {
                enabled: true,
                token: "",
              },
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.discord?.token).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_DISCORD_DEFAULT_TOKEN",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain("channels.discord.token");
  });

  it("treats Discord PluralKit token refs as inactive when PluralKit is disabled", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          discord: {
            pluralkit: {
              enabled: false,
              token: {
                source: "env",
                provider: "default",
                id: "MISSING_DISCORD_PLURALKIT_TOKEN",
              },
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.discord?.pluralkit?.token).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_DISCORD_PLURALKIT_TOKEN",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.discord.pluralkit.token",
    );
  });

  it("treats Discord voice TTS refs as inactive when voice is disabled", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          discord: {
            voice: {
              enabled: false,
              tts: {
                providers: {
                  openai: {
                    apiKey: {
                      source: "env",
                      provider: "default",
                      id: "MISSING_DISCORD_VOICE_TTS_OPENAI",
                    },
                  },
                },
              },
            },
            accounts: {
              work: {
                enabled: true,
                voice: {
                  enabled: false,
                  tts: {
                    providers: {
                      openai: {
                        apiKey: {
                          source: "env",
                          provider: "default",
                          id: "MISSING_DISCORD_WORK_VOICE_TTS_OPENAI",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.discord?.voice?.tts?.providers?.openai?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_DISCORD_VOICE_TTS_OPENAI",
    });
    expect(
      snapshot.config.channels?.discord?.accounts?.work?.voice?.tts?.providers?.openai?.apiKey,
    ).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_DISCORD_WORK_VOICE_TTS_OPENAI",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toEqual(
      expect.arrayContaining([
        "channels.discord.voice.tts.providers.openai.apiKey",
        "channels.discord.accounts.work.voice.tts.providers.openai.apiKey",
      ]),
    );
  });

  it("handles Discord nested inheritance for enabled and disabled accounts", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          discord: {
            voice: {
              tts: {
                providers: {
                  openai: {
                    apiKey: { source: "env", provider: "default", id: "DISCORD_BASE_TTS_OPENAI" },
                  },
                },
              },
            },
            pluralkit: {
              token: { source: "env", provider: "default", id: "DISCORD_BASE_PK_TOKEN" },
            },
            accounts: {
              enabledInherited: {
                enabled: true,
              },
              enabledOverride: {
                enabled: true,
                voice: {
                  tts: {
                    providers: {
                      openai: {
                        apiKey: {
                          source: "env",
                          provider: "default",
                          id: "DISCORD_ENABLED_OVERRIDE_TTS_OPENAI",
                        },
                      },
                    },
                  },
                },
              },
              disabledOverride: {
                enabled: false,
                voice: {
                  tts: {
                    providers: {
                      openai: {
                        apiKey: {
                          source: "env",
                          provider: "default",
                          id: "DISCORD_DISABLED_OVERRIDE_TTS_OPENAI",
                        },
                      },
                    },
                  },
                },
                pluralkit: {
                  token: {
                    source: "env",
                    provider: "default",
                    id: "DISCORD_DISABLED_OVERRIDE_PK_TOKEN",
                  },
                },
              },
            },
          },
        },
      }),
      env: {
        DISCORD_BASE_TTS_OPENAI: "base-tts-openai",
        DISCORD_BASE_PK_TOKEN: "base-pk-token",
        DISCORD_ENABLED_OVERRIDE_TTS_OPENAI: "enabled-override-tts-openai",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.discord?.voice?.tts?.providers?.openai?.apiKey).toBe(
      "base-tts-openai",
    );
    expect(snapshot.config.channels?.discord?.pluralkit?.token).toBe("base-pk-token");
    expect(
      snapshot.config.channels?.discord?.accounts?.enabledOverride?.voice?.tts?.providers?.openai
        ?.apiKey,
    ).toBe("enabled-override-tts-openai");
    expect(
      snapshot.config.channels?.discord?.accounts?.disabledOverride?.voice?.tts?.providers?.openai
        ?.apiKey,
    ).toEqual({
      source: "env",
      provider: "default",
      id: "DISCORD_DISABLED_OVERRIDE_TTS_OPENAI",
    });
    expect(snapshot.config.channels?.discord?.accounts?.disabledOverride?.pluralkit?.token).toEqual(
      {
        source: "env",
        provider: "default",
        id: "DISCORD_DISABLED_OVERRIDE_PK_TOKEN",
      },
    );
    expect(snapshot.warnings.map((warning) => warning.path)).toEqual(
      expect.arrayContaining([
        "channels.discord.accounts.disabledOverride.voice.tts.providers.openai.apiKey",
        "channels.discord.accounts.disabledOverride.pluralkit.token",
      ]),
    );
  });

  it("skips top-level Discord voice refs when all enabled accounts override nested voice config", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          discord: {
            voice: {
              tts: {
                providers: {
                  openai: {
                    apiKey: {
                      source: "env",
                      provider: "default",
                      id: "DISCORD_UNUSED_BASE_TTS_OPENAI",
                    },
                  },
                },
              },
            },
            accounts: {
              enabledOverride: {
                enabled: true,
                voice: {
                  tts: {
                    providers: {
                      openai: {
                        apiKey: {
                          source: "env",
                          provider: "default",
                          id: "DISCORD_ENABLED_ONLY_TTS_OPENAI",
                        },
                      },
                    },
                  },
                },
              },
              disabledInherited: {
                enabled: false,
              },
            },
          },
        },
      }),
      env: {
        DISCORD_ENABLED_ONLY_TTS_OPENAI: "enabled-only-tts-openai",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(
      snapshot.config.channels?.discord?.accounts?.enabledOverride?.voice?.tts?.providers?.openai
        ?.apiKey,
    ).toBe("enabled-only-tts-openai");
    expect(snapshot.config.channels?.discord?.voice?.tts?.providers?.openai?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "DISCORD_UNUSED_BASE_TTS_OPENAI",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.discord.voice.tts.providers.openai.apiKey",
    );
  });

  it("fails when an enabled Discord account override has an unresolved nested ref", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          channels: {
            discord: {
              voice: {
                tts: {
                  providers: {
                    openai: {
                      apiKey: { source: "env", provider: "default", id: "DISCORD_BASE_TTS_OK" },
                    },
                  },
                },
              },
              accounts: {
                enabledOverride: {
                  enabled: true,
                  voice: {
                    tts: {
                      providers: {
                        openai: {
                          apiKey: {
                            source: "env",
                            provider: "default",
                            id: "DISCORD_ENABLED_OVERRIDE_TTS_MISSING",
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
        env: {
          DISCORD_BASE_TTS_OK: "base-tts-openai",
        },
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: () => loadAuthStoreWithProfiles({}),
      }),
    ).rejects.toThrow(
      'Environment variable "DISCORD_ENABLED_OVERRIDE_TTS_MISSING" is missing or empty.',
    );
  });
});
