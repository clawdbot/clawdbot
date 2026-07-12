import fs from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const profileMocks = vi.hoisted(() => ({
  buildCellRunArgs: vi.fn((_profile: unknown, options: { environmentFile: string }) => [
    "run",
    "--env-file",
    options.environmentFile,
    "cell-image",
  ]),
  buildCellCreateArgs: vi.fn((_profile: unknown, options: { environmentFile: string }) => [
    "create",
    "--env-file",
    options.environmentFile,
    "cell-image",
  ]),
  validateFleetImage: vi.fn((image: string) => image),
}));

vi.mock("./cell-profile.js", () => profileMocks);

import {
  __test as containersTestApi,
  createFleetContainerRuntime,
  type CellContainerProfile,
  type FleetContainerCommandExecutor,
  type FleetContainerStreamExecutor,
} from "./containers.runtime.js";

function successfulExecutor() {
  return vi.fn<FleetContainerCommandExecutor>(async () => ({
    stdout: "",
    stderr: "",
    code: 0,
  }));
}

describe("fleet container runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts only local Docker endpoints", async () => {
    const localExecutor = vi.fn<FleetContainerCommandExecutor>(async () => ({
      stdout: JSON.stringify([
        { Endpoints: { docker: { Host: "unix:///run/user/1000/docker.sock" } } },
      ]),
      stderr: "",
      code: 0,
    }));
    await expect(
      createFleetContainerRuntime(localExecutor).assertLocal("docker"),
    ).resolves.toBeUndefined();
    expect(localExecutor).toHaveBeenCalledWith("docker", ["context", "inspect"], {});

    const remoteExecutor = vi.fn<FleetContainerCommandExecutor>(async () => ({
      stdout: JSON.stringify([
        { Endpoints: { docker: { Host: "tcp://remote.example.invalid:2376" } } },
      ]),
      stderr: "",
      code: 0,
    }));

    await expect(createFleetContainerRuntime(remoteExecutor).assertLocal("docker")).rejects.toThrow(
      /local Docker endpoint.*remote cells/iu,
    );
    expect(remoteExecutor).toHaveBeenCalledWith("docker", ["context", "inspect"], {});
  });

  it.each([
    [false, true],
    [true, false],
  ] as const)("classifies Podman serviceIsRemote=%s", async (serviceIsRemote, accepted) => {
    const executor = vi.fn<FleetContainerCommandExecutor>(async () => ({
      stdout: JSON.stringify({ host: { serviceIsRemote } }),
      stderr: "",
      code: 0,
    }));
    const check = createFleetContainerRuntime(executor).assertLocal("podman");

    if (accepted) {
      await expect(check).resolves.toBeUndefined();
    } else {
      await expect(check).rejects.toThrow(/local Podman.*remote cells/iu);
    }
    expect(executor).toHaveBeenCalledWith("podman", ["info", "--format", "json"], {});
  });

  it("fails closed on malformed runtime-locality output", async () => {
    const executor = vi.fn<FleetContainerCommandExecutor>(async () => ({
      stdout: "{}",
      stderr: "",
      code: 0,
    }));

    await expect(createFleetContainerRuntime(executor).assertLocal("docker")).rejects.toThrow(
      /invalid response/iu,
    );
    await expect(createFleetContainerRuntime(executor).assertLocal("podman")).rejects.toThrow(
      /invalid response/iu,
    );
  });

  it("uses run or create args according to the requested start mode", async () => {
    const environmentFiles: string[] = [];
    const executor = vi.fn<FleetContainerCommandExecutor>(async (_runtime, args) => {
      const environmentFile = args[args.indexOf("--env-file") + 1];
      if (!environmentFile) {
        throw new Error("missing environment file");
      }
      environmentFiles.push(environmentFile);
      await expect(fs.readFile(environmentFile, "utf8")).resolves.toBe(
        "OPENCLAW_GATEWAY_TOKEN=fake-value\n",
      );
      return { stdout: "", stderr: "", code: 0 };
    });
    const runtime = createFleetContainerRuntime(executor);
    const profile = {
      runtime: "podman",
      environment: { OPENCLAW_GATEWAY_TOKEN: "fake-value" },
    } as unknown as CellContainerProfile;

    await runtime.run(profile, true);
    await runtime.run(profile, false);

    expect(profileMocks.buildCellRunArgs).toHaveBeenCalledWith(profile, {
      environmentFile: environmentFiles[0],
    });
    expect(profileMocks.buildCellCreateArgs).toHaveBeenCalledWith(profile, {
      environmentFile: environmentFiles[1],
    });
    expect(executor).toHaveBeenNthCalledWith(
      1,
      "podman",
      ["run", "--env-file", environmentFiles[0], "cell-image"],
      { redactValues: ["fake-value"] },
    );
    expect(executor).toHaveBeenNthCalledWith(
      2,
      "podman",
      ["create", "--env-file", environmentFiles[1], "cell-image"],
      {
        redactValues: ["fake-value"],
      },
    );
    await Promise.all(
      environmentFiles.map(async (environmentFile) => {
        await expect(fs.stat(environmentFile)).rejects.toMatchObject({ code: "ENOENT" });
      }),
    );
  });

  it("normalizes Docker and Podman inspect output", async () => {
    const executor = vi.fn<FleetContainerCommandExecutor>(async () => ({
      stdout: JSON.stringify([
        {
          Image: "sha256:old-image-id",
          State: { Status: "running", Running: true },
          Config: {
            Env: ["OPENCLAW_GATEWAY_TOKEN=secret", "FEATURE=a=b"],
            Image: "ghcr.io/openclaw/openclaw:latest",
            Labels: { "openclaw.fleet.tenant": "acme" },
            User: "1000:1000",
          },
          HostConfig: {
            Memory: 2_147_483_648,
            NanoCpus: 2_000_000_000,
            PidsLimit: 512,
            UsernsMode: "keep-id",
          },
        },
      ]),
      stderr: "",
      code: 0,
    }));

    await expect(
      createFleetContainerRuntime(executor).inspect("podman", "cell-acme"),
    ).resolves.toEqual({
      kind: "ok",
      state: "running",
      running: true,
      labels: { "openclaw.fleet.tenant": "acme" },
      environment: { OPENCLAW_GATEWAY_TOKEN: "secret", FEATURE: "a=b" },
      imageId: "sha256:old-image-id",
      memory: "2147483648",
      cpus: "2",
      pidsLimit: 512,
      storageOpt: {},
      capDrop: [],
      securityOpt: [],
      init: undefined,
      restartPolicy: undefined,
      portBindings: [],
      user: "1000:1000",
      usernsMode: "keep-id",
    });
    expect(executor).toHaveBeenCalledWith("podman", ["container", "inspect", "cell-acme"], {
      allowFailure: true,
    });
  });

  it("detects a rootless Docker daemon from security options", async () => {
    const executor = vi.fn<FleetContainerCommandExecutor>(async () => ({
      stdout: JSON.stringify(["name=seccomp,profile=builtin", "name=rootless"]),
      stderr: "",
      code: 0,
    }));

    await expect(createFleetContainerRuntime(executor).isDockerRootless()).resolves.toBe(true);
    expect(executor).toHaveBeenCalledWith(
      "docker",
      ["info", "--format", "{{json .SecurityOptions}}"],
      {},
    );
  });

  it("distinguishes missing containers from unavailable runtimes", async () => {
    const missingExecutor = vi.fn<FleetContainerCommandExecutor>(async () => ({
      stdout: "",
      stderr: "Error: no such container: cell-missing",
      code: 1,
    }));
    const unavailableExecutor = vi.fn<FleetContainerCommandExecutor>(async () => ({
      stdout: "",
      stderr: "Cannot connect to the Docker daemon",
      code: 1,
    }));

    await expect(
      createFleetContainerRuntime(missingExecutor).inspect("docker", "cell-missing"),
    ).resolves.toEqual({ kind: "missing", state: "missing" });
    await expect(
      createFleetContainerRuntime(unavailableExecutor).inspect("docker", "cell-acme"),
    ).resolves.toEqual({
      kind: "unavailable",
      state: "unknown",
      error: "Cannot connect to the Docker daemon",
    });
  });

  it.each([
    ["docker", "Labels", "Containers", "Name"],
    ["podman", "labels", "containers", "name"],
  ] as const)(
    "normalizes %s network labels and attached containers",
    async (runtimeName, labelsField, containersField, nameField) => {
      const executor = vi.fn<FleetContainerCommandExecutor>(async () => ({
        stdout: JSON.stringify([
          {
            [labelsField]: {
              "openclaw.fleet.tenant": "acme",
              "openclaw.fleet.owner": "owner-id",
            },
            [containersField]: {
              "container-b": { [nameField]: "peer-b" },
              "container-a": { [nameField]: "peer-a" },
            },
          },
        ]),
        stderr: "",
        code: 0,
      }));

      await expect(
        createFleetContainerRuntime(executor).inspectNetwork(runtimeName, "openclaw-cell-acme-net"),
      ).resolves.toEqual({
        kind: "ok",
        labels: {
          "openclaw.fleet.tenant": "acme",
          "openclaw.fleet.owner": "owner-id",
        },
        attachedContainers: [
          { id: "container-a", name: "peer-a" },
          { id: "container-b", name: "peer-b" },
        ],
        internal: false,
      });
      expect(executor).toHaveBeenCalledWith(
        runtimeName,
        ["network", "inspect", "openclaw-cell-acme-net"],
        { allowFailure: true },
      );
    },
  );

  it("normalizes a network with no attached containers", async () => {
    const executor = vi.fn<FleetContainerCommandExecutor>(async () => ({
      stdout: JSON.stringify([{ Labels: {}, Containers: {} }]),
      stderr: "",
      code: 0,
    }));

    await expect(
      createFleetContainerRuntime(executor).inspectNetwork("docker", "openclaw-cell-acme-net"),
    ).resolves.toEqual({ kind: "ok", labels: {}, attachedContainers: [], internal: false });
  });

  it("distinguishes missing networks from unavailable runtimes", async () => {
    const missingExecutor = vi.fn<FleetContainerCommandExecutor>(async () => ({
      stdout: "",
      stderr: "Error: network openclaw-cell-missing-net not found",
      code: 1,
    }));
    const unavailableExecutor = vi.fn<FleetContainerCommandExecutor>(async () => ({
      stdout: "",
      stderr: "Cannot connect to the Docker daemon",
      code: 1,
    }));

    await expect(
      createFleetContainerRuntime(missingExecutor).inspectNetwork(
        "docker",
        "openclaw-cell-missing-net",
      ),
    ).resolves.toEqual({ kind: "missing" });
    await expect(
      createFleetContainerRuntime(unavailableExecutor).inspectNetwork(
        "docker",
        "openclaw-cell-acme-net",
      ),
    ).resolves.toEqual({
      kind: "unavailable",
      error: "Cannot connect to the Docker daemon",
    });
  });

  it("treats malformed network inspect JSON as unavailable", async () => {
    const executor = vi.fn<FleetContainerCommandExecutor>(async () => ({
      stdout: JSON.stringify([{ Labels: { "openclaw.fleet.tenant": 42 } }]),
      stderr: "",
      code: 0,
    }));

    await expect(
      createFleetContainerRuntime(executor).inspectNetwork("docker", "openclaw-cell-acme-net"),
    ).resolves.toEqual({
      kind: "unavailable",
      error: "network inspect returned an invalid response",
    });
  });

  it("treats malformed inspect JSON as unavailable without echoing its output", async () => {
    const executor = vi.fn<FleetContainerCommandExecutor>(async () => ({
      stdout: 'not-json OPENCLAW_GATEWAY_TOKEN="secret"',
      stderr: "",
      code: 0,
    }));

    const result = await createFleetContainerRuntime(executor).inspect("docker", "cell-acme");

    expect(result).toEqual({
      kind: "unavailable",
      state: "unknown",
      error: "container inspect returned an invalid response",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("redacts environment values from command failures", async () => {
    const executor = vi.fn<FleetContainerCommandExecutor>(async () => {
      throw new Error("runtime rejected fake-value");
    });
    const runtime = createFleetContainerRuntime(executor);
    const profile = {
      runtime: "docker",
      environment: { OPENCLAW_GATEWAY_TOKEN: "fake-value" },
    } as unknown as CellContainerProfile;

    let failure: unknown;
    try {
      await runtime.run(profile, true);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("<redacted>");
    expect((failure as Error).message).not.toContain("fake-value");
  });

  it("executes lifecycle commands with the selected runtime", async () => {
    const executor = successfulExecutor();
    const runtime = createFleetContainerRuntime(executor);

    await runtime.pull("docker", "image:v2");
    await runtime.start("docker", "cell-acme");
    await runtime.stop("docker", "cell-acme");
    await runtime.restart("docker", "cell-acme");
    await runtime.remove("docker", "cell-acme", true);
    await runtime.remove("docker", "cell-acme", false);

    expect(executor.mock.calls.map(([, args]) => args)).toEqual([
      ["pull", "image:v2"],
      ["start", "cell-acme"],
      ["stop", "cell-acme"],
      ["restart", "cell-acme"],
      ["rm", "--force", "cell-acme"],
      ["rm", "cell-acme"],
    ]);
  });

  it.each([
    [{}, ["logs", "cell-acme"]],
    [{ follow: true }, ["logs", "--follow", "cell-acme"]],
    [{ tail: 200 }, ["logs", "--tail", "200", "cell-acme"]],
    [{ since: "10m" }, ["logs", "--since", "10m", "cell-acme"]],
    [
      { follow: true, tail: 100, since: "2026-07-11T10:00:00Z" },
      ["logs", "--follow", "--tail", "100", "--since", "2026-07-11T10:00:00Z", "cell-acme"],
    ],
  ] as const)("streams logs with exact argv for %o", async (options, expectedArgs) => {
    const stream = vi.fn<FleetContainerStreamExecutor>(async () => ({ code: 0, signal: null }));
    const runtime = createFleetContainerRuntime(successfulExecutor(), stream);

    await expect(
      runtime.logs("podman", "cell-acme", { ...options, redactValues: ["secret"] }),
    ).resolves.toBeUndefined();

    expect(stream).toHaveBeenCalledWith("podman", expectedArgs, { redactValues: ["secret"] });
  });

  it.each(["", "-1h", "10 m", "10m\n"])("rejects unsafe --since value %o", async (since) => {
    const stream = vi.fn<FleetContainerStreamExecutor>(async () => ({ code: 0, signal: null }));
    const runtime = createFleetContainerRuntime(successfulExecutor(), stream);

    await expect(runtime.logs("docker", "cell-acme", { since, redactValues: [] })).rejects.toThrow(
      /--since/iu,
    );
    expect(stream).not.toHaveBeenCalled();
  });

  it("reports stream failures but accepts operator interrupt while following", async () => {
    const stream = vi.fn<FleetContainerStreamExecutor>();
    const runtime = createFleetContainerRuntime(successfulExecutor(), stream);
    stream
      .mockResolvedValueOnce({ code: 7, signal: null })
      .mockResolvedValueOnce({ code: 130, signal: null })
      .mockResolvedValueOnce({ code: 130, signal: null })
      .mockResolvedValueOnce({ code: null, signal: "SIGTERM" })
      .mockResolvedValueOnce({ code: null, signal: "SIGTERM" });

    await expect(runtime.logs("podman", "cell-acme", { redactValues: [] })).rejects.toThrow(
      /podman logs failed with exit code 7/iu,
    );
    await expect(
      runtime.logs("podman", "cell-acme", { follow: true, redactValues: [] }),
    ).resolves.toBeUndefined();
    await expect(runtime.logs("podman", "cell-acme", { redactValues: [] })).rejects.toThrow(
      /podman logs failed with exit code 130/iu,
    );
    // A forwarded termination signal ends a follow stream cleanly but fails a bounded read.
    await expect(
      runtime.logs("podman", "cell-acme", { follow: true, redactValues: [] }),
    ).resolves.toBeUndefined();
    await expect(runtime.logs("podman", "cell-acme", { redactValues: [] })).rejects.toThrow(
      /podman logs failed with signal SIGTERM/iu,
    );
    // Crash signals are never masked as operator stops, even while following.
    stream.mockResolvedValueOnce({ code: null, signal: "SIGSEGV" });
    await expect(
      runtime.logs("podman", "cell-acme", { follow: true, redactValues: [] }),
    ).rejects.toThrow(/podman logs failed with signal SIGSEGV/iu);
  });

  it("creates and removes a labeled per-cell network", async () => {
    const executor = successfulExecutor();
    const runtime = createFleetContainerRuntime(executor);

    await runtime.createNetwork(
      "podman",
      "openclaw-cell-acme-net",
      {
        "openclaw.fleet.tenant": "acme",
        "openclaw.fleet.attempt": "attempt-id",
        "openclaw.fleet.owner": "owner-id",
      },
      { internal: false },
    );
    await runtime.removeNetwork("podman", "openclaw-cell-acme-net");

    expect(executor.mock.calls.map(([, args]) => args)).toEqual([
      [
        "network",
        "create",
        "--driver",
        "bridge",
        "--label",
        "openclaw.fleet.attempt=attempt-id",
        "--label",
        "openclaw.fleet.owner=owner-id",
        "--label",
        "openclaw.fleet.tenant=acme",
        "openclaw-cell-acme-net",
      ],
      ["network", "rm", "openclaw-cell-acme-net"],
    ]);
  });

  it.each([
    [true, true],
    [false, false],
  ] as const)("sets internal=%s on network create", async (internal, expected) => {
    const executor = successfulExecutor();
    const runtime = createFleetContainerRuntime(executor);
    await runtime.createNetwork("podman", "openclaw-cell-acme-net", {}, { internal });
    expect(executor.mock.calls[0]?.[1].includes("--internal")).toBe(expected);
  });

  it("redacts secrets from streamed log output, including across chunk boundaries", () => {
    const written: string[] = [];
    const target = { write: (text: string) => written.push(text) } as unknown as NodeJS.WriteStream;
    const writer = containersTestApi.createRedactingStreamWriter(target, ["gw-secret-token"]);
    writer.write(Buffer.from("boot ok\ntoken=gw-sec"));
    writer.write(Buffer.from("ret-token done\ntail without newline"));
    writer.flush();
    const output = written.join("");
    expect(output).toContain("token=<redacted> done");
    expect(output).toContain("tail without newline");
    expect(output).not.toContain("gw-secret-token");
  });

  it("never splits a secret across a forced long-line flush", () => {
    const written: string[] = [];
    const target = { write: (text: string) => written.push(text) } as unknown as NodeJS.WriteStream;
    const writer = containersTestApi.createRedactingStreamWriter(target, ["gw-secret-token"]);
    // An unterminated line ending exactly in a secret prefix at the flush point.
    writer.write(Buffer.from(`${"x".repeat(64 * 1024)}gw-sec`));
    writer.write(Buffer.from("ret-token trailing"));
    writer.flush();
    const output = written.join("");
    expect(output).toContain("<redacted> trailing");
    expect(output).not.toContain("gw-secret-token");
  });

  it("parses hardened inspect fields and Docker network internal state", async () => {
    const executor = vi.fn<FleetContainerCommandExecutor>(async (_runtime, args) =>
      args[0] === "network"
        ? {
            stdout: JSON.stringify([{ Labels: {}, Containers: {}, Internal: true }]),
            stderr: "",
            code: 0,
          }
        : {
            stdout: JSON.stringify([
              {
                Image: "sha256:image",
                State: { Status: "running", Running: true },
                Config: { Env: [], Labels: {} },
                // Podman reports null EffectiveCaps when every capability is dropped.
                EffectiveCaps: null,
                HostConfig: {
                  Memory: 1,
                  NanoCpus: 1_000_000_000,
                  PidsLimit: 1,
                  StorageOpt: { size: "10g" },
                  CapDrop: ["ALL"],
                  SecurityOpt: ["no-new-privileges"],
                  Init: true,
                  RestartPolicy: { Name: "unless-stopped" },
                  PortBindings: { "18789/tcp": [{ HostIp: "127.0.0.1", HostPort: "19100" }] },
                },
              },
            ]),
            stderr: "",
            code: 0,
          },
    );
    const runtime = createFleetContainerRuntime(executor);
    await expect(runtime.inspect("docker", "cell-acme")).resolves.toMatchObject({
      storageOpt: { size: "10g" },
      capDrop: ["ALL"],
      effectiveCaps: [],
      securityOpt: ["no-new-privileges"],
      init: true,
      restartPolicy: "unless-stopped",
      portBindings: [{ containerPort: "18789/tcp", hostIp: "127.0.0.1", hostPort: "19100" }],
    });
    await expect(runtime.inspectNetwork("docker", "net-acme")).resolves.toMatchObject({
      internal: true,
    });
  });

  it("fails closed on invalid hardened inspect field shapes", async () => {
    const executor = vi.fn<FleetContainerCommandExecutor>(async () => ({
      stdout: JSON.stringify([
        {
          Image: "sha256:image",
          State: { Status: "running", Running: true },
          Config: { Env: [], Labels: {} },
          HostConfig: { Memory: 1, NanoCpus: 1, PidsLimit: 1, StorageOpt: { size: 10 } },
        },
      ]),
      stderr: "",
      code: 0,
    }));
    await expect(
      createFleetContainerRuntime(executor).inspect("docker", "cell-acme"),
    ).resolves.toEqual({
      kind: "unavailable",
      state: "unknown",
      error: "container inspect returned an invalid response",
    });
  });
});
