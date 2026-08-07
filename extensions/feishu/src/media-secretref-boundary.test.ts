import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const resolveFeishuAccountMock = vi.hoisted(() => vi.fn());
const normalizeFeishuTargetMock = vi.hoisted(() => vi.fn());
const resolveReceiveIdTypeMock = vi.hoisted(() => vi.fn());
const loadWebMediaMock = vi.hoisted(() => vi.fn());
const runFfmpegMock = vi.hoisted(() => vi.fn());
const runFfprobeMock = vi.hoisted(() => vi.fn());
const fileCreateMock = vi.hoisted(() => vi.fn());
const imageCreateMock = vi.hoisted(() => vi.fn());
const messageCreateMock = vi.hoisted(() => vi.fn());
const messageResourceGetMock = vi.hoisted(() => vi.fn());
const messageReplyMock = vi.hoisted(() => vi.fn());

const emptyConfig: ClawdbotConfig = {};

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./accounts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./accounts.js")>();
  return {
    ...actual,
    resolveFeishuAccount: resolveFeishuAccountMock,
    resolveFeishuRuntimeAccount: resolveFeishuAccountMock,
  };
});

vi.mock("./targets.js", () => ({
  normalizeFeishuTarget: normalizeFeishuTargetMock,
  resolveReceiveIdType: resolveReceiveIdTypeMock,
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    media: {
      loadWebMedia: loadWebMediaMock,
    },
  }),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>();
  return {
    ...actual,
    runFfmpeg: runFfmpegMock,
    runFfprobe: runFfprobeMock,
  };
});

let sendMediaFeishu: typeof import("./media.js").sendMediaFeishu;

describe("feishu media SecretRef owner boundary", () => {
  beforeAll(async () => {
    ({ sendMediaFeishu } = await import("./media.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    normalizeFeishuTargetMock.mockReturnValue("ou_target");
    resolveReceiveIdTypeMock.mockReturnValue("open_id");
    resolveFeishuAccountMock.mockReturnValue({
      configured: true,
      accountId: "main",
      config: {},
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
    });
    createFeishuClientMock.mockReturnValue({
      im: {
        file: { create: fileCreateMock },
        image: { create: imageCreateMock },
        message: {
          create: messageCreateMock,
          resource: { get: messageResourceGetMock },
          reply: messageReplyMock,
        },
      },
    });
  });

  it("propagates FeishuSecretRefUnavailableError without wrapping as PlatformMessageNotDispatchedError", async () => {
    const { FeishuSecretRefUnavailableError } = await import("./accounts.js");
    const { PlatformMessageNotDispatchedError } = await import("openclaw/plugin-sdk/error-runtime");
    const secretRefError = new FeishuSecretRefUnavailableError("channels.feishu.appSecret", {
      source: "exec",
      provider: "shell",
      id: "echo-secret",
    } as any);
    resolveFeishuAccountMock.mockImplementation(() => {
      throw secretRefError;
    });

    await expect(
      sendMediaFeishu({
        cfg: emptyConfig,
        to: "user:ou_target",
        mediaBuffer: Buffer.from("image"),
        fileName: "x.png",
      }),
    ).rejects.toBe(secretRefError);

    await expect(
      sendMediaFeishu({
        cfg: emptyConfig,
        to: "user:ou_target",
        mediaBuffer: Buffer.from("image"),
        fileName: "x.png",
      }),
    ).rejects.not.toBeInstanceOf(PlatformMessageNotDispatchedError);
  });
});
