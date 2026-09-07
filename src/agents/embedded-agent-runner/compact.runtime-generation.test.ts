import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  acquireAgentRunPreparedModelRuntimeMock,
  contextEngineCompactMock,
  loadCompactHooksHarness,
  resetCompactHooksHarnessMocks,
  resolveContextEngineMock,
  resolveModelAsyncMock,
} from "./compact.hooks.harness.js";

const { compactEmbeddedAgentSession } = await loadCompactHooksHarness();
const [{ upsertSessionEntryCore }, { closeOpenClawAgentDatabasesForTest }] = await Promise.all([
  import("../../config/sessions/session-accessor.js"),
  import("../../state/openclaw-agent-db.js"),
]);
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    cleanup();
  }),
);

it("uses the admitted config and agent storage throughout queued compaction", async () => {
  const workspaceDir = await realpath(tempDirs.make("openclaw-compaction-generation-"));
  resetCompactHooksHarnessMocks(workspaceDir);
  const sessionTarget = {
    agentId: "main",
    sessionId: "compaction-generation",
    sessionKey: "agent:main:compaction-generation",
    storePath: join(workspaceDir, "sessions.sqlite"),
  };
  await upsertSessionEntryCore(sessionTarget, { sessionId: sessionTarget.sessionId, updatedAt: 1 });
  const admittedAgentDir = join(workspaceDir, "admitted-agent");
  const requestedConfig = {
    agents: { defaults: { compaction: { model: "openai/requested-model" } } },
  };
  const admittedConfig = {
    agents: { defaults: { compaction: { model: "openai/admitted-model" } } },
  };
  const acquire = expectDefined(
    acquireAgentRunPreparedModelRuntimeMock.getMockImplementation(),
    "prepared runtime acquisition",
  );
  acquireAgentRunPreparedModelRuntimeMock.mockImplementationOnce(async (input) =>
    acquire({ ...input, config: admittedConfig, agentDir: admittedAgentDir }),
  );

  const result = await compactEmbeddedAgentSession({
    ...sessionTarget,
    sessionTarget,
    sessionFile: sessionTarget.sessionKey,
    workspaceDir,
    allowGatewaySubagentBinding: true,
    provider: "openai",
    model: "gpt-5.6-luna",
    config: requestedConfig,
    enqueue: async (task) => await task(),
  });

  expect(result).toMatchObject({ ok: true, compacted: true });
  const { snapshot, release } = await expectDefined(
    acquireAgentRunPreparedModelRuntimeMock.mock.results[0]?.value,
    "admitted runtime lease",
  );
  const derive = expectDefined(
    acquireAgentRunPreparedModelRuntimeMock.mock.calls[0]?.[1]?.deriveRuntimePluginSelections,
    "admitted compaction selection recipe",
  );
  expect(
    derive({ config: admittedConfig, metadataSnapshot: snapshot.metadataSnapshot }),
  ).toMatchObject([{ provider: "openai", modelId: "admitted-model", agentId: "main" }]);
  expect(resolveContextEngineMock).toHaveBeenCalledWith(admittedConfig, {
    agentDir: admittedAgentDir,
    workspaceDir,
  });
  expect(resolveModelAsyncMock).toHaveBeenCalledWith(
    "openai",
    "admitted-model",
    admittedAgentDir,
    admittedConfig,
    expect.objectContaining({ preparedModelRuntime: snapshot, skipAgentDiscovery: true }),
  );
  expect(contextEngineCompactMock).toHaveBeenCalledWith(
    expect.objectContaining({
      runtimeContext: expect.objectContaining({
        config: admittedConfig,
        agentDir: admittedAgentDir,
        workspaceDir,
        provider: "openai",
        model: "admitted-model",
        sessionTarget,
      }),
    }),
  );
  expect(release).toHaveBeenCalledOnce();
  expect(requestedConfig.agents.defaults.compaction.model).toBe("openai/requested-model");
});
