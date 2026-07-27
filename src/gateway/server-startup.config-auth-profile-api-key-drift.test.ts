import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { writePersistedAuthProfileStoreRaw } from "../agents/auth-profiles/sqlite.js";
import { writeConfigFile } from "../config/config.js";
import { resetLogger, setLoggerOverride } from "../logging.js";
import { loggingState } from "../logging/state.js";
import { installGatewayTestHooks, withGatewayServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway startup config auth profile apiKey drift warning", () => {
  test("warns on plain restart when a provider apiKey edit never reached the SQLite auth profile", async () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("expected OPENCLAW_STATE_DIR to be set by installGatewayTestHooks");
    }
    writePersistedAuthProfileStoreRaw(
      {
        version: 1,
        profiles: {
          "litellm:default": {
            type: "api_key",
            provider: "litellm",
            key: "old-key",
          },
        },
      },
      path.join(stateDir, "agents", "main", "agent"),
    );
    await writeConfigFile({
      models: {
        providers: {
          litellm: {
            apiKey: "new-key",
            baseUrl: "https://litellm.example.com",
            models: [],
          },
        },
      },
    });

    const warnings: string[] = [];
    loggingState.rawConsole = {
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn((message: string) => warnings.push(message)),
      error: vi.fn(),
    };
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });

    try {
      await withGatewayServer(async () => {});
    } finally {
      loggingState.rawConsole = null;
      resetLogger();
    }

    expect(
      warnings.some(
        (message) =>
          message.includes('Provider "litellm" has a new apiKey in openclaw.json') &&
          message.includes('auth profile "litellm:default"'),
      ),
    ).toBe(true);
  });
});
