import { describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createRuntimeAgent } from "./runtime-agent.js";

describe("plugin runtime session creation colors", () => {
  it.each([
    { color: " Blue ", expectedColor: "blue" },
    { color: "invalid", expectedColor: undefined },
    { color: undefined, expectedColor: undefined },
  ])(
    "creates a plugin-owned CLI fork with canonical color $color",
    async ({ color, expectedColor }) => {
      await withOpenClawTestState({ label: "plugin-runtime-cli-session-create" }, async () => {
        const runtime = createRuntimeAgent();
        const key = "agent:main:catalog-adopt:claude:source";
        const created = await runtime.session.createSessionEntry({
          cfg: {},
          key,
          label: "Renamed CLI session",
          execNode: "node-a",
          execCwd: "/work/on-node",
          initialEntry: {
            cliBackendId: "claude-cli",
            color,
            model: "claude-opus-4-8",
            modelSelectionLocked: true,
            pluginOwnerId: "anthropic",
            cliSessionBinding: {
              sessionId: "claude-source",
              forceReuse: true,
              forkNextResume: true,
            },
          },
          afterCreate: async ({ entry }) => {
            expect(entry.initializationPending).toBe(true);
            expect(entry.color).toBe(expectedColor);
          },
        });
        expect(created.entry.color).toBe(expectedColor);
        expect(
          runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" }),
        ).toEqual(created.entry);
        expect(created.entry).toMatchObject({
          label: "Renamed CLI session",
          createdVia: "plugin",
          createdActor: { type: "system", id: "anthropic" },
          createdAt: expect.any(Number),
          pluginOwnerId: "anthropic",
          providerOverride: "claude-cli",
          modelOverride: "claude-opus-4-8",
          modelOverrideRouteResolution: "resolved",
          modelSelectionLocked: true,
          execHost: "node",
          execNode: "node-a",
          execCwd: "/work/on-node",
          cliSessionBindings: {
            "claude-cli": {
              sessionId: "claude-source",
              forceReuse: true,
              forkNextResume: true,
            },
          },
        });
      });
    },
  );
});
