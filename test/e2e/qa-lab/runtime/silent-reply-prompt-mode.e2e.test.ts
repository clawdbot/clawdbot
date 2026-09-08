import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createQaBusState,
  createQaChannelTransport,
  createQaGatewayChild,
  startQaBusServer,
  startQaMockOpenAiServer,
  type MockOpenAiRequestSnapshot,
} from "../../../../extensions/qa-lab/api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const MODEL_ID = "gpt-5.6-luna";
const MODEL_REF = `mock-openai/${MODEL_ID}`;
const MARKER = "QA_SILENT_REPLY_PROMPT_MODE";
const FINAL_REPLY = "QA_SILENT_REPLY_PROMPT_OK";
const CONVERSATION = { id: "silent-reply-proof", kind: "direct" as const };

function textContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(textContent).join("\n");
  }
  if (value && typeof value === "object" && "text" in value) {
    return textContent(value.text);
  }
  return "";
}

function promptInstructions(request: MockOpenAiRequestSnapshot): string {
  const input = Array.isArray(request.body.input) ? request.body.input : [];
  return [
    request.instructions ?? "",
    ...input.flatMap((item: unknown) =>
      item &&
      typeof item === "object" &&
      "role" in item &&
      "content" in item &&
      (item.role === "developer" || item.role === "system")
        ? [textContent(item.content)]
        : [],
    ),
  ].join("\n");
}

describe("direct-channel silent-reply prompt contract", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.splice(0).toReversed()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "silent prompt proof cleanup failed");
    }
  });

  it("omits generic silence guidance in the actual provider request while replying normally", async () => {
    const state = createQaBusState();
    const transport = createQaChannelTransport(state);
    const bus = await startQaBusServer({ state });
    cleanups.push(() => bus.stop());
    const mock = await startQaMockOpenAiServer();
    cleanups.push(() => mock.stop());
    const owner = createQaGatewayChild();
    cleanups.push(() => stopQaGatewayFixture(owner));
    const artifactDir = path.join(REPO_ROOT, ".artifacts/silent-reply-prompt-mode");
    let readGatewayLogs = () =>
      "Gateway did not finish startup; see flow.log for the startup error.";
    cleanups.push(async () => {
      // Diagnostics must run before the Gateway and provider cleanup owners.
      await fs.mkdir(artifactDir, { recursive: true });
      await fs.writeFile(path.join(artifactDir, "gateway.log"), readGatewayLogs());
      await fs.writeFile(
        path.join(artifactDir, "bus.json"),
        `${JSON.stringify(state.getSnapshot(), null, 2)}\n`,
      );
      let providerDiagnostics: unknown;
      try {
        const response = await fetch(`${mock.baseUrl}/debug/requests?after=0`, {
          signal: AbortSignal.timeout(5_000),
        });
        providerDiagnostics = { status: response.status, body: await response.json() };
      } catch (error) {
        providerDiagnostics = {
          unavailable: error instanceof Error ? error.message : String(error),
        };
      }
      await fs.writeFile(
        path.join(artifactDir, "provider.json"),
        `${JSON.stringify(providerDiagnostics, null, 2)}\n`,
      );
    });
    const gateway = await owner
      .start({
        repoRoot: REPO_ROOT,
        command: {
          executablePath: process.execPath,
          argsPrefix: [path.join(REPO_ROOT, "dist/index.js")],
          cwd: REPO_ROOT,
          usePackagedPlugins: true,
        },
        transport,
        transportBaseUrl: bus.baseUrl,
        providerBaseUrl: `${mock.baseUrl}/v1`,
        providerMode: "mock-openai",
        primaryModel: MODEL_REF,
        alternateModel: MODEL_REF,
        forcedRuntime: "openclaw",
        controlUiEnabled: false,
      })
      .catch(async (error: unknown) => {
        await fs.mkdir(artifactDir, { recursive: true });
        await fs.writeFile(
          path.join(artifactDir, "startup-error.log"),
          error instanceof Error ? (error.stack ?? error.message) : String(error),
        );
        throw error;
      });
    readGatewayLogs = gateway.logs;
    await transport.waitReady({ gateway });
    const cursorResponse = await fetch(`${mock.baseUrl}/debug/request-cursor`);
    expect(cursorResponse.ok).toBe(true);
    const cursorBody = await cursorResponse.json();
    expect(typeof cursorBody.cursor).toBe("number");

    await transport.sendInbound({
      accountId: "default",
      conversation: CONVERSATION,
      senderId: CONVERSATION.id,
      text: `${MARKER}: reply exactly ${FINAL_REPLY}.`,
    });
    const outbound = await transport.waitForOutbound({
      conversation: CONVERSATION,
      textIncludes: FINAL_REPLY,
      timeoutMs: 90_000,
    });
    expect(outbound.text).toBe(FINAL_REPLY);
    const requestsResponse = await fetch(
      `${mock.baseUrl}/debug/requests?after=${cursorBody.cursor}`,
    );
    expect(requestsResponse.ok).toBe(true);
    const requests: MockOpenAiRequestSnapshot[] = await requestsResponse.json();
    expect(requests, "Unexpected provider requests after the scenario cursor").toHaveLength(1);
    const scenarioRequests = requests.filter((request) => request.allInputText.includes(MARKER));
    expect(scenarioRequests).toHaveLength(1);
    const request = scenarioRequests[0];
    if (!request) {
      throw new Error("Provider request was not captured");
    }
    expect(request.model).toBe(MODEL_ID);
    expect(request.requestKind).toBe("agent-initial");
    expect(request.outcome).toBe("success");
    const instructions = promptInstructions(request);
    expect(instructions).toContain("## Tooling");
    expect(instructions).toContain("## Safety");
    const visible = state
      .getSnapshot()
      .messages.filter(
        (message) =>
          message.direction === "outbound" &&
          message.accountId === "default" &&
          message.conversation.id === CONVERSATION.id &&
          !message.deleted,
      );
    expect(visible).toHaveLength(1);
    expect(visible[0]?.isError).not.toBe(true);
    const evidence = {
      kind: "qa-channel-direct-ingress-gateway-provider-prompt",
      channel: "qa-channel",
      liveDiscord: false,
      requestKind: request.requestKind,
      providerOutcome: request.outcome,
      providerRequests: scenarioRequests.length,
      visibleReplies: visible.length,
      reply: outbound.text,
      hasTooling: instructions.includes("## Tooling"),
      hasSafety: instructions.includes("## Safety"),
      hasGenericSilentReplies: instructions.includes("## Silent Replies"),
    };
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(
      path.join(artifactDir, "observed.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    await fs.writeFile(path.join(artifactDir, "synthetic-instructions.txt"), instructions);
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
    expect(evidence.hasGenericSilentReplies, "SILENT_REPLY_GUIDANCE_LEAK").toBe(false);
  }, 180_000);
});
