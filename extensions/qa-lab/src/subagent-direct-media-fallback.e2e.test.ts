import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import { createQaGatewayChild } from "./gateway-child.js";
import { startQaMockOpenAiServer } from "./providers/mock-openai/server.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";

const COMPLETION_MARKER = "QA-SUBAGENT-DIRECT-MEDIA-FALLBACK-OK";
const REQUESTER_CONVERSATION = { id: "requester-user", kind: "direct" as const };
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("subagent direct media fallback", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
  });

  it("delivers a worker MEDIA directive through the ephemeral gateway channel", async () => {
    const state = createQaBusState();
    const transport = createQaChannelTransport(state);
    const bus = await startQaBusServer({ state });
    cleanups.push(() => bus.stop());

    const mock = await startQaMockOpenAiServer();
    cleanups.push(() => mock.stop());

    const gatewayOwner = createQaGatewayChild();
    cleanups.push(async () => {
      expect((await gatewayOwner.stop()).errors).toEqual([]);
    });
    const gateway = await gatewayOwner.start({
      repoRoot: REPO_ROOT,
      useRepoCli: false,
      providerBaseUrl: `${mock.baseUrl}/v1`,
      providerMode: "mock-openai",
      transport,
      transportBaseUrl: bus.baseUrl,
      controlUiEnabled: false,
    });
    await transport.waitReady({ gateway });

    const mediaPath = path.join(gateway.workspaceDir, "qa-direct-media-fallback.png");
    await writeFile(mediaPath, PNG_BYTES);
    const outboundStartIndex = state
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound").length;
    await transport.sendInbound({
      accountId: "default",
      conversation: REQUESTER_CONVERSATION,
      senderId: REQUESTER_CONVERSATION.id,
      text: ["Subagent direct fallback media QA check:", `media path: ${mediaPath}`].join("\n"),
    });

    let completion;
    try {
      completion = await transport.waitForOutbound({
        conversation: REQUESTER_CONVERSATION,
        sinceIndex: outboundStartIndex,
        textIncludes: COMPLETION_MARKER,
        timeoutMs: 90_000,
      });
    } catch (error) {
      throw new Error(
        [
          error instanceof Error ? error.message : String(error),
          `bus=${JSON.stringify(state.getSnapshot())}`,
          `gateway=${gateway.logs()}`,
        ].join("\n"),
        { cause: error },
      );
    }

    expect(completion.text).toBe(COMPLETION_MARKER);
    expect(completion.conversation).toEqual(REQUESTER_CONVERSATION);
    expect(completion.attachments).toHaveLength(1);
    const attachment = completion.attachments?.[0];
    expect(attachment).toMatchObject({
      kind: "image",
      mimeType: "image/png",
      fileName: "qa-direct-media-fallback.png",
    });
    const attachmentBytes = Buffer.from(attachment?.contentBase64 ?? "", "base64");
    expect(attachmentBytes).toEqual(PNG_BYTES);

    const outbound = state
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound");
    const visibleCompletions = outbound.filter((message) => message.text === COMPLETION_MARKER);
    expect(visibleCompletions).toHaveLength(1);
    const readScenarioRequests = async () => {
      const requests = (await fetch(`${mock.baseUrl}/debug/requests`).then((response) =>
        response.json(),
      )) as Array<{
        allInputText?: string;
        plannedToolName?: string;
      }>;
      return requests.filter(
        (request) =>
          request.allInputText?.includes("direct fallback media") ||
          request.allInputText?.includes(COMPLETION_MARKER),
      );
    };
    const scenarioRequests = await readScenarioRequests();
    expect(scenarioRequests).toHaveLength(4);
    expect(
      scenarioRequests.filter((request) => request.plannedToolName === "sessions_spawn"),
    ).toHaveLength(1);
    expect(
      scenarioRequests.filter((request) => request.plannedToolName === "sessions_yield"),
    ).toHaveLength(0);
    expect(
      scenarioRequests.filter((request) => request.allInputText?.includes(COMPLETION_MARKER)),
    ).toHaveLength(1);
    await transport.waitForNoOutbound({ sinceIndex: outbound.length, quietMs: 1_000 });
    expect(await readScenarioRequests()).toHaveLength(4);

    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
    const verdict = {
      schemaVersion: 1,
      scenario: "subagent-direct-media-fallback",
      head,
      status: "pass",
      channel: "qa-channel",
      provider: "mock-openai",
      gateway: "ephemeral",
      facts: {
        directConversation: true,
        caption: completion.text,
        visibleCompletions: visibleCompletions.length,
        attachmentCount: completion.attachments?.length ?? 0,
        attachmentKind: attachment?.kind,
        attachmentMimeType: attachment?.mimeType,
        attachmentFileName: attachment?.fileName,
        attachmentBytes: attachmentBytes.length,
        attachmentSha256: sha256(attachmentBytes),
        sourceSha256: sha256(PNG_BYTES),
        attachmentContentMatches: attachmentBytes.equals(PNG_BYTES),
        providerRequests: scenarioRequests.length,
      },
    };
    const verdictPath = path.join(
      REPO_ROOT,
      ".artifacts/qa-e2e/subagent-direct-media-fallback",
      head,
      "verdict.json",
    );
    await mkdir(path.dirname(verdictPath), { recursive: true });
    await writeFile(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
  }, 180_000);
});
