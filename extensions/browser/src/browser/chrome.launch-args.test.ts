import { describe, expect, it } from "vitest";
import { buildOpenClawChromeLaunchArgs } from "./chrome.js";

describe("browser chrome launch args", () => {
  it("does not force an about:blank tab at startup", () => {
    const args = buildOpenClawChromeLaunchArgs({
      resolved: {
        enabled: true,
        controlPort: 18791,
        cdpProtocol: "http",
        cdpHost: "127.0.0.1",
        cdpIsLoopback: true,
        cdpPortRangeStart: 18800,
        cdpPortRangeEnd: 18810,
        evaluateEnabled: false,
        remoteCdpTimeoutMs: 1500,
        remoteCdpHandshakeTimeoutMs: 3000,
        extraArgs: [],
        color: "#FF4500",
        headless: false,
        noSandbox: false,
        attachOnly: false,
        ssrfPolicy: { allowPrivateNetwork: true },
        defaultProfile: "openclaw",
        profiles: {
          openclaw: { cdpPort: 18800, color: "#FF4500" },
        },
      },
      profile: {
        name: "openclaw",
        cdpUrl: "http://127.0.0.1:18800",
        cdpPort: 18800,
        cdpHost: "127.0.0.1",
        cdpIsLoopback: true,
        color: "#FF4500",
        driver: "openclaw",
        attachOnly: false,
      },
      userDataDir: "/tmp/openclaw-test-user-data",
    });

    expect(args).not.toContain("about:blank");
    expect(args).toContain("--remote-debugging-port=18800");
    expect(args).toContain("--user-data-dir=/tmp/openclaw-test-user-data");
  });
});
