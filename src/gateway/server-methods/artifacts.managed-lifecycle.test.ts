import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectErrorDetails, expectFields } from "./artifacts.test-support.js";

const hoisted = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  resolveManagedArtifactDownload: vi.fn(),
  resolveManagedUrlDownload: vi.fn(),
  visitSessionMessagesAsync: vi.fn(),
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadGatewaySessionEntryReadOnly: hoisted.loadSessionEntry,
  };
});

vi.mock("../session-transcript-readers.js", async () => {
  const actual = await vi.importActual<typeof import("../session-transcript-readers.js")>(
    "../session-transcript-readers.js",
  );
  return { ...actual, visitSessionMessagesAsync: hoisted.visitSessionMessagesAsync };
});

vi.mock("../managed-image-attachments.js", async () => {
  const actual = await vi.importActual<typeof import("../managed-image-attachments.js")>(
    "../managed-image-attachments.js",
  );
  return {
    ...actual,
    resolveManagedOutgoingMediaArtifactDownload: hoisted.resolveManagedArtifactDownload,
    resolveManagedOutgoingMediaUrlDownload: hoisted.resolveManagedUrlDownload,
  };
});

const { artifactsHandlers } = await import("./artifacts.js");

describe("managed artifact lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.loadSessionEntry.mockReturnValue({
      storePath: "/tmp/sessions.sqlite",
      entry: { sessionId: "sess-main" },
    });
    hoisted.resolveManagedArtifactDownload.mockResolvedValue(null);
    hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
      visit(
        {
          role: "assistant",
          content: [
            {
              type: "image",
              artifactId: "artifact_managed_image_11111111-1111-4111-8111-111111111111",
              url: "/api/chat/media/outgoing/agent%3Amain%3Amain/22222222-2222-4222-8222-222222222222/full",
            },
          ],
          __openclaw: { seq: 2 },
        },
        2,
      );
      return 1;
    });
  });

  it("does not retarget a stale managed artifact id through a different block URL", async () => {
    const artifactId = "artifact_managed_image_11111111-1111-4111-8111-111111111111";
    const calls: Array<{ ok: boolean; error?: unknown }> = [];

    await artifactsHandlers["artifacts.download"]?.({
      req: { type: "req", id: "download", method: "artifacts.download", params: {} },
      params: { sessionKey: "agent:main:main", artifactId },
      client: null,
      isWebchatConnect: () => false,
      respond: (ok, _payload, error) => calls.push({ ok, error }),
      context: { getRuntimeConfig: () => ({}) } as never,
    });

    expect(calls[0]?.ok).toBe(false);
    expectFields(expectErrorDetails(calls), { type: "artifact_not_found", artifactId });
    expect(hoisted.resolveManagedUrlDownload).not.toHaveBeenCalled();
    expect(hoisted.visitSessionMessagesAsync).not.toHaveBeenCalled();
  });

  it("lists managed attachment envelopes as file artifacts", async () => {
    hoisted.visitSessionMessagesAsync.mockImplementationOnce(async (_scope, visit) => {
      visit(
        {
          role: "assistant",
          content: [
            {
              type: "attachment",
              attachment: {
                artifactId: "artifact_managed_media_11111111-1111-4111-8111-111111111111",
                kind: "document",
                label: "report.csv",
                mimeType: "text/csv",
                sizeBytes: 12,
                url: "/api/chat/media/outgoing/agent%3Amain%3Amain/11111111-1111-4111-8111-111111111111/full",
              },
            },
          ],
          __openclaw: { seq: 2 },
        },
        2,
      );
      return 1;
    });
    const calls: Array<{ ok: boolean; payload?: unknown }> = [];

    await artifactsHandlers["artifacts.list"]?.({
      req: { type: "req", id: "list", method: "artifacts.list", params: {} },
      params: { sessionKey: "agent:main:main" },
      client: null,
      isWebchatConnect: () => false,
      respond: (ok, payload) => calls.push({ ok, payload }),
      context: { getRuntimeConfig: () => ({}) } as never,
    });

    expect(calls[0]).toMatchObject({
      ok: true,
      payload: {
        artifacts: [
          {
            id: "artifact_managed_media_11111111-1111-4111-8111-111111111111",
            type: "file",
            title: "report.csv",
            mimeType: "text/csv",
            sizeBytes: 12,
          },
        ],
      },
    });
  });
});
