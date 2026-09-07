// Matrix tests cover directory live behavior through the real MatrixAuthedHttpClient
// JSON-parsing path (only the lowest-level HTTP transport is mocked), so a malformed
// homeserver response is caught end to end rather than only at the directory helper.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { performMatrixRequestMock } = vi.hoisted(() => ({
  performMatrixRequestMock: vi.fn(),
}));

vi.mock("./matrix/sdk/transport.js", () => ({
  performMatrixRequest: performMatrixRequestMock,
}));

vi.mock("./matrix/client.js", () => ({
  resolveMatrixAuth: vi.fn(),
}));

function jsonArrayResponse(): { response: Response; text: string; buffer: Buffer } {
  const text = "[]";
  return {
    response: new Response(text, { status: 200, headers: { "content-type": "application/json" } }),
    text,
    buffer: Buffer.from(text, "utf8"),
  };
}

let listMatrixDirectoryGroupsLive: typeof import("./directory-live.js").listMatrixDirectoryGroupsLive;
let listMatrixDirectoryPeersLive: typeof import("./directory-live.js").listMatrixDirectoryPeersLive;
let resolveMatrixAuth: typeof import("./matrix/client.js").resolveMatrixAuth;

describe("matrix directory live (real client, mocked transport)", () => {
  const cfg = { channels: { matrix: {} } };

  beforeAll(async () => {
    ({ listMatrixDirectoryGroupsLive, listMatrixDirectoryPeersLive } =
      await import("./directory-live.js"));
    ({ resolveMatrixAuth } = await import("./matrix/client.js"));
  });

  beforeEach(() => {
    performMatrixRequestMock.mockReset();
    vi.mocked(resolveMatrixAuth).mockReset();
    vi.mocked(resolveMatrixAuth).mockResolvedValue({
      accountId: "assistant",
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "test-token",
    });
  });

  it("rejects a real JSON array homeserver response for peer search instead of returning no matches", async () => {
    performMatrixRequestMock.mockResolvedValue(jsonArrayResponse());

    await expect(listMatrixDirectoryPeersLive({ cfg, query: "alice" })).rejects.toThrow(
      /non-object JSON response/,
    );
  });

  it("rejects a real JSON array homeserver response for joined-rooms lookup instead of returning no groups", async () => {
    performMatrixRequestMock.mockResolvedValue(jsonArrayResponse());

    await expect(listMatrixDirectoryGroupsLive({ cfg, query: "somegroup" })).rejects.toThrow(
      /non-object JSON response/,
    );
  });
});
