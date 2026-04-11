import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readFileUtf8AndCleanup,
  stubFetchTextResponse,
} from "../test-utils/camera-url-test-helpers.js";
import { createNodesTool } from "./tools/nodes-tool.js";

const { callGateway } = vi.hoisted(() => ({
  callGateway: vi.fn(),
}));

vi.mock("../gateway/call.js", () => ({ callGateway }));
vi.mock("../media/image-ops.js", () => ({
  getImageMetadata: vi.fn(async () => ({ width: 1, height: 1 })),
  resizeToJpeg: vi.fn(async () => Buffer.from("jpeg")),
}));

const NODE_ID = "mac-1";
const JPG_PAYLOAD = {
  format: "jpg",
  base64: "aGVsbG8=",
  width: 1,
  height: 1,
} as const;
const PHOTOS_LATEST_ACTION_INPUT = { action: "photos_latest", node: NODE_ID } as const;
const PHOTOS_LATEST_DEFAULT_PARAMS = {
  limit: 1,
  maxWidth: 1600,
  quality: 0.85,
} as const;
const PHOTOS_LATEST_PAYLOAD = {
  photos: [
    {
      format: "jpeg",
      base64: "aGVsbG8=",
      width: 1,
      height: 1,
      createdAt: "2026-03-04T00:00:00Z",
    },
  ],
} as const;

type GatewayCall = { method: string; params?: unknown };

function unexpectedGatewayMethod(method: unknown): never {
  throw new Error(`unexpected method: ${String(method)}`);
}

function getNodesTool(options?: { modelHasVision?: boolean; allowMediaInvokeCommands?: boolean }) {
  return createNodesTool({
    ...(options?.modelHasVision !== undefined ? { modelHasVision: options.modelHasVision } : {}),
    ...(options?.allowMediaInvokeCommands !== undefined
      ? { allowMediaInvokeCommands: options.allowMediaInvokeCommands }
      : {}),
  });
}

async function executeNodes(
  input: Record<string, unknown>,
  options?: { modelHasVision?: boolean; allowMediaInvokeCommands?: boolean },
) {
  return getNodesTool(options).execute("call1", input as never);
}

type NodesToolResult = Awaited<ReturnType<typeof executeNodes>>;
type GatewayMockResult = Record<string, unknown> | null | undefined;

function mockNodeList(params?: { commands?: string[]; remoteIp?: string }) {
  return {
    nodes: [
      {
        nodeId: NODE_ID,
        ...(params?.commands ? { commands: params.commands } : {}),
        ...(params?.remoteIp ? { remoteIp: params.remoteIp } : {}),
      },
    ],
  };
}

function expectSingleImage(result: NodesToolResult, params?: { mimeType?: string }) {
  const images = (result.content ?? []).filter((block) => block.type === "image");
  expect(images).toHaveLength(1);
  if (params?.mimeType) {
    expect(images[0]?.mimeType).toBe(params.mimeType);
  }
}

function expectNoImages(result: NodesToolResult) {
  const images = (result.content ?? []).filter((block) => block.type === "image");
  expect(images).toHaveLength(0);
}

function expectFirstMediaUrl(result: NodesToolResult): string {
  const details = result.details as { media?: { mediaUrls?: string[] } } | undefined;
  const mediaUrl = details?.media?.mediaUrls?.[0];
  expect(typeof mediaUrl).toBe("string");
  return mediaUrl ?? "";
}

function expectFirstTextContains(result: NodesToolResult, expectedText: string) {
  expect(result.content?.[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining(expectedText),
  });
}

function parseFirstTextJson(result: NodesToolResult): unknown {
  const first = result.content?.[0];
  expect(first).toMatchObject({ type: "text" });
  const text = first?.type === "text" ? first.text : "";
  return JSON.parse(text);
}

function setupNodeInvokeMock(params: {
  commands?: string[];
  remoteIp?: string;
  onInvoke?: (invokeParams: unknown) => GatewayMockResult | Promise<GatewayMockResult>;
  invokePayload?: unknown;
}) {
  callGateway.mockImplementation(async ({ method, params: invokeParams }: GatewayCall) => {
    if (method === "node.list") {
      return mockNodeList({ commands: params.commands, remoteIp: params.remoteIp });
    }
    if (method === "node.invoke") {
      if (params.onInvoke) {
        return await params.onInvoke(invokeParams);
      }
      if (params.invokePayload !== undefined) {
        return { payload: params.invokePayload };
      }
      return { payload: {} };
    }
    return unexpectedGatewayMethod(method);
  });
}

function setupPhotosLatestMock(params?: { remoteIp?: string }) {
  setupNodeInvokeMock({
    ...(params?.remoteIp ? { remoteIp: params.remoteIp } : {}),
    onInvoke: (invokeParams) => {
      expect(invokeParams).toMatchObject({
        command: "photos.latest",
        params: PHOTOS_LATEST_DEFAULT_PARAMS,
      });
      return { payload: PHOTOS_LATEST_PAYLOAD };
    },
  });
}

async function executePhotosLatest(params: { modelHasVision: boolean }) {
  return executeNodes(PHOTOS_LATEST_ACTION_INPUT, {
    modelHasVision: params.modelHasVision,
  });
}

beforeEach(() => {
  callGateway.mockClear();
  vi.unstubAllGlobals();
});

describe("nodes camera_snap", () => {
  it("uses front/high-quality defaults when params are omitted", async () => {
    setupNodeInvokeMock({
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          command: "camera.snap",
          params: {
            facing: "front",
            maxWidth: 1600,
            quality: 0.95,
          },
        });
        return { payload: JPG_PAYLOAD };
      },
    });

    const result = await executeNodes(
      {
        action: "camera_snap",
        node: NODE_ID,
      },
      { modelHasVision: true },
    );

    expectSingleImage(result);
  });

  it("maps jpg payloads to image/jpeg", async () => {
    setupNodeInvokeMock({
      invokePayload: JPG_PAYLOAD,
    });

    const result = await executeNodes(
      {
        action: "camera_snap",
        node: NODE_ID,
        facing: "front",
      },
      { modelHasVision: true },
    );

    expectSingleImage(result, { mimeType: "image/jpeg" });
  });

  it("omits inline base64 image blocks when model has no vision", async () => {
    setupNodeInvokeMock({
      invokePayload: JPG_PAYLOAD,
    });

    const result = await executeNodes(
      {
        action: "camera_snap",
        node: NODE_ID,
        facing: "front",
      },
      { modelHasVision: false },
    );

    expectNoImages(result);
    expect(result.content ?? []).toEqual([]);
    expect(expectFirstMediaUrl(result)).toMatch(/openclaw-camera-snap-front-.*\.jpg$/);
  });

  it("passes deviceId when provided", async () => {
    setupNodeInvokeMock({
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          command: "camera.snap",
          params: { deviceId: "cam-123" },
        });
        return { payload: JPG_PAYLOAD };
      },
    });

    await executeNodes({
      action: "camera_snap",
      node: NODE_ID,
      facing: "front",
      deviceId: "cam-123",
    });
  });

  it("rejects facing both when deviceId is provided", async () => {
    await expect(
      executeNodes({
        action: "camera_snap",
        node: NODE_ID,
        facing: "both",
        deviceId: "cam-123",
      }),
    ).rejects.toThrow(/facing=both is not allowed when deviceId is set/i);
  });

  it("downloads camera_snap url payloads when node remoteIp is available", async () => {
    stubFetchTextResponse("url-image");
    setupNodeInvokeMock({
      remoteIp: "198.51.100.42",
      invokePayload: {
        format: "jpg",
        url: "https://198.51.100.42/snap.jpg",
        width: 1,
        height: 1,
      },
    });

    const result = await executeNodes({
      action: "camera_snap",
      node: NODE_ID,
      facing: "front",
    });

    expect(result.content ?? []).toEqual([]);
    await expect(readFileUtf8AndCleanup(expectFirstMediaUrl(result))).resolves.toBe("url-image");
  });

  it("rejects camera_snap url payloads when node remoteIp is missing", async () => {
    stubFetchTextResponse("url-image");
    setupNodeInvokeMock({
      invokePayload: {
        format: "jpg",
        url: "https://198.51.100.42/snap.jpg",
        width: 1,
        height: 1,
      },
    });

    await expect(
      executeNodes({
        action: "camera_snap",
        node: NODE_ID,
        facing: "front",
      }),
    ).rejects.toThrow(/node remoteip/i);
  });
});

describe("nodes camera_clip", () => {
  it("downloads camera_clip url payloads when node remoteIp is available", async () => {
    stubFetchTextResponse("url-clip");
    setupNodeInvokeMock({
      remoteIp: "198.51.100.42",
      invokePayload: {
        format: "mp4",
        url: "https://198.51.100.42/clip.mp4",
        durationMs: 1200,
        hasAudio: false,
      },
    });

    const result = await executeNodes({
      action: "camera_clip",
      node: NODE_ID,
      facing: "front",
    });
    const filePath = ((result.content?.[0] as { text?: string } | undefined)?.text ?? "")
      .replace(/^FILE:/, "")
      .trim();
    await expect(readFileUtf8AndCleanup(filePath)).resolves.toBe("url-clip");
  });

  it("rejects camera_clip url payloads when node remoteIp is missing", async () => {
    stubFetchTextResponse("url-clip");
    setupNodeInvokeMock({
      invokePayload: {
        format: "mp4",
        url: "https://198.51.100.42/clip.mp4",
        durationMs: 1200,
        hasAudio: false,
      },
    });

    await expect(
      executeNodes({
        action: "camera_clip",
        node: NODE_ID,
        facing: "front",
      }),
    ).rejects.toThrow(/node remoteip/i);
  });
});

describe("nodes photos_latest", () => {
  it("returns empty content/details when no photos are available", async () => {
    setupNodeInvokeMock({
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          command: "photos.latest",
          params: {
            limit: 1,
            maxWidth: 1600,
            quality: 0.85,
          },
        });
        return {
          payload: {
            photos: [],
          },
        };
      },
    });

    const result = await executeNodes(
      {
        action: "photos_latest",
        node: NODE_ID,
      },
      { modelHasVision: false },
    );

    expect(result.content ?? []).toEqual([]);
    expect(result.details).toEqual([]);
  });

  it("returns MEDIA paths and no inline images when model has no vision", async () => {
    setupPhotosLatestMock({ remoteIp: "198.51.100.42" });

    const result = await executePhotosLatest({ modelHasVision: false });

    expectNoImages(result);
    expect(result.content ?? []).toEqual([]);
    const details =
      (result.details as { photos?: Array<Record<string, unknown>> } | undefined)?.photos ?? [];
    expect(details[0]).toMatchObject({
      width: 1,
      height: 1,
      createdAt: "2026-03-04T00:00:00Z",
    });
    expect(expectFirstMediaUrl(result)).toMatch(/openclaw-camera-snap-.*\.jpg$/);
  });

  it("includes inline image blocks when model has vision", async () => {
    setupPhotosLatestMock();

    const result = await executePhotosLatest({ modelHasVision: true });

    expectSingleImage(result, { mimeType: "image/jpeg" });
    expect(expectFirstMediaUrl(result)).toMatch(/openclaw-camera-snap-.*\.jpg$/);
  });
});

describe("nodes notifications_list", () => {
  it("invokes notifications.list and returns payload", async () => {
    setupNodeInvokeMock({
      commands: ["notifications.list"],
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          nodeId: NODE_ID,
          command: "notifications.list",
          params: {},
        });
        return {
          payload: {
            enabled: true,
            connected: true,
            count: 1,
            notifications: [{ key: "n1", packageName: "com.example.app" }],
          },
        };
      },
    });

    const result = await executeNodes({
      action: "notifications_list",
      node: NODE_ID,
    });

    expectFirstTextContains(result, '"notifications"');
    expect(parseFirstTextJson(result)).toMatchObject({
      enabled: true,
      connected: true,
      count: 1,
      notifications: [{ key: "n1", packageName: "com.example.app" }],
    });
  });
});

describe("nodes notifications_action", () => {
  it("invokes notifications.actions dismiss", async () => {
    setupNodeInvokeMock({
      commands: ["notifications.actions"],
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          nodeId: NODE_ID,
          command: "notifications.actions",
          params: {
            key: "n1",
            action: "dismiss",
          },
        });
        return { payload: { ok: true, key: "n1", action: "dismiss" } };
      },
    });

    const result = await executeNodes({
      action: "notifications_action",
      node: NODE_ID,
      notificationKey: "n1",
      notificationAction: "dismiss",
    });

    expectFirstTextContains(result, '"dismiss"');
    expect(parseFirstTextJson(result)).toMatchObject({
      ok: true,
      key: "n1",
      action: "dismiss",
    });
  });

  it("invokes notifications.actions reply with reply text", async () => {
    setupNodeInvokeMock({
      commands: ["notifications.actions"],
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          nodeId: NODE_ID,
          command: "notifications.actions",
          params: {
            key: "n2",
            action: "reply",
            replyText: "On it",
          },
        });
        return { payload: { ok: true, key: "n2", action: "reply" } };
      },
    });

    const result = await executeNodes({
      action: "notifications_action",
      node: NODE_ID,
      notificationKey: "n2",
      notificationAction: "reply",
      notificationReplyText: " On it ",
    });

    expect(parseFirstTextJson(result)).toMatchObject({
      ok: true,
      key: "n2",
      action: "reply",
    });
  });
});

describe("nodes location_get", () => {
  it("invokes location.get and returns payload", async () => {
    setupNodeInvokeMock({
      commands: ["location.get"],
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          nodeId: NODE_ID,
          command: "location.get",
          params: {
            maxAgeMs: 12_000,
            desiredAccuracy: "balanced",
            timeoutMs: 4_500,
          },
        });
        return {
          payload: {
            latitude: 37.3346,
            longitude: -122.009,
            accuracyMeters: 18,
            provider: "network",
          },
        };
      },
    });

    const result = await executeNodes({
      action: "location_get",
      node: NODE_ID,
      maxAgeMs: 12_000,
      desiredAccuracy: "balanced",
      locationTimeoutMs: 4_500,
    });

    expect(parseFirstTextJson(result)).toMatchObject({
      latitude: 37.3346,
      longitude: -122.009,
      accuracyMeters: 18,
      provider: "network",
    });
  });
});

describe("nodes device_status and device_info", () => {
  it("invokes device.status and returns payload", async () => {
    setupNodeInvokeMock({
      commands: ["device.status", "device.info"],
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          nodeId: NODE_ID,
          command: "device.status",
          params: {},
        });
        return {
          payload: {
            battery: { state: "charging", lowPowerModeEnabled: false },
          },
        };
      },
    });

    const result = await executeNodes({
      action: "device_status",
      node: NODE_ID,
    });

    expectFirstTextContains(result, '"battery"');
  });

  it("invokes device.info and returns payload", async () => {
    setupNodeInvokeMock({
      commands: ["device.status", "device.info"],
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          nodeId: NODE_ID,
          command: "device.info",
          params: {},
        });
        return {
          payload: {
            systemName: "Android",
            appVersion: "1.0.0",
          },
        };
      },
    });

    const result = await executeNodes({
      action: "device_info",
      node: NODE_ID,
    });

    expectFirstTextContains(result, '"systemName"');
  });

  it("invokes device.permissions and returns payload", async () => {
    setupNodeInvokeMock({
      commands: ["device.permissions"],
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          nodeId: NODE_ID,
          command: "device.permissions",
          params: {},
        });
        return {
          payload: {
            permissions: {
              camera: { status: "granted", promptable: false },
              sms: {
                status: "denied",
                promptable: true,
                capabilities: {
                  send: { status: "denied", promptable: true },
                  read: { status: "granted", promptable: false },
                },
              },
            },
          },
        };
      },
    });

    const result = await executeNodes({
      action: "device_permissions",
      node: NODE_ID,
    });

    expectFirstTextContains(result, '"permissions"');
    expect(parseFirstTextJson(result)).toMatchObject({
      permissions: {
        sms: {
          status: "denied",
          promptable: true,
          capabilities: {
            send: { status: "denied", promptable: true },
            read: { status: "granted", promptable: false },
          },
        },
      },
    });
  });

  it("invokes device.health and returns payload", async () => {
    setupNodeInvokeMock({
      commands: ["device.health"],
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          nodeId: NODE_ID,
          command: "device.health",
          params: {},
        });
        return {
          payload: {
            memory: { pressure: "normal" },
            battery: { chargingType: "usb" },
          },
        };
      },
    });

    const result = await executeNodes({
      action: "device_health",
      node: NODE_ID,
    });

    expectFirstTextContains(result, '"memory"');
  });
});

describe("nodes invoke", () => {
  it("allows metadata-only camera.list via generic invoke", async () => {
    setupNodeInvokeMock({
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          command: "camera.list",
          params: {},
        });
        return {
          payload: {
            devices: [{ id: "cam-back", name: "Back Camera" }],
          },
        };
      },
    });

    const result = await executeNodes({
      action: "invoke",
      node: NODE_ID,
      invokeCommand: "camera.list",
    });

    expect(result.details).toMatchObject({
      payload: {
        devices: [{ id: "cam-back", name: "Back Camera" }],
      },
    });
  });

  it("blocks media invoke commands to avoid base64 context bloat", async () => {
    await expect(
      executeNodes({
        action: "invoke",
        node: NODE_ID,
        invokeCommand: "photos.latest",
        invokeParamsJson: '{"limit":1}',
      }),
    ).rejects.toThrow(/use action="photos_latest"/i);
  });

  it("allows media invoke commands when explicitly enabled", async () => {
    setupNodeInvokeMock({
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          command: "photos.latest",
          params: { limit: 1 },
        });
        return {
          payload: {
            photos: [{ format: "jpg", base64: "aGVsbG8=", width: 1, height: 1 }],
          },
        };
      },
    });

    const result = await executeNodes(
      {
        action: "invoke",
        node: NODE_ID,
        invokeCommand: "photos.latest",
        invokeParamsJson: '{"limit":1}',
      },
      { allowMediaInvokeCommands: true },
    );

    expect(result.details).toMatchObject({
      payload: {
        photos: [{ format: "jpg", base64: "aGVsbG8=", width: 1, height: 1 }],
      },
    });
  });
});
