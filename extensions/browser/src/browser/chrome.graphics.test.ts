// Browser tests cover managed Chrome graphics diagnostics and process caching.
import { describe, expect, it, vi } from "vitest";
import type { RunningChrome } from "./chrome.js";
import type { BrowserGraphicsDiagnostics } from "./client.types.js";

const { getChromeWebSocketUrlMock, sendMock, withCdpSocketMock } = vi.hoisted(() => ({
  getChromeWebSocketUrlMock: vi.fn(async () => "ws://127.0.0.1/devtools/browser/test"),
  sendMock: vi.fn(),
  withCdpSocketMock: vi.fn(),
}));

vi.mock("./chrome.js", () => ({
  getChromeWebSocketUrl: getChromeWebSocketUrlMock,
}));

vi.mock("./cdp.helpers.js", () => ({
  redactCdpErrorText: (value: string) => value,
  withCdpSocket: withCdpSocketMock,
}));

const {
  getCachedChromeGraphicsDiagnostics,
  inspectChromeGraphicsDiagnostics,
  normalizeChromeGraphicsInfo,
} = await import("./chrome.graphics.js");

function availableDiagnostics(observedAt = 123): BrowserGraphicsDiagnostics {
  return {
    status: "available",
    observedAt,
    acceleration: "software",
    renderer: "ANGLE (Google, Vulkan, SwiftShader Device)",
    vendor: "Google Inc.",
    version: "OpenGL ES 3.0",
    backend: "(gl=angle,angle=swiftshader)",
    devices: [
      {
        vendorId: 65535,
        deviceId: 65535,
        vendor: "Google Inc.",
        device: "SwiftShader Device",
        driverVendor: "SwANGLE",
        driverVersion: "5.0.0",
      },
    ],
    featureStatus: {
      gpu_compositing: "disabled_software",
      webgl: "enabled_readback",
    },
    disabledFeatures: [{ feature: "gpu_compositing", status: "disabled_software" }],
    driverBugWorkarounds: ["disable_d3d11"],
    videoDecoding: [
      {
        profile: "VP9 Profile 0",
        minResolution: { width: 64, height: 64 },
        maxResolution: { width: 4096, height: 4096 },
      },
    ],
    videoEncoding: [],
  };
}

describe("managed Chrome graphics diagnostics", () => {
  it("normalizes SystemInfo.getInfo without retaining the browser command line", () => {
    const diagnostics = normalizeChromeGraphicsInfo(
      {
        commandLine: "--proxy-server=https://user:secret@example.com",
        gpu: {
          devices: [
            {
              vendorId: 65535,
              deviceId: 65535,
              vendorString: "Google Inc.",
              deviceString: "SwiftShader Device",
              driverVendor: "SwANGLE",
              driverVersion: "5.0.0",
            },
          ],
          auxAttributes: {
            glRenderer: "ANGLE (Google, Vulkan, SwiftShader Device)",
            glVendor: "Google Inc.",
            glVersion: "OpenGL ES 3.0",
            glImplementationParts: "(gl=angle,angle=swiftshader)",
          },
          featureStatus: {
            webgl: "enabled_readback",
            gpu_compositing: "disabled_software",
          },
          driverBugWorkarounds: ["disable_d3d11"],
          videoDecoding: [
            {
              profile: "VP9 Profile 0",
              minResolution: { width: 64, height: 64 },
              maxResolution: { width: 4096, height: 4096 },
            },
          ],
          videoEncoding: [],
        },
      },
      123,
    );

    expect(diagnostics).toEqual(availableDiagnostics());
    expect(JSON.stringify(diagnostics)).not.toContain("proxy-server");
    expect(JSON.stringify(diagnostics)).not.toContain("secret");
  });

  it("uses core feature states when disabled GPU mode omits renderer and device text", () => {
    const diagnostics = normalizeChromeGraphicsInfo(
      {
        gpu: {
          devices: [
            {
              vendorId: 0,
              deviceId: 0,
              vendorString: "",
              deviceString: "",
              driverVendor: "",
              driverVersion: "",
            },
          ],
          auxAttributes: {
            glRenderer: "",
            glVendor: "",
            glVersion: "",
            glImplementationParts: "(gl=disabled,angle=none)",
          },
          featureStatus: {
            "2d_canvas": "disabled_software",
            gpu_compositing: "disabled_software",
            rasterization: "disabled_software",
            webgl: "unavailable_software",
          },
          driverBugWorkarounds: [],
          videoDecoding: [],
          videoEncoding: [],
        },
      },
      124,
    );

    expect(diagnostics).toMatchObject({
      status: "available",
      observedAt: 124,
      acceleration: "software",
      renderer: null,
      vendor: null,
      version: null,
      backend: "(gl=disabled,angle=none)",
    });
  });

  it("classifies Chrome's disabled renderer sentinel as software", () => {
    const diagnostics = normalizeChromeGraphicsInfo({
      gpu: {
        devices: [
          {
            vendorId: 0,
            deviceId: 0,
            vendorString: "",
            deviceString: "",
            driverVendor: "",
            driverVersion: "",
          },
        ],
        auxAttributes: {
          glRenderer: "Disabled",
          glVendor: "Disabled",
          glVersion: "Disabled",
          glImplementationParts: "(gl=disabled,angle=none)",
        },
        featureStatus: {
          "2d_canvas": "disabled_software",
          gpu_compositing: "disabled_software",
          rasterization: "disabled_software",
          webgl: "disabled_off",
        },
        driverBugWorkarounds: [],
        videoDecoding: [],
        videoEncoding: [],
      },
    });

    expect(diagnostics).toMatchObject({
      status: "available",
      acceleration: "software",
      renderer: "Disabled",
      backend: "(gl=disabled,angle=none)",
    });
  });

  it("prefers an observed hardware renderer over unrelated software feature states", () => {
    const diagnostics = normalizeChromeGraphicsInfo({
      gpu: {
        devices: [],
        auxAttributes: {
          glRenderer: "ANGLE (NVIDIA, GeForce RTX 4090 Direct3D11)",
        },
        featureStatus: {
          gpu_compositing: "enabled",
          video_encode: "disabled_software",
        },
        driverBugWorkarounds: [],
        videoDecoding: [],
        videoEncoding: [],
      },
    });

    expect(diagnostics).toMatchObject({
      status: "available",
      acceleration: "hardware",
      renderer: "ANGLE (NVIDIA, GeForce RTX 4090 Direct3D11)",
    });
  });

  it("classifies Windows WARP and the Microsoft Basic Render Driver as software", () => {
    const diagnostics = normalizeChromeGraphicsInfo({
      gpu: {
        devices: [
          {
            vendorId: 65535,
            deviceId: 65535,
            vendorString: "Google Inc. (Microsoft)",
            deviceString:
              "ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11, D3D11-10.0.20348.5020)",
            driverVendor: "SwANGLE",
            driverVersion: "10.0.20348.5020",
          },
        ],
        auxAttributes: {
          glRenderer:
            "ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11, D3D11-10.0.20348.5020)",
          glImplementationParts: "(gl=egl-angle,angle=d3d11-warp)",
        },
        featureStatus: {
          gpu_compositing: "disabled_software",
          rasterization: "disabled_software",
          webgl: "unavailable_software",
        },
        driverBugWorkarounds: [],
        videoDecoding: [],
        videoEncoding: [],
      },
    });

    expect(diagnostics).toMatchObject({
      status: "available",
      acceleration: "software",
      backend: "(gl=egl-angle,angle=d3d11-warp)",
    });
  });

  it("uses the browser-level SystemInfo command with bounded passive timeouts", async () => {
    sendMock.mockResolvedValueOnce({
      gpu: {
        devices: [],
        auxAttributes: { glRenderer: "llvmpipe" },
        featureStatus: {},
        driverBugWorkarounds: [],
        videoDecoding: [],
        videoEncoding: [],
      },
    });
    withCdpSocketMock.mockImplementationOnce(
      async (_url, run: (send: typeof sendMock) => Promise<unknown>) => await run(sendMock),
    );

    const diagnostics = await inspectChromeGraphicsDiagnostics("http://127.0.0.1:18800", {
      httpTimeoutMs: 300,
      handshakeTimeoutMs: 600,
      commandTimeoutMs: 1_000,
    });

    expect(getChromeWebSocketUrlMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18800",
      300,
      undefined,
    );
    expect(sendMock).toHaveBeenCalledWith("SystemInfo.getInfo");
    expect(withCdpSocketMock).toHaveBeenCalledWith(
      "ws://127.0.0.1/devtools/browser/test",
      expect.any(Function),
      {
        handshakeTimeoutMs: 600,
        commandTimeoutMs: 1_000,
        handshakeRetries: 0,
      },
    );
    expect(diagnostics).toMatchObject({
      status: "available",
      acceleration: "software",
      renderer: "llvmpipe",
    });
  });

  it("deduplicates concurrent reads and caches unavailable facts for the process lifetime", async () => {
    const diagnostics: BrowserGraphicsDiagnostics = {
      status: "unavailable",
      observedAt: 456,
      reason: "SystemInfo domain unavailable",
    };
    const load = vi.fn(async () => diagnostics);
    const running = {} as RunningChrome;

    const [first, second] = await Promise.all([
      getCachedChromeGraphicsDiagnostics(running, load),
      getCachedChromeGraphicsDiagnostics(running, load),
    ]);
    const third = await getCachedChromeGraphicsDiagnostics(running, load);

    expect(first).toBe(diagnostics);
    expect(second).toBe(diagnostics);
    expect(third).toBe(diagnostics);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
