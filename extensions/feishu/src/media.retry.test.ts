import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const resolveFeishuAccountMock = vi.hoisted(() => vi.fn());
const normalizeFeishuTargetMock = vi.hoisted(() => vi.fn());
const resolveReceiveIdTypeMock = vi.hoisted(() => vi.fn());
const imageCreateMock = vi.hoisted(() => vi.fn());
const messageCreateMock = vi.hoisted(() => vi.fn());

const emptyConfig: ClawdbotConfig = {};
const validPngImage = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de",
  "hex",
);

vi.mock("./client.js", () => ({ createFeishuClient: createFeishuClientMock }));
vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: resolveFeishuAccountMock,
  resolveFeishuRuntimeAccount: resolveFeishuAccountMock,
}));
vi.mock("./targets.js", () => ({
  normalizeFeishuTarget: normalizeFeishuTargetMock,
  resolveReceiveIdType: resolveReceiveIdTypeMock,
}));

let sendMediaFeishu: typeof import("./media.js").sendMediaFeishu;

function sendTestImage() {
  return sendMediaFeishu({
    cfg: emptyConfig,
    to: "user:ou_target",
    mediaBuffer: validPngImage,
    fileName: "photo.png",
  });
}

function messageData(callIndex: number): { uuid?: string } {
  const call = messageCreateMock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected message create call at index ${callIndex}`);
  }
  return call[0].data;
}

describe("sendMediaFeishu retries", () => {
  beforeAll(async () => {
    ({ sendMediaFeishu } = await import("./media.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resolveFeishuAccountMock.mockReturnValue({
      configured: true,
      accountId: "main",
      config: {},
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
    });
    normalizeFeishuTargetMock.mockReturnValue("ou_target");
    resolveReceiveIdTypeMock.mockReturnValue("open_id");
    createFeishuClientMock.mockReturnValue({
      im: {
        image: { create: imageCreateMock },
        message: { create: messageCreateMock },
      },
    });
    imageCreateMock.mockResolvedValue({ code: 0, data: { image_key: "image_key_1" } });
    messageCreateMock.mockResolvedValue({ code: 0, data: { message_id: "msg_1" } });
  });

  it("reuses one uuid when retrying a transient media message send", async () => {
    messageCreateMock.mockRejectedValueOnce(
      Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    );

    await sendTestImage();

    const firstUuid = messageData(0).uuid;
    expect(firstUuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(messageData(1).uuid).toBe(firstUuid);
  });

  it("does not retry non-idempotent media uploads on transient failures", async () => {
    imageCreateMock.mockRejectedValueOnce(
      Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    );

    await expect(sendTestImage()).rejects.toThrow("Feishu image upload failed");

    expect(imageCreateMock).toHaveBeenCalledTimes(1);
    expect(messageCreateMock).not.toHaveBeenCalled();
  });
});
