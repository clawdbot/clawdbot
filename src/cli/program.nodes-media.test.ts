import * as fs from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const messageCommand = vi.fn();
const statusCommand = vi.fn();
const configureCommand = vi.fn();
const configureCommandWithSections = vi.fn();
const setupCommand = vi.fn();
const onboardCommand = vi.fn();
const callGateway = vi.fn();
const runChannelLogin = vi.fn();
const runChannelLogout = vi.fn();
const runTui = vi.fn();

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
};

vi.mock("../commands/message.js", () => ({ messageCommand }));
vi.mock("../commands/status.js", () => ({ statusCommand }));
vi.mock("../commands/configure.js", () => ({
  CONFIGURE_WIZARD_SECTIONS: [
    "workspace",
    "model",
    "web",
    "gateway",
    "daemon",
    "channels",
    "skills",
    "health",
  ],
  configureCommand,
  configureCommandWithSections,
}));
vi.mock("../commands/setup.js", () => ({ setupCommand }));
vi.mock("../commands/onboard.js", () => ({ onboardCommand }));
vi.mock("../runtime.js", () => ({ defaultRuntime: runtime }));
vi.mock("./channel-auth.js", () => ({ runChannelLogin, runChannelLogout }));
vi.mock("../tui/tui.js", () => ({ runTui }));
vi.mock("../gateway/call.js", () => ({
  callGateway,
  randomIdempotencyKey: () => "idem-test",
}));
vi.mock("./deps.js", () => ({ createDefaultDeps: () => ({}) }));

const { buildProgram } = await import("./program.js");

describe("cli program (nodes media)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runTui.mockResolvedValue(undefined);
  });

  it("runs nodes camera snap and prints two MEDIA paths", async () => {
    callGateway
      .mockResolvedValueOnce({
        ts: Date.now(),
        nodes: [
          {
            nodeId: "ios-node",
            displayName: "iOS Node",
            remoteIp: "192.168.0.88",
            connected: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        nodeId: "ios-node",
        command: "camera.snap",
        payload: { format: "jpg", base64: "aGk=", width: 1, height: 1 },
      })
      .mockResolvedValueOnce({
        ok: true,
        nodeId: "ios-node",
        command: "camera.snap",
        payload: { format: "jpg", base64: "aGk=", width: 1, height: 1 },
      });

    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(["nodes", "camera", "snap", "--node", "ios-node"], { from: "user" });

    expect(callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "node.invoke",
        params: expect.objectContaining({
          nodeId: "ios-node",
          command: "camera.snap",
          timeoutMs: 20000,
          idempotencyKey: "idem-test",
          params: expect.objectContaining({ facing: "front", format: "jpg" }),
        }),
      }),
    );
    expect(callGateway).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        method: "node.invoke",
        params: expect.objectContaining({
          nodeId: "ios-node",
          command: "camera.snap",
          timeoutMs: 20000,
          idempotencyKey: "idem-test",
          params: expect.objectContaining({ facing: "back", format: "jpg" }),
        }),
      }),
    );

    const out = String(runtime.log.mock.calls[0]?.[0] ?? "");
    const mediaPaths = out
      .split("\n")
      .filter((l) => l.startsWith("MEDIA:"))
      .map((l) => l.replace(/^MEDIA:/, ""))
      .filter(Boolean);
    expect(mediaPaths).toHaveLength(2);

    try {
      for (const p of mediaPaths) {
        await expect(fs.readFile(p, "utf8")).resolves.toBe("hi");
      }
    } finally {
      await Promise.all(mediaPaths.map((p) => fs.unlink(p).catch(() => {})));
    }
  });

  it("runs nodes camera clip and prints one MEDIA path", async () => {
    callGateway
      .mockResolvedValueOnce({
        ts: Date.now(),
        nodes: [
          {
            nodeId: "ios-node",
            displayName: "iOS Node",
            remoteIp: "192.168.0.88",
            connected: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        nodeId: "ios-node",
        command: "camera.clip",
        payload: {
          format: "mp4",
          base64: "aGk=",
          durationMs: 3000,
          hasAudio: true,
        },
      });

    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(
      ["nodes", "camera", "clip", "--node", "ios-node", "--duration", "3000"],
      { from: "user" },
    );

    expect(callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "node.invoke",
        params: expect.objectContaining({
          nodeId: "ios-node",
          command: "camera.clip",
          timeoutMs: 90000,
          idempotencyKey: "idem-test",
          params: expect.objectContaining({
            facing: "front",
            durationMs: 3000,
            includeAudio: true,
            format: "mp4",
          }),
        }),
      }),
    );

    const out = String(runtime.log.mock.calls[0]?.[0] ?? "");
    const mediaPath = out.replace(/^MEDIA:/, "").trim();
    expect(mediaPath).toMatch(/clawdbot-camera-clip-front-.*\.mp4$/);

    try {
      await expect(fs.readFile(mediaPath, "utf8")).resolves.toBe("hi");
    } finally {
      await fs.unlink(mediaPath).catch(() => {});
    }
  });

  it("runs nodes camera snap with facing front and passes params", async () => {
    callGateway
      .mockResolvedValueOnce({
        ts: Date.now(),
        nodes: [
          {
            nodeId: "ios-node",
            displayName: "iOS Node",
            remoteIp: "192.168.0.88",
            connected: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        nodeId: "ios-node",
        command: "camera.snap",
        payload: { format: "jpg", base64: "aGk=", width: 1, height: 1 },
      });

    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(
      [
        "nodes",
        "camera",
        "snap",
        "--node",
        "ios-node",
        "--facing",
        "front",
        "--max-width",
        "640",
        "--quality",
        "0.8",
        "--delay-ms",
        "2000",
        "--device-id",
        "cam-123",
      ],
      { from: "user" },
    );

    expect(callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "node.invoke",
        params: expect.objectContaining({
          nodeId: "ios-node",
          command: "camera.snap",
          timeoutMs: 20000,
          idempotencyKey: "idem-test",
          params: expect.objectContaining({
            facing: "front",
            maxWidth: 640,
            quality: 0.8,
            delayMs: 2000,
            deviceId: "cam-123",
          }),
        }),
      }),
    );

    const out = String(runtime.log.mock.calls[0]?.[0] ?? "");
    const mediaPath = out.replace(/^MEDIA:/, "").trim();

    try {
      await expect(fs.readFile(mediaPath, "utf8")).resolves.toBe("hi");
    } finally {
      await fs.unlink(mediaPath).catch(() => {});
    }
  });

  it("runs nodes camera clip with --no-audio", async () => {
    callGateway
      .mockResolvedValueOnce({
        ts: Date.now(),
        nodes: [
          {
            nodeId: "ios-node",
            displayName: "iOS Node",
            remoteIp: "192.168.0.88",
            connected: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        nodeId: "ios-node",
        command: "camera.clip",
        payload: {
          format: "mp4",
          base64: "aGk=",
          durationMs: 3000,
          hasAudio: false,
        },
      });

    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(
      [
        "nodes",
        "camera",
        "clip",
        "--node",
        "ios-node",
        "--duration",
        "3000",
        "--no-audio",
        "--device-id",
        "cam-123",
      ],
      { from: "user" },
    );

    expect(callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "node.invoke",
        params: expect.objectContaining({
          nodeId: "ios-node",
          command: "camera.clip",
          timeoutMs: 90000,
          idempotencyKey: "idem-test",
          params: expect.objectContaining({
            includeAudio: false,
            deviceId: "cam-123",
          }),
        }),
      }),
    );

    const out = String(runtime.log.mock.calls[0]?.[0] ?? "");
    const mediaPath = out.replace(/^MEDIA:/, "").trim();

    try {
      await expect(fs.readFile(mediaPath, "utf8")).resolves.toBe("hi");
    } finally {
      await fs.unlink(mediaPath).catch(() => {});
    }
  });

  it("runs nodes camera clip with human duration (10s)", async () => {
    callGateway
      .mockResolvedValueOnce({
        ts: Date.now(),
        nodes: [
          {
            nodeId: "ios-node",
            displayName: "iOS Node",
            remoteIp: "192.168.0.88",
            connected: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        nodeId: "ios-node",
        command: "camera.clip",
        payload: {
          format: "mp4",
          base64: "aGk=",
          durationMs: 10_000,
          hasAudio: true,
        },
      });

    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(
      ["nodes", "camera", "clip", "--node", "ios-node", "--duration", "10s"],
      { from: "user" },
    );

    expect(callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "node.invoke",
        params: expect.objectContaining({
          nodeId: "ios-node",
          command: "camera.clip",
          params: expect.objectContaining({ durationMs: 10_000 }),
        }),
      }),
    );
  });

  it("runs nodes canvas snapshot and prints MEDIA path", async () => {
    callGateway
      .mockResolvedValueOnce({
        ts: Date.now(),
        nodes: [
          {
            nodeId: "ios-node",
            displayName: "iOS Node",
            remoteIp: "192.168.0.88",
            connected: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        nodeId: "ios-node",
        command: "canvas.snapshot",
        payload: { format: "png", base64: "aGk=" },
      });

    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(
      ["nodes", "canvas", "snapshot", "--node", "ios-node", "--format", "png"],
      { from: "user" },
    );

    const out = String(runtime.log.mock.calls[0]?.[0] ?? "");
    const mediaPath = out.replace(/^MEDIA:/, "").trim();
    expect(mediaPath).toMatch(/clawdbot-canvas-snapshot-.*\.png$/);

    try {
      await expect(fs.readFile(mediaPath, "utf8")).resolves.toBe("hi");
    } finally {
      await fs.unlink(mediaPath).catch(() => {});
    }
  });

  it("fails nodes camera snap on invalid facing", async () => {
    callGateway.mockResolvedValueOnce({
      ts: Date.now(),
      nodes: [
        {
          nodeId: "ios-node",
          displayName: "iOS Node",
          remoteIp: "192.168.0.88",
          connected: true,
        },
      ],
    });

    const program = buildProgram();
    runtime.error.mockClear();

    await expect(
      program.parseAsync(["nodes", "camera", "snap", "--node", "ios-node", "--facing", "nope"], {
        from: "user",
      }),
    ).rejects.toThrow(/exit/i);

    expect(runtime.error).toHaveBeenCalledWith(expect.stringMatching(/invalid facing/i));
  });
});
