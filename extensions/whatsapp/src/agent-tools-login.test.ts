import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
// Whatsapp tests cover agent tools login plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { startWebLoginWithQr, waitForWebLogin } from "../login-qr-api.js";
import { registerWhatsAppLoginTool } from "./agent-tools-login.js";

vi.mock("../login-qr-api.js", () => ({
  startWebLoginWithQr: vi.fn(),
  waitForWebLogin: vi.fn(),
}));

const startWebLoginWithQrMock = vi.mocked(startWebLoginWithQr);
const waitForWebLoginMock = vi.mocked(waitForWebLogin);

function resolveRegisteredLoginTool(context: OpenClawPluginToolContext): AnyAgentTool | null {
  const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
  const api = createTestPluginApi({ registerTool });
  registerWhatsAppLoginTool(api);
  const factory = registerTool.mock.calls[0]?.[0];
  if (typeof factory !== "function") {
    throw new Error("WhatsApp login tool factory was not registered");
  }
  expect(registerTool.mock.calls[0]?.[1]).toEqual({ name: "whatsapp_login" });
  const tool = factory(context);
  if (Array.isArray(tool)) {
    throw new Error("expected one WhatsApp login tool");
  }
  return tool ?? null;
}

function createOwnerLoginTool(context: OpenClawPluginToolContext = { senderIsOwner: true }) {
  const tool = resolveRegisteredLoginTool(context);
  if (!tool) {
    throw new Error("expected WhatsApp login tool for owner sender");
  }
  return tool;
}

describe("createWhatsAppLoginTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([false, undefined])("hides the login tool when owner status is %s", (senderIsOwner) => {
    expect(resolveRegisteredLoginTool({ senderIsOwner })).toBeNull();
  });

  it("rejects credential persistence after the owning tool execution closes", async () => {
    const tool = createOwnerLoginTool();
    const controller = new AbortController();
    let beforeCredentialPersistence: (() => Promise<void>) | undefined;
    startWebLoginWithQrMock.mockImplementationOnce(async (options) => {
      beforeCredentialPersistence = options?.beforeCredentialPersistence;
      return { message: "login started" };
    });

    await tool.execute("tool-call-active", { action: "start" }, controller.signal);
    await expect(beforeCredentialPersistence?.()).resolves.toBeUndefined();
    controller.abort();

    await expect(
      tool.execute("tool-call-retained", { action: "start" }, controller.signal),
    ).rejects.toThrow("WhatsApp login authority is no longer active");
    await expect(beforeCredentialPersistence?.()).rejects.toThrow(
      "WhatsApp login authority is no longer active",
    );
    expect(startWebLoginWithQrMock).toHaveBeenCalledOnce();
  });

  it("fully anchors the QR data URL pattern for grammar-constrained models", () => {
    const tool = createOwnerLoginTool();
    const pattern = (tool.parameters as { properties: { currentQrDataUrl?: { pattern?: string } } })
      .properties.currentQrDataUrl?.pattern;

    expect(pattern).toBe("^data:image/png;base64,.+$");
    expect(pattern?.startsWith("^")).toBe(true);
    expect(pattern?.endsWith("$")).toBe(true);

    const expression = new RegExp(pattern ?? "");
    expect(expression.test("data:image/png;base64,YQ==")).toBe(true);
    expect(expression.test("data:image/png;base64,")).toBe(false);
    expect(expression.test("data:image/jpeg;base64,YQ==")).toBe(false);
  });

  it("passes the caller's current QR back into wait actions", async () => {
    const accountId = "account-1";
    waitForWebLoginMock.mockResolvedValueOnce({
      connected: false,
      message: "QR refreshed. Scan the latest code in WhatsApp → Linked Devices.",
      qrDataUrl: "data:image/png;base64,next-qr",
    });

    const tool = createOwnerLoginTool();
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

    const tool = createOwnerLoginTool();
    await tool.execute(
      "tool-call-start",
      {
        action: "start",
        timeoutMs: "6000",
        accountId: "account-3",
      },
      new AbortController().signal,
    );

    expect(startWebLoginWithQrMock).toHaveBeenCalledWith({
      accountId: "account-3",
      timeoutMs: 6000,
      force: false,
      beforeCredentialPersistence: expect.any(Function),
    });
  });

  it("rejects fractional timeoutMs before login actions", async () => {
    const tool = createOwnerLoginTool();

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

    const tool = createOwnerLoginTool();
    await tool.execute(
      "tool-call-start",
      { action: "start", accountId },
      new AbortController().signal,
    );
    await tool.execute("tool-call-wait", { action: "wait", timeoutMs: 5000, accountId });

    expect(waitForWebLoginMock).toHaveBeenCalledWith({
      accountId,
      timeoutMs: 5000,
      currentQrDataUrl: undefined,
    });
  });
});
