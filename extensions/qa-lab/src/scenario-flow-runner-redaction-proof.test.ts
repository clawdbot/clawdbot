import path from "node:path";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

type RedactionAgentPrompt = {
  sessionKey: string;
  message: string;
  transcriptToolName?: string;
  requireSuccessfulTranscriptToolResult?: boolean;
};

const redactionScenarioIds = [
  "secret-redaction-tool-logs",
  "personal-redaction-no-secret-leak",
] as const;

const redactionProviderModes = ["mock-openai", "live-frontier"] as const;

const redactionScenarioCases = redactionScenarioIds.flatMap((scenarioId) =>
  redactionProviderModes.map((providerMode) => ({ scenarioId, providerMode })),
);

async function runSecretRedactionScenario(
  scenarioId: (typeof redactionScenarioIds)[number],
  params: {
    providerMode?: (typeof redactionProviderModes)[number];
    seedPriorInbound?: boolean;
    transcriptEvidence?: "fixture" | "unrelated-file" | "uncorrelated-result" | "missing-secret";
  } = {},
) {
  const scenario = readQaScenarioById(scenarioId);
  const config = scenario.execution.config ?? {};
  const { fakeSecret, fileName, safeMarker } = config;
  if (
    typeof fakeSecret !== "string" ||
    typeof fileName !== "string" ||
    typeof safeMarker !== "string"
  ) {
    throw new Error("secret redaction scenario must declare its fake fixture and safe marker");
  }

  const workspaceDir = "/qa-redaction-workspace";
  const fixturePath = path.join(workspaceDir, fileName);
  const unrelatedFilePath = path.join(workspaceDir, "README.md");
  const workspaceFiles = new Map<string, string>([
    [unrelatedFilePath, "Unrelated workspace documentation without credential material.\n"],
  ]);
  const harnessReadPaths: string[] = [];
  const agentToolReads: Array<{ path: string; contents: string }> = [];
  const outboundWaitCursors: number[] = [];
  const gatewayHistoryRequests: Array<{
    method: string;
    params: { sessionKey: string; limit: number; maxChars: number };
  }> = [];
  const persistedMessages: Array<Record<string, unknown>> = [];
  const state = createQaBusState();
  let agentPrompt: RedactionAgentPrompt | undefined;
  const providerMode = params.providerMode ?? "mock-openai";

  const readWorkspaceFixture = (filePath: string) => {
    const contents = workspaceFiles.get(filePath);
    if (contents === undefined) {
      throw new Error(`missing workspace fixture: ${filePath}`);
    }
    return contents;
  };

  const result = await runLoadedScenarioFlow(scenario.id, {
    state,
    api: {
      env: {
        providerMode,
        gateway: {
          workspaceDir,
          call: async (
            method: string,
            historyParams: { sessionKey: string; limit: number; maxChars: number },
          ) => {
            if (method !== "chat.history") {
              throw new Error(`unexpected gateway method: ${method}`);
            }
            gatewayHistoryRequests.push({ method, params: historyParams });
            return { messages: persistedMessages };
          },
        },
      },
      fs: {
        writeFile: async (filePath: string, contents: string) => {
          workspaceFiles.set(filePath, contents);
        },
        readFile: async (filePath: string) => {
          harnessReadPaths.push(filePath);
          if (params.seedPriorInbound) {
            state.addInboundMessage({
              accountId: "qa-channel",
              conversation: { id: "qa-operator", kind: "direct" },
              senderId: "qa-driver",
              text: "earlier inbound fixture preparation",
            });
          }
          return readWorkspaceFixture(filePath);
        },
      },
      path,
      runAgentPrompt: async (_env: unknown, prompt: RedactionAgentPrompt) => {
        agentPrompt = prompt;
        if (
          prompt.message.includes(fileName) &&
          prompt.transcriptToolName === "read" &&
          prompt.requireSuccessfulTranscriptToolResult === true
        ) {
          const toolReadPath =
            params.transcriptEvidence === "unrelated-file" ? unrelatedFilePath : fixturePath;
          const toolReadContents = readWorkspaceFixture(toolReadPath);
          agentToolReads.push({ path: toolReadPath, contents: toolReadContents });

          const callId = `qa-redaction-${providerMode}-read`;
          persistedMessages.push(
            {
              role: "assistant",
              content: [
                providerMode === "mock-openai"
                  ? {
                      type: "toolCall",
                      id: callId,
                      name: "read",
                      arguments: { path: path.basename(toolReadPath) },
                    }
                  : {
                      type: "tool_use",
                      id: callId,
                      name: "read",
                      input: { path: toolReadPath },
                    },
              ],
            },
            {
              role: "toolResult",
              toolCallId:
                params.transcriptEvidence === "uncorrelated-result"
                  ? `${callId}-different`
                  : callId,
              toolName: "read",
              isError: false,
              content: [
                {
                  type: providerMode === "mock-openai" ? "text" : "output_text",
                  text:
                    params.transcriptEvidence === "missing-secret"
                      ? "Read completed without returning credential material."
                      : toolReadContents,
                },
              ],
            },
            {
              role: "assistant",
              content: [{ type: "text", text: safeMarker }],
            },
          );
        }
        state.addOutboundMessage({
          accountId: "qa-channel",
          to: "dm:qa-operator",
          text: safeMarker,
        });
      },
      waitForOutboundMessage: async (
        currentState: ReturnType<typeof createQaBusState>,
        predicate: (message: unknown) => boolean,
        _timeoutMs: number,
        options?: { sinceIndex?: number },
      ) => {
        const sinceIndex = options?.sinceIndex ?? 0;
        outboundWaitCursors.push(sinceIndex);
        const match = currentState
          .getSnapshot()
          .messages.filter((message) => message.direction === "outbound")
          .slice(sinceIndex)
          .find((message) => predicate(message));
        if (!match) {
          throw new Error(`no outbound reply after outbound cursor ${sinceIndex}`);
        }
        return match;
      },
    },
  });

  return {
    agentPrompt,
    agentToolReads,
    fakeSecret,
    fileName,
    fixturePath,
    gatewayHistoryRequests,
    harnessReadPaths,
    outboundWaitCursors,
    result,
    state,
  };
}

describe("secret redaction scenario proof", () => {
  it.each(redactionScenarioIds)(
    "requires %s to successfully read the fake secret before proving safe delivery",
    async (scenarioId) => {
      const proof = await runSecretRedactionScenario(scenarioId);

      expect(proof.result.status).toBe("pass");
      expect(proof.harnessReadPaths).toEqual([proof.fixturePath]);
      expect(proof.agentPrompt).toMatchObject({
        transcriptToolName: "read",
        requireSuccessfulTranscriptToolResult: true,
      });
      expect(proof.agentPrompt?.message).toContain(proof.fileName);
      expect(proof.agentToolReads).toEqual([
        { path: proof.fixturePath, contents: expect.stringContaining(proof.fakeSecret) },
      ]);
    },
  );

  it.each(redactionScenarioCases)(
    "requires $scenarioId to verify the correlated fixture read from $providerMode chat history",
    async ({ scenarioId, providerMode }) => {
      const proof = await runSecretRedactionScenario(scenarioId, { providerMode });

      expect(proof.result.status).toBe("pass");
      expect(proof.gatewayHistoryRequests).toEqual([
        {
          method: "chat.history",
          params: {
            sessionKey: proof.agentPrompt?.sessionKey,
            limit: 100,
            maxChars: 131072,
          },
        },
      ]);
      expect(proof.agentToolReads).toHaveLength(1);
      expect(proof.agentToolReads[0]?.path).toBe(proof.fixturePath);
      expect(proof.agentToolReads[0]?.contents.includes(proof.fakeSecret)).toBe(true);
      expect(JSON.stringify(proof.result)).not.toContain(proof.fakeSecret);
      expect(
        proof.state
          .getSnapshot()
          .messages.filter((message) => message.direction === "outbound")
          .some((message) => message.text.includes(proof.fakeSecret)),
      ).toBe(false);
    },
  );

  it.each(redactionScenarioCases)(
    "rejects a successful unrelated read in $scenarioId under $providerMode",
    async ({ scenarioId, providerMode }) => {
      await expect(
        runSecretRedactionScenario(scenarioId, {
          providerMode,
          transcriptEvidence: "unrelated-file",
        }),
      ).rejects.toThrow("successful persisted read did not target the fake secret fixture");
    },
  );

  it.each(redactionScenarioCases)(
    "rejects an uncorrelated fixture result in $scenarioId under $providerMode",
    async ({ scenarioId, providerMode }) => {
      await expect(
        runSecretRedactionScenario(scenarioId, {
          providerMode,
          transcriptEvidence: "uncorrelated-result",
        }),
      ).rejects.toThrow("successful persisted read did not target the fake secret fixture");
    },
  );

  it.each(redactionScenarioCases)(
    "rejects a fixture result without secret material in $scenarioId under $providerMode",
    async ({ scenarioId, providerMode }) => {
      await expect(
        runSecretRedactionScenario(scenarioId, {
          providerMode,
          transcriptEvidence: "missing-secret",
        }),
      ).rejects.toThrow("successful persisted read did not target the fake secret fixture");
    },
  );

  it.each(redactionScenarioIds)(
    "%s uses an outbound-only cursor when earlier inbound messages remain on the QA bus",
    async (scenarioId) => {
      const proof = await runSecretRedactionScenario(scenarioId, { seedPriorInbound: true });

      expect(proof.result.status).toBe("pass");
      expect(proof.outboundWaitCursors).toEqual([0]);
    },
  );
});
