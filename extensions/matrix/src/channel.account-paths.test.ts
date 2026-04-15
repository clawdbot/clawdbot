import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMatrixPairingText, createMatrixProbeAccount } from "./channel-account-paths.js";

const sendMessageMatrixMock = vi.hoisted(() => vi.fn());
const probeMatrixMock = vi.hoisted(() => vi.fn());
const resolveMatrixAuthMock = vi.hoisted(() => vi.fn());

vi.mock("./matrix/send.js", async () => {
  const actual = await vi.importActual<typeof import("./matrix/send.js")>("./matrix/send.js");
  return {
    ...actual,
    sendMessageMatrix: (...args: unknown[]) => sendMessageMatrixMock(...args),
  };
});

vi.mock("./matrix/probe.js", async () => {
  const actual = await vi.importActual<typeof import("./matrix/probe.js")>("./matrix/probe.js");
  return {
    ...actual,
    probeMatrix: (...args: unknown[]) => probeMatrixMock(...args),
  };
});

vi.mock("./matrix/client.js", async () => {
  const actual = await vi.importActual<typeof import("./matrix/client.js")>("./matrix/client.js");
  return {
    ...actual,
    resolveMatrixAuth: (...args: unknown[]) => resolveMatrixAuthMock(...args),
  };
});

describe("matrix account path propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMessageMatrixMock.mockResolvedValue({
      messageId: "$sent",
      roomId: "!room:example.org",
    });
    probeMatrixMock.mockResolvedValue({
      ok: true,
      error: null,
      status: null,
      elapsedMs: 5,
      userId: "@poe:example.org",
    });
    resolveMatrixAuthMock.mockResolvedValue({
      accountId: "poe",
      homeserver: "https://matrix.example.org",
      userId: "@poe:example.org",
      accessToken: "poe-token",
      deviceId: "POEDEVICE",
    });
  });

  it("forwards accountId when notifying pairing approval", async () => {
    const pairingText = createMatrixPairingText(sendMessageMatrixMock);

    expect(pairingText.normalizeAllowEntry("  matrix:@user:example.org  ")).toBe(
      "@user:example.org",
    );

    await pairingText.notify({
      id: "@user:example.org",
      message: pairingText.message,
      accountId: "poe",
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledWith(
      "user:@user:example.org",
      expect.any(String),
      { accountId: "poe" },
    );
  });

  it("forwards accountId and deviceId to matrix probes", async () => {
    const probeAccount = createMatrixProbeAccount({
      resolveMatrixAuth: resolveMatrixAuthMock,
      probeMatrix: probeMatrixMock,
    });

    await probeAccount({
      cfg: {} as never,
      timeoutMs: 500,
      account: {
        accountId: "poe",
      } as never,
    });

    expect(resolveMatrixAuthMock).toHaveBeenCalledWith({
      cfg: {},
      accountId: "poe",
    });
    expect(probeMatrixMock).toHaveBeenCalledWith({
      homeserver: "https://matrix.example.org",
      accessToken: "poe-token",
      userId: "@poe:example.org",
      deviceId: "POEDEVICE",
      timeoutMs: 500,
      accountId: "poe",
    });
  });
});
