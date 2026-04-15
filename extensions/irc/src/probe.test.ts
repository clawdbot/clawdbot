import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeIrc } from "./probe.js";

const resolveIrcAccountMock = vi.hoisted(() => vi.fn());
const buildIrcConnectOptionsMock = vi.hoisted(() => vi.fn());
const connectIrcClientMock = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", () => ({
  resolveIrcAccount: resolveIrcAccountMock,
}));

vi.mock("./connect-options.js", () => ({
  buildIrcConnectOptions: buildIrcConnectOptionsMock,
}));

vi.mock("./client.js", () => ({
  connectIrcClient: connectIrcClientMock,
}));

describe("probeIrc", () => {
  beforeEach(() => {
    resolveIrcAccountMock.mockReset();
    buildIrcConnectOptionsMock.mockReset();
    connectIrcClientMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a configuration error when the IRC account is incomplete", async () => {
    resolveIrcAccountMock.mockReturnValue({
      configured: false,
      host: "",
      port: 6667,
      tls: false,
      nick: "",
    });

    await expect(probeIrc({} as never)).resolves.toEqual({
      ok: false,
      host: "",
      port: 6667,
      tls: false,
      nick: "",
      error: "missing host or nick",
    });
    expect(connectIrcClientMock).not.toHaveBeenCalled();
  });

  it("returns latency and quits the probe client on success", async () => {
    resolveIrcAccountMock.mockReturnValue({
      configured: true,
      host: "irc.libera.chat",
      port: 6697,
      tls: true,
      nick: "openclaw",
    });
    buildIrcConnectOptionsMock.mockReturnValue({ host: "irc.libera.chat" });
    const quit = vi.fn();
    connectIrcClientMock.mockResolvedValue({ quit });
    const nowSpy = vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(145);

    try {
      const result = await probeIrc({} as never, { timeoutMs: 5000 });

      expect(buildIrcConnectOptionsMock).toHaveBeenCalledWith(
        expect.objectContaining({ host: "irc.libera.chat" }),
        { connectTimeoutMs: 5000 },
      );
      expect(result).toEqual({
        ok: true,
        host: "irc.libera.chat",
        port: 6697,
        tls: true,
        nick: "openclaw",
        latencyMs: 45,
      });
      expect(quit).toHaveBeenCalledWith("probe");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("formats non-Error probe failures into the returned error field", async () => {
    resolveIrcAccountMock.mockReturnValue({
      configured: true,
      host: "irc.libera.chat",
      port: 6667,
      tls: false,
      nick: "openclaw",
    });
    buildIrcConnectOptionsMock.mockReturnValue({ host: "irc.libera.chat" });
    connectIrcClientMock.mockRejectedValue({ code: "ECONNREFUSED" });

    await expect(probeIrc({} as never)).resolves.toEqual({
      ok: false,
      host: "irc.libera.chat",
      port: 6667,
      tls: false,
      nick: "openclaw",
      error: JSON.stringify({ code: "ECONNREFUSED" }),
    });
  });
});
