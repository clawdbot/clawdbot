// Session listing prepares plugin-backed CLI provider metadata once for every row.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  mockSessionsConfig,
  resetMockSessionsConfig,
  runSessionsJson,
  setMockSessionsConfig,
  writeStore,
} from "./sessions.test-helpers.js";

const resolvePluginMetadataSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  resolvePluginMetadataSnapshot: resolvePluginMetadataSnapshotMock,
}));

mockSessionsConfig();

const { sessionsCommand } = await import("./sessions.js");

afterEach(() => {
  resetMockSessionsConfig();
  resolvePluginMetadataSnapshotMock.mockReset();
});

describe("sessions plugin metadata preparation", () => {
  it("loads one plugin metadata snapshot before enriching every stored row", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          models: { "openai/gpt-5.5": {} },
        },
      },
    };
    setMockSessionsConfig(() => config);
    resolvePluginMetadataSnapshotMock.mockReturnValue({
      configFingerprint: "sessions-plugin-metadata-test",
      index: {
        plugins: [
          {
            pluginId: "fixture-plugin",
            origin: "global",
            enabled: true,
          },
        ],
      },
      plugins: [
        {
          id: "fixture-plugin",
          origin: "global",
          cliBackends: ["fixture-cli"],
        },
      ],
    });

    const entries = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `agent:main:fixture-${index}`,
        {
          sessionId: `fixture-session-${index}`,
          updatedAt: Date.now() - index * 1_000,
          modelProvider: "fixture-cli",
          model: "openai/gpt-5.5",
        } satisfies SessionEntry,
      ]),
    );
    const store = await writeStore(entries, "sessions-plugin-metadata");

    const payload = await runSessionsJson<{
      count: number;
      totalCount: number;
      sessions: Array<{ model: string; modelProvider: string }>;
    }>(sessionsCommand, store, { limit: 1 });

    expect(payload).toMatchObject({
      count: 1,
      totalCount: 12,
      sessions: [{ model: "gpt-5.5", modelProvider: "openai" }],
    });
    expect(payload.sessions[0]).not.toHaveProperty("displayModelRef");
    expect(resolvePluginMetadataSnapshotMock).toHaveBeenCalledTimes(1);
    expect(resolvePluginMetadataSnapshotMock).toHaveBeenCalledWith({
      config,
      env: process.env,
      allowWorkspaceScopedCurrent: true,
    });
  });
});
