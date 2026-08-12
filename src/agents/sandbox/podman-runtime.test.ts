// Podman runtime probe tests cover remote connection classification,
// including malformed connection URIs reported by `podman system connection list`.
import { beforeEach, describe, expect, it, vi } from "vitest";

const podmanMocks = vi.hoisted(() => ({
  execContainer: vi.fn(),
}));

vi.mock("./container-engine.js", async () => {
  const actual =
    await vi.importActual<typeof import("./container-engine.js")>("./container-engine.js");
  return {
    ...actual,
    execContainer: podmanMocks.execContainer,
  };
});

const { resolvePodmanSandboxRuntimeInfo } = await import("./podman-runtime.js");

function mockRemotePodmanProbe(connectionUri: string, remoteUsername = "user") {
  podmanMocks.execContainer.mockImplementation(async (_engine: unknown, args: string[]) => {
    if (args[0] === "info") {
      return { code: 0, stdout: "true\ttrue\t\t5.2.0", stderr: "" };
    }
    if (args[0] === "system") {
      return {
        code: 0,
        stdout: JSON.stringify([
          {
            Name: "podman-machine-default",
            URI: connectionUri,
            Default: true,
            Identity: "",
          },
        ]),
        stderr: "",
      };
    }
    if (args[0] === "machine") {
      return {
        code: 0,
        stdout: JSON.stringify([
          {
            Name: "podman-machine-default",
            Running: true,
            Port: 50321,
            RemoteUsername: remoteUsername,
            IdentityPath: "",
          },
        ]),
        stderr: "",
      };
    }
    return { code: 1, stdout: "", stderr: `unexpected podman args: ${args.join(" ")}` };
  });
}

describe("resolvePodmanSandboxRuntimeInfo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CONTAINER_HOST;
    delete process.env.CONTAINER_CONNECTION;
    delete process.env.CONTAINER_SSHKEY;
  });

  it("matches a Podman Machine connection with a percent-encoded username", async () => {
    mockRemotePodmanProbe(
      "ssh://user%40corp@127.0.0.1:50321/run/user/1000/podman/podman.sock",
      "user@corp",
    );

    await expect(resolvePodmanSandboxRuntimeInfo()).resolves.toMatchObject({
      machine: true,
      rootless: true,
      version: "5.2.0",
    });
  });

  it("rejects a malformed connection username with the descriptive unsupported-connection error", async () => {
    // WHATWG URL keeps a bare % in userinfo, so the probe sees "user%name".
    mockRemotePodmanProbe("ssh://user%name@127.0.0.1:50321/run/user/1000/podman/podman.sock");

    await expect(resolvePodmanSandboxRuntimeInfo()).rejects.toMatchObject({
      code: "INVALID_CONFIG",
      message: expect.stringContaining(
        "Podman sandboxing supports a local Podman engine or Podman Machine",
      ),
    });
  });
});
