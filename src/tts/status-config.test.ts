import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { resolveStatusTtsSnapshot } from "./status-config.js";

let fixtureRoot = "";
let fixtureId = 0;

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tts-status-"));
});

afterAll(() => {
  if (fixtureRoot) {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

async function withStatusTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = path.join(fixtureRoot, `case-${fixtureId++}`);
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousOpenClawHome = process.env.OPENCLAW_HOME;
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_STATE_DIR = path.join(home, ".openclaw");
  try {
    await run(home);
  } finally {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("OPENCLAW_HOME", previousOpenClawHome);
    restoreEnv("OPENCLAW_STATE_DIR", previousStateDir);
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe("resolveStatusTtsSnapshot", () => {
  it("uses prefs overrides without loading speech providers", async () => {
    await withStatusTempHome(async (home) => {
      const prefsPath = path.join(home, ".openclaw", "settings", "tts.json");
      fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
      fs.writeFileSync(
        prefsPath,
        JSON.stringify({
          tts: {
            auto: "always",
            provider: "edge",
            maxLength: 2048,
            summarize: false,
          },
        }),
      );

      expect(
        resolveStatusTtsSnapshot({
          cfg: {
            messages: {
              tts: {
                prefsPath,
              },
            },
          } as OpenClawConfig,
        }),
      ).toEqual({
        autoMode: "always",
        provider: "microsoft",
        maxLength: 2048,
        summarize: false,
      });
    });
  });

  it("reports auto provider when tts is on without an explicit provider", async () => {
    await withStatusTempHome(async () => {
      expect(
        resolveStatusTtsSnapshot({
          cfg: {
            messages: {
              tts: {
                auto: "always",
              },
            },
          } as OpenClawConfig,
        }),
      ).toEqual({
        autoMode: "always",
        provider: "auto",
        maxLength: 1500,
        summarize: true,
      });
    });
  });

  it("reports per-agent TTS overrides", async () => {
    await withStatusTempHome(async () => {
      expect(
        resolveStatusTtsSnapshot({
          cfg: {
            messages: {
              tts: {
                auto: "off",
                provider: "openai",
              },
            },
            agents: {
              list: [
                {
                  id: "reader",
                  tts: {
                    auto: "always",
                    provider: "elevenlabs",
                  },
                },
              ],
            },
          } as OpenClawConfig,
          agentId: "reader",
        }),
      ).toEqual({
        autoMode: "always",
        provider: "elevenlabs",
        maxLength: 1500,
        summarize: true,
      });
    });
  });

  it("reports per-agent persona provider over global persona", async () => {
    await withStatusTempHome(async () => {
      expect(
        resolveStatusTtsSnapshot({
          cfg: {
            messages: {
              tts: {
                auto: "always",
                persona: "alfred",
                personas: {
                  alfred: { provider: "google" },
                  jarvis: { provider: "edge" },
                },
              },
            },
            agents: {
              list: [
                {
                  id: "reader",
                  tts: {
                    persona: "jarvis",
                  },
                },
              ],
            },
          } as OpenClawConfig,
          agentId: "reader",
        }),
      ).toEqual({
        autoMode: "always",
        provider: "microsoft",
        persona: "jarvis",
        maxLength: 1500,
        summarize: true,
      });
    });
  });

  it("reports configured OpenAI TTS model, voice, and sanitized custom endpoint", async () => {
    await withStatusTempHome(async () => {
      expect(
        resolveStatusTtsSnapshot({
          cfg: {
            messages: {
              tts: {
                auto: "always",
                provider: "openai",
                providers: {
                  openai: {
                    displayName: "NeuTTS local",
                    baseUrl: "http://user:secret@127.0.0.1:18801/v1?token=hidden#fragment",
                    model: "neutts-nano",
                    voice: "clara",
                  },
                },
              },
            },
          } as OpenClawConfig,
        }),
      ).toEqual({
        autoMode: "always",
        provider: "openai",
        displayName: "NeuTTS local",
        model: "neutts-nano",
        voice: "clara",
        baseUrl: "http://127.0.0.1:18801/v1",
        customBaseUrl: true,
        maxLength: 1500,
        summarize: true,
      });
    });
  });

  it("omits default OpenAI endpoint details from status", async () => {
    await withStatusTempHome(async () => {
      expect(
        resolveStatusTtsSnapshot({
          cfg: {
            messages: {
              tts: {
                auto: "always",
                provider: "openai",
                providers: {
                  openai: {
                    baseUrl: "https://api.openai.com/v1/",
                    model: "gpt-4o-mini-tts",
                    voice: "coral",
                  },
                },
              },
            },
          } as OpenClawConfig,
        }),
      ).toEqual({
        autoMode: "always",
        provider: "openai",
        model: "gpt-4o-mini-tts",
        voice: "coral",
        maxLength: 1500,
        summarize: true,
      });
    });
  });

  it("reports merged per-agent provider metadata", async () => {
    await withStatusTempHome(async () => {
      expect(
        resolveStatusTtsSnapshot({
          cfg: {
            messages: {
              tts: {
                auto: "off",
                provider: "openai",
                providers: {
                  openai: {
                    model: "gpt-4o-mini-tts",
                    voice: "coral",
                  },
                },
              },
            },
            agents: {
              list: [
                {
                  id: "reader",
                  tts: {
                    auto: "always",
                    providers: {
                      openai: {
                        voice: "nova",
                      },
                    },
                  },
                },
              ],
            },
          } as OpenClawConfig,
          agentId: "reader",
        }),
      ).toEqual({
        autoMode: "always",
        provider: "openai",
        model: "gpt-4o-mini-tts",
        voice: "nova",
        maxLength: 1500,
        summarize: true,
      });
    });
  });

  it("uses provider metadata for local provider prefs overrides", async () => {
    await withStatusTempHome(async (home) => {
      const prefsPath = path.join(home, ".openclaw", "settings", "tts.json");
      fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
      fs.writeFileSync(
        prefsPath,
        JSON.stringify({
          tts: {
            auto: "always",
            provider: "edge",
          },
        }),
      );

      expect(
        resolveStatusTtsSnapshot({
          cfg: {
            messages: {
              tts: {
                provider: "openai",
                prefsPath,
                providers: {
                  microsoft: {
                    voice: "en-US-AvaMultilingualNeural",
                  },
                  openai: {
                    model: "gpt-4o-mini-tts",
                    voice: "coral",
                  },
                },
              },
            },
          } as OpenClawConfig,
        }),
      ).toEqual({
        autoMode: "always",
        provider: "microsoft",
        voice: "en-US-AvaMultilingualNeural",
        maxLength: 1500,
        summarize: true,
      });
    });
  });

  it("derives the default prefs path from OPENCLAW_CONFIG_PATH when set", async () => {
    await withStatusTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw-dev");
      const prefsPath = path.join(stateDir, "settings", "tts.json");
      fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
      fs.writeFileSync(
        prefsPath,
        JSON.stringify({
          tts: {
            auto: "always",
            provider: "openai",
          },
        }),
      );

      delete process.env.OPENCLAW_STATE_DIR;
      vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
      try {
        expect(
          resolveStatusTtsSnapshot({
            cfg: {
              messages: {
                tts: {},
              },
            } as OpenClawConfig,
          }),
        ).toEqual({
          autoMode: "always",
          provider: "openai",
          maxLength: 1500,
          summarize: true,
        });
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });
});
