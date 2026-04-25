import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitWhatsAppLogin, type ChannelsState } from "./channels.ts";

function createState(): ChannelsState {
  return {
    client: {
      request: vi.fn(),
    } as never,
    connected: true,
    channelsLoading: false,
    channelsSnapshot: null,
    channelsError: null,
    channelsLastSuccess: null,
    whatsappLoginMessage: null,
    whatsappLoginQrDataUrl: "data:image/png;base64,current-qr",
    whatsappLoginConnected: false,
    whatsappBusy: false,
  };
}

describe("channels controller WhatsApp wait", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes the currently displayed QR and replaces it when the login QR rotates", async () => {
    const state = createState();
    const request = vi.mocked(state.client!.request);
    request.mockResolvedValueOnce({
      connected: false,
      message: "QR refreshed. Scan the latest code in WhatsApp → Linked Devices.",
      qrDataUrl: "data:image/png;base64,next-qr",
    });

    await waitWhatsAppLogin(state);

    expect(request).toHaveBeenCalledWith("web.login.wait", {
      timeoutMs: 120000,
      currentQrDataUrl: "data:image/png;base64,current-qr",
    });
    expect(state.whatsappLoginMessage).toBe(
      "QR refreshed. Scan the latest code in WhatsApp → Linked Devices.",
    );
    expect(state.whatsappLoginConnected).toBe(false);
    expect(state.whatsappLoginQrDataUrl).toBe("data:image/png;base64,next-qr");
    expect(state.whatsappBusy).toBe(false);
  });
});
