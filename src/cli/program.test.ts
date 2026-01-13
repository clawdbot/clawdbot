import * as fs from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const messageCommand = vi.fn();
const statusCommand = vi.fn();
const configureCommand = vi.fn();
const configureCommandWithSections = vi.fn();
const setupCommand = vi.fn();
const onboardCommand = vi.fn();
const callGateway = vi.fn();
const runProviderLogin = vi.fn();
const runProviderLogout = vi.fn();
const runTui = vi.fn();

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
};

vi.mock("../commands/message.js", () => ({
  messageCommand,
}));
vi.mock("../commands/status.js", () => ({ statusCommand }));
vi.mock("../commands/configure.js", () => ({
  CONFIGURE_WIZARD_SECTIONS: [
    "workspace",
    "model",
    "gateway",
    "daemon",
    "providers",
    "skills",
    "health",
  ],
  configureCommand,
  configureCommandWithSections,
}));
vi.mock("../commands/setup.js", () => ({ setupCommand }));
vi.mock("../commands/onboard.js", () => ({ onboardCommand }));
vi.mock("../runtime.js", () => ({ defaultRuntime: runtime }));
vi.mock("./provider-auth.js", () => ({
  runProviderLogin,
  runProviderLogout,
}));
vi.mock("../tui/tui.js", () => ({
  runTui,
}));
vi.mock("../gateway/call.js", () => ({
  callGateway,
  randomIdempotencyKey: () => "idem-test",
}));
vi.mock("./deps.js", () => ({
  createDefaultDeps: () => ({}),
}));

const { buildProgram } = await import("./program.js");

describe("cli program", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runTui.mockResolvedValue(undefined);
  });

  it("runs message with required options", async () => {
    const program = buildProgram();
    await program.parseAsync(
      ["message", "send", "--to", "+1", "--message", "hi"],
      {
        from: "user",
      },
    );
    expect(messageCommand).toHaveBeenCalled();
  });

  it("runs status command", async () => {
    const program = buildProgram();
    await program.parseAsync(["status"], { from: "user" });
    expect(statusCommand).toHaveBeenCalled();
  });

  it("runs tui without overriding timeout", async () => {
    const program = buildProgram();
    await program.parseAsync(["tui"], { from: "user" });
    expect(runTui).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: undefined }),
    );
  });

  it("runs tui with explicit timeout override", async () => {
    const program = buildProgram();
    await program.parseAsync(["tui", "--timeout-ms", "45000"], {
      from: "user",
    });
    expect(runTui).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 45000 }),
    );
  });

  it("warns and ignores invalid tui timeout override", async () => {
    const program = buildProgram();
    await program.parseAsync(["tui", "--timeout-ms", "nope"], {
      from: "user",
    });
    expect(runtime.error).toHaveBeenCalledWith(
      'warning: invalid --timeout-ms "nope"; ignoring',
    );
    expect(runTui).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: undefined }),
    );
  });

  it("runs config alias as configure", async () => {
    const program = buildProgram();
    await program.parseAsync(["config"], { from: "user" });
    expect(configureCommand).toHaveBeenCalled();
  });

  it("runs setup without wizard flags", async () => {
    const program = buildProgram();
    await program.parseAsync(["setup"], { from: "user" });
    expect(setupCommand).toHaveBeenCalled();
    expect(onboardCommand).not.toHaveBeenCalled();
  });

  it("runs setup wizard when wizard flags are present", async () => {
    const program = buildProgram();
    await program.parseAsync(["setup", "--remote-url", "ws://example"], {
      from: "user",
    });
    expect(onboardCommand).toHaveBeenCalled();
    expect(setupCommand).not.toHaveBeenCalled();
  });

  it("passes opencode-zen api key to onboard", async () => {
    const program = buildProgram();
    await program.parseAsync(
      [
        "onboard",
        "--non-interactive",
        "--auth-choice",
        "opencode-zen",
        "--opencode-zen-api-key",
        "sk-opencode-zen-test",
      ],
      { from: "user" },
    );
    expect(onboardCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        nonInteractive: true,
        authChoice: "opencode-zen",
        opencodeZenApiKey: "sk-opencode-zen-test",
      }),
      runtime,
    );
  });

  it("passes openrouter api key to onboard", async () => {
    const program = buildProgram();
    await program.parseAsync(
      [
        "onboard",
        "--non-interactive",
        "--auth-choice",
        "openrouter-api-key",
        "--openrouter-api-key",
        "sk-openrouter-test",
      ],
      { from: "user" },
    );
    expect(onboardCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        nonInteractive: true,
        authChoice: "openrouter-api-key",
        openrouterApiKey: "sk-openrouter-test",
      }),
      runtime,
    );
  });

  it("passes moonshot api key to onboard", async () => {
    const program = buildProgram();
    await program.parseAsync(
      [
        "onboard",
        "--non-interactive",
        "--auth-choice",
        "moonshot-api-key",
        "--moonshot-api-key",
        "sk-moonshot-test",
      ],
      { from: "user" },
    );
    expect(onboardCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        nonInteractive: true,
        authChoice: "moonshot-api-key",
        moonshotApiKey: "sk-moonshot-test",
      }),
      runtime,
    );
  });

  it("passes synthetic api key to onboard", async () => {
    const program = buildProgram();
    await program.parseAsync(
      [
        "onboard",
        "--non-interactive",
        "--auth-choice",
        "synthetic-api-key",
        "--synthetic-api-key",
        "sk-synthetic-test",
      ],
      { from: "user" },
    );
    expect(onboardCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        nonInteractive: true,
        authChoice: "synthetic-api-key",
        syntheticApiKey: "sk-synthetic-test",
      }),
      runtime,
    );
  });

  it("passes zai api key to onboard", async () => {
    const program = buildProgram();
    await program.parseAsync(
      [
        "onboard",
        "--non-interactive",
        "--auth-choice",
        "zai-api-key",
        "--zai-api-key",
        "sk-zai-test",
      ],
      { from: "user" },
    );
    expect(onboardCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        nonInteractive: true,
        authChoice: "zai-api-key",
        zaiApiKey: "sk-zai-test",
      }),
      runtime,
    );
  });

  it("runs providers login", async () => {
    const program = buildProgram();
    await program.parseAsync(["providers", "login", "--account", "work"], {
      from: "user",
    });
    expect(runProviderLogin).toHaveBeenCalledWith(
      { provider: undefined, account: "work", verbose: false },
      runtime,
    );
  });

  it("runs providers logout", async () => {
    const program = buildProgram();
    await program.parseAsync(["providers", "logout", "--account", "work"], {
      from: "user",
    });
    expect(runProviderLogout).toHaveBeenCalledWith(
      { provider: undefined, account: "work" },
      runtime,
    );
  });

  it("runs hidden login alias", async () => {
    const program = buildProgram();
    await program.parseAsync(["login", "--account", "work"], { from: "user" });
    expect(runProviderLogin).toHaveBeenCalledWith(
      { provider: undefined, account: "work", verbose: false },
      runtime,
    );
  });

  it("runs nodes list and calls node.pair.list", async () => {
    callGateway.mockResolvedValue({ pending: [], paired: [] });
    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(["nodes", "list"], { from: "user" });
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "node.pair.list",
      }),
    );
    expect(runtime.log).toHaveBeenCalledWith("Pending: 0 · Paired: 0");
  });

  it("runs nodes status and calls node.list", async () => {
    callGateway.mockResolvedValue({
      ts: Date.now(),
      nodes: [
        {
          nodeId: "ios-node",
          displayName: "iOS Node",
          remoteIp: "192.168.0.88",
          deviceFamily: "iPad",
          modelIdentifier: "iPad16,6",
          caps: ["canvas", "camera"],
          paired: true,
          connected: true,
        },
      ],
    });
    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(["nodes", "status"], { from: "user" });

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "node.list", params: {} }),
    );

    const output = runtime.log.mock.calls
      .map((c) => String(c[0] ?? ""))
      .join("\n");
    expect(output).toContain("Known: 1 · Paired: 1 · Connected: 1");
    expect(output).toContain("iOS Node");
    expect(output).toContain("device: iPad");
    expect(output).toContain("hw: iPad16,6");
    expect(output).toContain("paired");
    expect(output).toContain("caps: [camera,canvas]");
  });

  it("runs nodes status and shows unpaired nodes", async () => {
    callGateway.mockResolvedValue({
      ts: Date.now(),
      nodes: [
        {
          nodeId: "android-node",
          displayName: "Peter's Tab S10 Ultra",
          remoteIp: "192.168.0.99",
          deviceFamily: "Android",
          modelIdentifier: "samsung SM-X926B",
          caps: ["canvas", "camera"],
          paired: false,
          connected: true,
        },
      ],
    });
    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(["nodes", "status"], { from: "user" });

    const output = runtime.log.mock.calls
      .map((c) => String(c[0] ?? ""))
      .join("\n");
    expect(output).toContain("Known: 1 · Paired: 0 · Connected: 1");
    expect(output).toContain("Peter's Tab S10 Ultra");
    expect(output).toContain("device: Android");
    expect(output).toContain("hw: samsung SM-X926B");
    expect(output).toContain("unpaired");
    expect(output).toContain("connected");
    expect(output).toContain("caps: [camera,canvas]");
  });

  it("runs nodes describe and calls node.describe", async () => {
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
        ts: Date.now(),
        nodeId: "ios-node",
        displayName: "iOS Node",
        caps: ["canvas", "camera"],
        commands: ["canvas.eval", "canvas.snapshot", "camera.snap"],
        connected: true,
      });

    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(["nodes", "describe", "--node", "ios-node"], {
      from: "user",
    });

    expect(callGateway).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ method: "node.list", params: {} }),
    );
    expect(callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "node.describe",
        params: { nodeId: "ios-node" },
      }),
    );

    const out = runtime.log.mock.calls
      .map((c) => String(c[0] ?? ""))
      .join("\n");
    expect(out).toContain("Commands:");
    expect(out).toContain("canvas.eval");
  });

  it("runs nodes approve and calls node.pair.approve", async () => {
    callGateway.mockResolvedValue({
      requestId: "r1",
      node: { nodeId: "n1", token: "t1" },
    });
    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(["nodes", "approve", "r1"], { from: "user" });
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "node.pair.approve",
        params: { requestId: "r1" },
      }),
    );
    expect(runtime.log).toHaveBeenCalled();
  });

  it("runs nodes invoke and calls node.invoke", async () => {
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
        command: "canvas.eval",
        payload: { result: "ok" },
      });

    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(
      [
        "nodes",
        "invoke",
        "--node",
        "ios-node",
        "--command",
        "canvas.eval",
        "--params",
        '{"javaScript":"1+1"}',
      ],
      { from: "user" },
    );

    expect(callGateway).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ method: "node.list", params: {} }),
    );
    expect(callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "node.invoke",
        params: {
          nodeId: "ios-node",
          command: "canvas.eval",
          params: { javaScript: "1+1" },
          timeoutMs: 15000,
          idempotencyKey: "idem-test",
        },
      }),
    );
    expect(runtime.log).toHaveBeenCalled();
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
    await program.parseAsync(
      ["nodes", "camera", "snap", "--node", "ios-node"],
      {
        from: "user",
      },
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
      program.parseAsync(
        ["nodes", "camera", "snap", "--node", "ios-node", "--facing", "nope"],
        { from: "user" },
      ),
    ).rejects.toThrow(/exit/i);

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringMatching(/invalid facing/i),
    );
  });
});
