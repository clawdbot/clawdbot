// Codex tests cover command rpc plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { codexControlRequest } from "./command-rpc.js";

const requestCodexAppServerJsonMock = vi.hoisted(() => vi.fn());

vi.mock("./app-server/request.js", () => ({
  requestCodexAppServerJson: requestCodexAppServerJsonMock,
}));

describe("Codex command RPC helpers", () => {
  beforeEach(() => {
    requestCodexAppServerJsonMock.mockReset();
  });

  it("uses an explicit control connection instead of ordinary harness start options", async () => {
    requestCodexAppServerJsonMock.mockResolvedValue({ thread: { id: "thread-1" } });
    const startOptions = {
      transport: "stdio" as const,
      homeScope: "user" as const,
      command: "codex",
      args: ["app-server", "--listen", "stdio://"],
      headers: {},
    };

    await codexControlRequest(
      {},
      "thread/read",
      { threadId: "thread-1", includeTurns: false },
      { startOptions },
    );

    expect(requestCodexAppServerJsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ startOptions }),
    );
  });

  it("forwards explicit native auth for supervised control connections", async () => {
    requestCodexAppServerJsonMock.mockResolvedValue({});

    await codexControlRequest(
      {},
      "thread/compact/start",
      { threadId: "thread-1" },
      {
        authProfileId: null,
      },
    );

    expect(requestCodexAppServerJsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: null }),
    );
  });

  it("forwards an explicit per-request timeout budget", async () => {
    requestCodexAppServerJsonMock.mockResolvedValue({ data: [] });

    await codexControlRequest({}, "thread/list", { archived: false }, { timeoutMs: 321 });

    expect(requestCodexAppServerJsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 321 }),
    );
  });
});
