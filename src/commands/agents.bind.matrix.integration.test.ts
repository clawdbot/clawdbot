import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  createBindingResolverTestPlugin,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import {
  loadFreshAgentsBindCommandModuleForTest,
  readConfigFileSnapshotMock,
  resetAgentsBindTestHarness,
  runtime,
  writeConfigFileMock,
} from "./agents.bind.test-support.js";
import { baseConfigSnapshot } from "./test-runtime-config-helpers.js";

const matrixBindingPlugin = createBindingResolverTestPlugin({
  id: "matrix",
  resolveBindingAccountId: ({ accountId, agentId }) => {
    const explicit = accountId?.trim();
    if (explicit) {
      return explicit;
    }
    const agent = agentId?.trim();
    return agent || "default";
  },
});

let agentsBindCommand: typeof import("./agents.commands.bind.js").agentsBindCommand;

describe("agents bind matrix integration", () => {
  beforeEach(async () => {
    ({ agentsBindCommand } = await loadFreshAgentsBindCommandModuleForTest());
    resetAgentsBindTestHarness();

    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "matrix", plugin: matrixBindingPlugin, source: "test" }]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it("uses matrix plugin binding resolver when accountId is omitted", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {},
    });

    await agentsBindCommand({ agent: "main", bind: ["matrix"] }, runtime);

    expect(writeConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bindings: [
          { type: "route", agentId: "main", match: { channel: "matrix", accountId: "main" } },
        ],
      }),
    );
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});
