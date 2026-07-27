// Whatsapp tests cover agent tools login plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { startWebLoginWithQr, waitForWebLogin } from "../login-qr-api.js";
import { createWhatsAppLoginTool } from "./agent-tools-login.js";

vi.mock("../login-qr-api.js", () => ({
  startWebLoginWithQr: vi.fn(),
  waitForWebLogin: vi.fn(),
}));

const startWebLoginWithQrMock = vi.mocked(startWebLoginWithQr);
const waitForWebLoginMock = vi.mocked(waitForWebLogin);

describe("createWhatsAppLoginTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes the caller's current QR back into wait actions", async () => {
    const accountId = "account-1";
    waitForWebLoginMock.mockResolvedValueOnce({
      connected: false,
      message: "QR refreshed. Scan the latest code in WhatsApp → Linked Devices.",
      qrDataUrl: "data:image/png;base64,next-qr",
    });

    const tool = createWhatsAppLoginTool();
    const result = await tool.execute("tool-call-1", {
      action: "wait",
      timeoutMs: "5000",
      accountId,
      currentQrDataUrl: "data:image/png;base64,current-qr",
    });

    expect(waitForWebLoginMock).toHaveBeenCalledWith({
      accountId,
      timeoutMs: 5000,
      currentQrDataUrl: "data:image/png;base64,current-qr",
    });
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: [
            "QR refreshed. Scan the latest code in WhatsApp → Linked Devices.",
            "",
            "Open WhatsApp → Linked Devices and scan:",
            "",
            "![whatsapp-qr](data:image/png;base64,next-qr)",
          ].join("\n"),
        },
      ],
      details: {
        connected: false,
        qr: true,
      },
    });
  });

  it("passes string timeoutMs through to start actions", async () => {
    startWebLoginWithQrMock.mockResolvedValueOnce({
      connected: false,
      message: "Scan this QR in WhatsApp → Linked Devices.",
      qrDataUrl: "data:image/png;base64,current-qr",
    });

    const tool = createWhatsAppLoginTool();
    await tool.execute("tool-call-start", {
      action: "start",
      timeoutMs: "6000",
      accountId: "account-3",
    });

    expect(startWebLoginWithQrMock).toHaveBeenCalledWith({
      accountId: "account-3",
      timeoutMs: 6000,
      force: false,
    });
  });

  it("rejects fractional timeoutMs before login actions", async () => {
    const tool = createWhatsAppLoginTool();

    await expect(
      tool.execute("tool-call-start", {
        action: "start",
        timeoutMs: "6000.5",
      }),
    ).rejects.toThrow("timeoutMs must be a positive integer");
    expect(startWebLoginWithQrMock).not.toHaveBeenCalled();
  });

  it("does not retain QR state across tool actions", async () => {
    const accountId = "account-2";
    startWebLoginWithQrMock.mockResolvedValueOnce({
      connected: false,
      message: "Scan this QR in WhatsApp → Linked Devices.",
      qrDataUrl: "data:image/png;base64,current-qr",
    });
    waitForWebLoginMock.mockResolvedValueOnce({
      connected: true,
      message: "✅ Linked! WhatsApp is ready.",
    });

    const tool = createWhatsAppLoginTool();
    await tool.execute("tool-call-start", { action: "start", accountId });
    await tool.execute("tool-call-wait", { action: "wait", timeoutMs: 5000, accountId });

    expect(waitForWebLoginMock).toHaveBeenCalledWith({
      accountId,
      timeoutMs: 5000,
      currentQrDataUrl: undefined,
    });
  });
});
