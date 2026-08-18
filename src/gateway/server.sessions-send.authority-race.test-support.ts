import fs from "node:fs/promises";
import path from "node:path";
import { expect, type Mock } from "vitest";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import {
  getGlobalPluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import { agentCommandMock, testState, writeSessionStore } from "./test-helpers.js";

export async function runSessionsSendAuthorityClosureScenario(params: {
  createOpenClawTools: typeof import("../agents/openclaw-tools.js").createOpenClawTools;
  dir: string;
}): Promise<void> {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH missing in gateway test environment");
  }
  const sourceSessionKey = "agent:main:main";
  const targetSessionKey = "agent:main:authority-race-target";
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    `${JSON.stringify({ tools: { sessions: { visibility: "all" } } }, null, 2)}\n`,
    "utf-8",
  );
  testState.sessionStorePath = path.join(params.dir, "sessions.json");
  await writeSessionStore({
    entries: {
      [sourceSessionKey]: { sessionId: "authority-race-source", updatedAt: Date.now() },
      [targetSessionKey]: { sessionId: "authority-race-target", updatedAt: Date.now() },
    },
  });
  const agentCommand = agentCommandMock as unknown as Mock<(opts: unknown) => Promise<void>>;
  agentCommand.mockClear();
  const operationalRunInstance = {
    instanceId: `sessions-send-race-${Date.now()}`,
    runId: `sessions-send-race-run-${Date.now()}`,
  };
  const delegatedAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  const previousHookRegistry = getGlobalPluginRegistry();
  let authorityReleased = false;
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      {
        hookName: "before_message_write",
        pluginId: "authority-race",
        handler: (_event, context) => {
          if (
            !authorityReleased &&
            (context as { sessionKey?: string }).sessionKey === targetSessionKey
          ) {
            authorityReleased = releaseAgentRunDelegatedAuthority(delegatedAuthority);
          }
        },
      },
    ]),
  );
  try {
    const tool = params
      .createOpenClawTools({
        agentSessionKey: sourceSessionKey,
        config: { tools: { sessions: { visibility: "all" } } },
        sessionsSendHandoff: {
          inheritedToolPolicy: { version: 1, allow: ["sessions_send", "read"], deny: [] },
          requester: { messageProvider: "discord", senderId: "speaker-1" },
        },
      })
      .find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }
    const result = await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: sourceSessionKey, operationalRunInstance },
      () =>
        tool.execute("call-authority-race", {
          sessionKey: targetSessionKey,
          message: "do not dispatch after closure",
          timeoutSeconds: 5,
        }),
    );
    expect(result.details).toMatchObject({
      status: "error",
      error: expect.stringContaining("agent runtime authority"),
    });
    expect(authorityReleased).toBe(true);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(
      agentCommand.mock.calls.filter(
        ([opts]) => (opts as { sessionKey?: string }).sessionKey === targetSessionKey,
      ),
    ).toEqual([]);
  } finally {
    releaseAgentRunDelegatedAuthority(delegatedAuthority);
    if (previousHookRegistry) {
      initializeGlobalHookRunner(previousHookRegistry);
    } else {
      resetGlobalHookRunner();
    }
    testState.sessionStorePath = undefined;
  }
}
