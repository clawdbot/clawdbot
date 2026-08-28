import { beforeEach, describe, expect, it, vi } from "vitest";
import { artifactsHandlers } from "./artifacts.js";
import { expectArtifactList, expectErrorDetails, expectFields } from "./artifacts.test-support.js";

const hoisted = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  visitSessionMessagesAsync: vi.fn(),
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: hoisted.loadSessionEntry,
    loadGatewaySessionEntryReadOnly: hoisted.loadSessionEntry,
  };
});

vi.mock("../session-transcript-readers.js", async () => {
  const actual = await vi.importActual<typeof import("../session-transcript-readers.js")>(
    "../session-transcript-readers.js",
  );
  return {
    ...actual,
    visitSessionMessagesAsync: hoisted.visitSessionMessagesAsync,
  };
});

function mockMessages(messages: unknown[]) {
  hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
    messages.forEach((message, index) => visit(message, index + 1));
    return messages.length;
  });
}

async function invokeArtifactHandler(
  method: "artifacts.list" | "artifacts.get" | "artifacts.download",
  params: Record<string, unknown>,
) {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  await artifactsHandlers[method]?.({
    req: { type: "req", id: method, method, params: {} },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => calls.push({ ok, payload, error }),
    context: {
      getRuntimeConfig: () => ({ agents: { entries: { main: { default: true } } } }),
    } as never,
  });
  return calls;
}

describe("managed delegate artifact claim projections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.loadSessionEntry.mockReturnValue({
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-main", sessionFile: "/tmp/sess-main.jsonl" },
    });
  });

  it("does not collect or resolve claim projections", async () => {
    const claimId = "6dd7df78-f407-42cb-bef1-6381abe7ebd7";
    mockMessages([
      {
        role: "system",
        content: JSON.stringify({
          artifacts: [
            {
              id: claimId,
              type: "report",
              title: "Delegate report",
              mimeType: "application/pdf",
              sizeBytes: 12,
              source: "delegate-return",
              download: { mode: "unsupported" },
            },
          ],
        }),
      },
    ]);

    const listed = await invokeArtifactHandler("artifacts.list", {
      sessionKey: "agent:main:main",
    });
    expect(expectArtifactList(listed).artifacts).toEqual([]);
    for (const method of ["artifacts.get", "artifacts.download"] as const) {
      const result = await invokeArtifactHandler(method, {
        sessionKey: "agent:main:main",
        artifactId: claimId,
      });
      expectFields(expectErrorDetails(result), {
        type: "artifact_not_found",
        artifactId: claimId,
      });
      expect(JSON.stringify(result)).not.toMatch(/JVBER|base64|https?:\/\//i);
    }
  });
});
