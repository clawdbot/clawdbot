import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  approveAndInvoke,
  buildObservedNodeOperation,
  captureExpectedIdentity,
  consumeOneTimeObserverCredential,
  formatCliFailureDiagnostic,
  isChildTerminal,
  normalizeMismatch,
  prepareRuntimeHome,
  resolveApprovedNodeOperation,
  stopChild,
  validateDisjointObserverConnect,
  validateObserverConnectCredential,
  validateObservedIdentity,
} from "../../scripts/gateway-node-compat-case.ts";
import {
  buildCaseContainerArgs,
  buildCases,
  buildGatewayNodeCompatProtocolEvidence,
  isSameRunArtifact,
  mergeActionsWorkflowJobPages,
  parseCaseResult,
  parseRuntimeProtocolContract,
  resolveGatewayNodeCompatProducerJobName,
  sha256RuntimeTree,
  validateCaseProtocolContract,
  writeGatewayNodeCompatFailureDiagnostic,
  writeGatewayNodeCompatRawResultDiagnostic,
} from "../../scripts/lib/cross-os-release-checks/gateway-node-compat.ts";
import { runManagedContainer } from "../../scripts/lib/cross-os-release-checks/managed-container.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const validObservation = {
  clientMin: 1,
  clientMax: 2,
  helloProtocol: null,
  identity: {
    clientId: "node-host",
    mode: "node",
    platform: "linux",
    role: "node",
  },
  protocolError: null,
};
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Gateway/node Linux compatibility producer", () => {
  it.each(["x64", "arm64"] as const)("defines all six %s contracts", (architecture) => {
    const cases = buildCases(architecture);
    expect(cases).toHaveLength(6);
    expect(new Set(cases.map((entry) => entry.caseId)).size).toBe(6);
    expect(cases.map((entry) => [entry.direction, entry.outcome])).toEqual([
      ["candidate-gateway-candidate-node", "passed"],
      ["candidate-gateway-baseline-node", "passed"],
      ["baseline-gateway-candidate-node", "passed"],
      ["baseline-gateway-baseline-node", "passed"],
      ["candidate-gateway-disjoint-node", "protocol-mismatch"],
      ["baseline-gateway-disjoint-node", "protocol-mismatch"],
    ]);
    expect(cases.every((entry) => entry.caseId.startsWith(`linux-${architecture}-`))).toBe(true);
  });

  it("accepts artifacts from this run at or before the consumer attempt", () => {
    const producer = { runId: "123", runAttempt: 2 };
    expect(isSameRunArtifact({ runId: "123", runAttempt: 2 }, producer)).toBe(true);
    expect(isSameRunArtifact({ runId: "123", runAttempt: 1 }, producer)).toBe(true);
    expect(isSameRunArtifact({ runId: "122", runAttempt: 2 }, producer)).toBe(false);
    expect(isSameRunArtifact({ runId: "123", runAttempt: 3 }, producer)).toBe(false);
  });

  it("derives the artifact producer name without caller-owned literals", () => {
    const producerSteps = [
      {
        name: "Upload candidate artifact",
        status: "completed",
        conclusion: "success",
      },
      {
        name: "Upload Gateway compatibility baseline",
        status: "completed",
        conclusion: "success",
      },
    ];
    for (const name of [
      "prepare",
      "cross_os_release_checks / prepare",
      "release / cross_os_release_checks / prepare",
    ]) {
      expect(
        resolveGatewayNodeCompatProducerJobName({
          total_count: 2,
          jobs: [
            { id: 1, name: "unrelated / prepare", steps: [] },
            { id: 2, name, steps: producerSteps },
          ],
        }),
      ).toBe(name);
    }
    expect(() =>
      resolveGatewayNodeCompatProducerJobName({
        total_count: 2,
        jobs: [
          { id: 1, name: "prepare", steps: producerSteps },
          { id: 2, name: "other / prepare", steps: producerSteps },
        ],
      }),
    ).toThrow(/one unique compatibility artifact producer/u);
    expect(() =>
      resolveGatewayNodeCompatProducerJobName({
        total_count: 1,
        jobs: [{ id: 1, name: "cross_os_release_checks / prepare", steps: [] }],
      }),
    ).toThrow(/one unique compatibility artifact producer/u);
  });

  it("writes one atomic bounded producer failure diagnostic", () => {
    const root = tempDirs.make("gateway-node-producer-failure-");
    try {
      writeGatewayNodeCompatFailureDiagnostic(
        root,
        new Error(`canonicalization failed ${"x".repeat(1_000)}`),
        new Date("2026-08-08T12:00:00.000Z"),
      );
      const diagnosticsDir = join(root, "diagnostics");
      expect(readdirSync(diagnosticsDir)).toEqual(["producer-failure.json"]);
      expect(
        JSON.parse(readFileSync(join(diagnosticsDir, "producer-failure.json"), "utf8")),
      ).toEqual({
        schema: "openclaw.gateway-node-compat-producer-failure/v1",
        status: "failed",
        completedAt: "2026-08-08T12:00:00.000Z",
        error: {
          name: "Error",
          message: expect.stringMatching(/^canonicalization failed x+\.\.\.$/u),
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves bounded raw case output before validation", () => {
    const root = tempDirs.make("gateway-node-raw-result-");
    const result = Buffer.from('{"observation":{"helloProtocol":99}}\n');
    writeGatewayNodeCompatRawResultDiagnostic(root, "linux-x64-candidate-node", result);

    expect(readFileSync(join(root, "diagnostics", "raw", "linux-x64-candidate-node.json"))).toEqual(
      result,
    );
  });

  it("derives gateway and node protocol contracts from installed runtime metadata", () => {
    expect(parseRuntimeProtocolContract("const PROTOCOL_VERSION = 3;\n")).toEqual({
      gatewayProtocol: 3,
      nodeMinProtocol: 3,
      nodeMaxProtocol: 3,
    });
    expect(
      parseRuntimeProtocolContract(
        [
          "const PROTOCOL_VERSION = 4;",
          "const MIN_NODE_PROTOCOL_VERSION = 3;",
          "export { PROTOCOL_VERSION, MIN_NODE_PROTOCOL_VERSION };",
        ].join("\n"),
      ),
    ).toEqual({
      gatewayProtocol: 4,
      nodeMinProtocol: 3,
      nodeMaxProtocol: 4,
    });
    expect(parseRuntimeProtocolContract("const OTHER_VERSION = 4;\n")).toBeNull();
  });

  it.each([
    { gatewayProtocol: 5, nodeMinProtocol: 4, nodeMaxProtocol: 5 },
    { gatewayProtocol: 5, nodeMinProtocol: 5, nodeMaxProtocol: 5 },
  ])("records the parsed Gateway node floor for $nodeMinProtocol..5", (gatewayRuntime) => {
    expect(
      buildGatewayNodeCompatProtocolEvidence({
        caseId: "linux-x64-candidate-gateway-candidate-node",
        gatewayProtocolVersion: 5,
        gatewayRuntime,
        observation: {
          clientMin: gatewayRuntime.nodeMinProtocol,
          clientMax: 5,
          helloProtocol: 5,
        },
        passed: true,
      }),
    ).toEqual({
      gatewayProtocolVersion: 5,
      gatewayAcceptedNodeMin: gatewayRuntime.nodeMinProtocol,
      protocolClientAdvertisedMin: gatewayRuntime.nodeMinProtocol,
      protocolClientAdvertisedMax: 5,
      helloProtocol: 5,
    });
  });

  it("builds an unprivileged isolated case container with read-only runtimes", () => {
    const args = buildCaseContainerArgs({
      architecture: "arm64",
      caseDir: "/tmp/case",
      inputPath: "/tmp/case/input.json",
      preparedDir: "/tmp/prepared",
    });
    expect(args).toContain("none");
    expect(args).toContain("--read-only");
    expect(args).toContain("--cpus");
    expect(args).toContain("--memory");
    expect(args).toContain("--pids-limit");
    expect(args).toContain("ALL");
    expect(args.filter((entry) => entry === "--cap-add")).toHaveLength(5);
    expect(args).toContain("SETUID");
    expect(args).toContain("SETGID");
    expect(args).toContain("DAC_OVERRIDE");
    expect(args).toContain("CHOWN");
    expect(args).toContain("KILL");
    expect(args).toContain("no-new-privileges:true");
    expect(args).toContain("type=bind,src=/tmp/prepared,dst=/runtimes,readonly");
    expect(args.some((entry) => entry.endsWith("dst=/node_modules/ws,readonly"))).toBe(true);
    expect(args).toContain("0:0");
    expect(args).toContain("OPENCLAW_GATEWAY_NODE_ARCH=arm64");
    expect(args.join(" ")).not.toMatch(/TOKEN|SECRET|KEY/u);
  });

  it("prepares host-cleanable runtimes without root-owned bind-mount files", () => {
    const source = readFileSync(
      "scripts/lib/cross-os-release-checks/gateway-node-compat.ts",
      "utf8",
    );
    expect(source).toContain("process.getuid?.()");
    expect(source).toContain("require an unprivileged runner");
    expect(source).toContain("npm_config_cache=/tmp/npm-cache");
  });

  it("separates package-controlled processes from the trusted observer output owner", () => {
    const source = readFileSync("scripts/gateway-node-compat-case.ts", "utf8");
    expect(source).toContain("const GATEWAY_UID = 65532");
    expect(source).toContain("const NODE_UID = 65533");
    expect(source).toContain("uid: GATEWAY_UID");
    expect(source).toContain("const runtimeRoot = createRuntimeRoot()");
    expect(source).toContain('name: "node"');
    expect(source).toContain("lstatSync(home, { throwIfNoEntry: false })");
    expect(source).toMatch(/children,\s+NODE_UID,\s+NODE_GID/u);
    expect(source).toContain("chown(home, params.uid, params.gid)");
    expect(source).toContain("CLI_OUTPUT_LIMIT_BYTES");
    expect(source.match(/mode: 0o644/g)).toHaveLength(2);
    expect(source).not.toContain("const home = `/tmp/${name}`");
    expect(source).not.toContain('requireFromRuntime("ws")');
    expect(source.indexOf("const bootstrapNode = startNode()")).toBeLessThan(
      source.indexOf("const gatewayChild = start("),
    );
  });

  it("rejects a malicious node-home symlink before chowning its target", () => {
    const dir = mkdtempSync(join(tmpdir(), "gateway-node-home-"));
    const root = join(dir, "runtime");
    const target = join(dir, "out");
    mkdirSync(root, { mode: 0o711 });
    chmodSync(root, 0o711);
    mkdirSync(target);
    writeFileSync(join(target, "owned.txt"), "unchanged\n");
    symlinkSync(target, join(root, "node"), "dir");
    const targetBefore = statSync(target);
    let chownCalled = false;
    try {
      expect(() =>
        prepareRuntimeHome(
          {
            root,
            name: "node",
            uid: 65533,
            gid: 65533,
            rootUid: process.getuid?.() ?? targetBefore.uid,
            rootGid: process.getgid?.() ?? targetBefore.gid,
          },
          () => {
            chownCalled = true;
          },
        ),
      ).toThrow(/Refusing existing runtime home node/u);
      expect(chownCalled).toBe(false);
      expect(lstatSync(join(root, "node")).isSymbolicLink()).toBe(true);
      expect(statSync(target)).toMatchObject({
        uid: targetBefore.uid,
        gid: targetBefore.gid,
      });
      expect(readFileSync(join(target, "owned.txt"), "utf8")).toBe("unchanged\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("binds each observed node session to the bootstrapped device's one-time signature", () => {
    const gatewayToken = "gateway-token";
    const nonce = "observer-nonce";
    const signedAt = 1234;
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicKeyRaw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const deviceId = "expected-device";
    const payload = [
      "v3",
      deviceId,
      "node-host",
      "node",
      "node",
      "",
      String(signedAt),
      gatewayToken,
      nonce,
      "linux",
      "",
    ].join("|");
    const signature = sign(null, Buffer.from(payload), privateKey).toString("base64url");
    const connect = {
      id: "connect-1",
      method: "connect",
      params: {
        auth: { token: gatewayToken },
        client: { id: "node-host", mode: "node", platform: "linux" },
        device: {
          id: deviceId,
          nonce,
          publicKey: publicKeyRaw.toString("base64url"),
          signature,
          signedAt,
        },
        maxProtocol: 4,
        minProtocol: 3,
        role: "node",
        scopes: [],
      },
    };
    const usedSignatures = new Set<string>();
    const captured = validateObserverConnectCredential(connect, {
      gatewayToken,
      nonce,
      usedSignatures,
    });
    expect(captured.device).toEqual({
      id: deviceId,
      publicKey: publicKeyRaw.toString("base64url"),
    });
    expect(() =>
      validateObserverConnectCredential(connect, {
        expectedDevice: captured.device,
        gatewayToken,
        nonce,
        usedSignatures,
      }),
    ).toThrow(/reused/u);
    expect(() =>
      validateObserverConnectCredential(
        {
          ...connect,
          params: {
            ...connect.params,
            device: { ...connect.params.device, id: "forged-device" },
          },
        },
        {
          expectedDevice: captured.device,
          gatewayToken,
          nonce,
          usedSignatures: new Set(),
        },
      ),
    ).toThrow(/unexpected device identity/u);
  });

  it("authorizes exactly one supervisor-created disjoint protocol probe", () => {
    const credential = "one-time-observer-credential";
    expect(consumeOneTimeObserverCredential(credential, credential)).toBeUndefined();
    expect(() => consumeOneTimeObserverCredential(credential, undefined)).toThrow(/reused/u);
    expect(() => consumeOneTimeObserverCredential("forged", credential)).toThrow(/unauthorized/u);

    const frame = {
      id: "disjoint-connect",
      method: "connect",
      params: {
        auth: { token: "gateway-token" },
        client: { id: "node-host", mode: "node", platform: "linux" },
        maxProtocol: 2,
        minProtocol: 1,
        role: "node",
      },
    };
    expect(validateDisjointObserverConnect(frame, "gateway-token")).toMatchObject({
      clientMin: 1,
      clientMax: 2,
      identity: {
        clientId: "node-host",
        mode: "node",
        platform: "linux",
        role: "node",
      },
    });
    expect(() =>
      validateDisjointObserverConnect(
        {
          ...frame,
          params: { ...frame.params, maxProtocol: 3 },
        },
        "gateway-token",
      ),
    ).toThrow(/invalid disjoint protocol probe/u);
  });

  it("accepts the pinned baseline's exact legacy 1..2 mismatch", () => {
    expect(
      normalizeMismatch(
        {
          ...validObservation,
          protocolError: { details: { expectedProtocol: 3 } },
        },
        "2026.5.7",
      ),
    ).toEqual({
      code: "PROTOCOL_MISMATCH",
      clientMinProtocol: 1,
      clientMaxProtocol: 2,
      expectedProtocol: 3,
    });
  });

  it("accepts a structured Gateway mismatch and rejects an overstated range", () => {
    const protocolError = {
      details: {
        code: "PROTOCOL_MISMATCH",
        clientMinProtocol: 1,
        clientMaxProtocol: 2,
        expectedProtocol: 4,
      },
    };
    expect(normalizeMismatch({ ...validObservation, protocolError })).toMatchObject({
      expectedProtocol: 4,
    });
    expect(() =>
      normalizeMismatch({
        ...validObservation,
        clientMin: 2,
        protocolError,
      }),
    ).toThrow(/exact protocol range 1\.\.2/u);
    expect(() =>
      normalizeMismatch({
        ...validObservation,
        protocolError: { details: { expectedProtocol: 3 } },
      }),
    ).toThrow(/structured PROTOCOL_MISMATCH/u);
    expect(() =>
      normalizeMismatch({
        ...validObservation,
        protocolError: {
          details: {
            code: "PROTOCOL_MISMATCH",
            clientMinProtocol: 1,
            clientMaxProtocol: 2,
            expectedProtocol: 2,
          },
        },
      }),
    ).toThrow(/structured PROTOCOL_MISMATCH/u);
    expect(() =>
      normalizeMismatch(
        {
          ...validObservation,
          protocolError: { details: { expectedProtocol: 4 } },
        },
        "2026.5.7",
      ),
    ).toThrow(/structured PROTOCOL_MISMATCH/u);
  });

  it("requires the observer's Linux node identity", () => {
    expect(validateObservedIdentity(validObservation)).toBe(validObservation);
    expect(() =>
      validateObservedIdentity({
        ...validObservation,
        identity: { ...validObservation.identity, role: "operator" },
      }),
    ).toThrow(/Linux node-host/u);
  });

  it("waits through delayed repeated approvals before invoking the advertised operation", async () => {
    const calls: string[][] = [];
    let deviceListCalls = 0;
    let nodeStatusCalls = 0;
    let restarts = 0;
    let stops = 0;
    const stoppedNodes: ChildProcess[] = [];
    const initialNode = { exitCode: null } as ChildProcess;
    const restartedNode = { exitCode: null } as ChildProcess;
    const cli = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "devices" && args[1] === "list") {
        deviceListCalls += 1;
        if (deviceListCalls === 1) {
          return { pending: [], paired: [] };
        }
        if (deviceListCalls <= 3) {
          return {
            pending: [
              {
                requestId: "device-request",
                deviceId: "node-device",
                displayName: "compat-case",
                role: "node",
              },
            ],
            paired: [],
          };
        }
        return {
          pending: [],
          paired: [
            {
              deviceId: "node-device",
              displayName: "compat-case",
              roles: ["node"],
            },
          ],
        };
      }
      if (args[0] === "devices" && args[1] === "approve") {
        return { requestId: args[2] };
      }
      if (args[0] === "nodes" && args[1] === "pending") {
        return [
          {
            requestId: "node-request",
            nodeId: "node-device",
            displayName: "compat-case",
          },
        ];
      }
      if (args[0] === "nodes" && args[1] === "approve") {
        return { requestId: args[2] };
      }
      if (args[0] === "nodes" && args[1] === "status") {
        nodeStatusCalls += 1;
        return {
          nodes: [
            {
              nodeId: "node-device",
              displayName: "compat-case",
              paired: true,
              connected: true,
              approvalState: "approved",
              commands: nodeStatusCalls === 1 ? [] : ["system.which"],
            },
          ],
        };
      }
      if (args[0] === "nodes" && args[1] === "invoke") {
        return {
          ok: true,
          command: "system.which",
          payload: { bins: { node: "/usr/bin/node" } },
        };
      }
      throw new Error(`Unexpected CLI args: ${args.join(" ")}`);
    };

    await expect(
      approveAndInvoke({
        caseId: "compat-case",
        cli,
        nodeChild: initialNode,
        startNode: () => {
          restarts += 1;
          return restartedNode;
        },
        stopNode: async (child) => {
          stoppedNodes.push(child);
          stops += 1;
        },
        now: (() => {
          let value = 0;
          return () => value++;
        })(),
        wait: async () => {},
        timeoutMs: 100,
      }),
    ).resolves.toEqual({
      method: "node.invoke",
      command: "system.which",
      params: { bins: ["node"] },
      ok: true,
      result: { bins: { node: "/usr/bin/node" } },
    });
    expect(restarts).toBe(2);
    expect(stops).toBe(2);
    expect(stoppedNodes).toEqual([initialNode, restartedNode]);
    expect(calls.filter((args) => args[0] === "devices" && args[1] === "approve")).toEqual([
      ["devices", "approve", "device-request"],
    ]);
    expect(calls.filter((args) => args[0] === "nodes" && args[1] === "approve")).toEqual([
      ["nodes", "approve", "node-request"],
    ]);
    expect(calls.filter((args) => args[0] === "nodes" && args[1] === "status")).toHaveLength(2);
    expect(calls.filter((args) => args[0] === "nodes" && args[1] === "invoke")).toEqual([
      [
        "nodes",
        "invoke",
        "--node",
        "node-device",
        "--command",
        "system.which",
        "--params",
        '{"bins":["node"]}',
      ],
    ]);
  });

  it("attaches bounded redacted CLI failure context to terminal errors", async () => {
    const secret = "gateway-secret";
    const escapedSecret = "gateway-\u001b[31msecret";
    const summary = formatCliFailureDiagnostic({
      args: ["nodes", "status", "--token", secret],
      status: 7,
      stderr: `\u001b[31mauth failed for ${escapedSecret}${"x".repeat(600)}\u0007`,
    });
    expect(summary).toContain("exit 7: auth failed for [redacted]");
    expect(summary).not.toContain(secret);
    expect(
      Array.from(summary).every((character) => {
        const codePoint = character.codePointAt(0)!;
        return codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f);
      }),
    ).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(520);

    let tick = 0;
    await expect(
      approveAndInvoke({
        caseId: "compat-case",
        cli: async () => null,
        cliFailureSummary: () => summary,
        nodeChild: { exitCode: null, signalCode: null } as ChildProcess,
        startNode: () => ({ exitCode: null, signalCode: null }) as ChildProcess,
        now: () => tick++,
        wait: async () => {},
        timeoutMs: 2,
      }),
    ).rejects.toThrow(`Timed out invoking compat-case. Last CLI failure: ${summary}`);
  });

  it("derives operation evidence only from correlated observer frames", () => {
    const request = {
      id: "invoke-1",
      nodeId: "node-device",
      command: "system.which",
      paramsJSON: '{"bins":["node"]}',
    };
    const result = {
      id: "invoke-1",
      nodeId: "node-device",
      ok: true,
      payloadJSON: '{"bins":{"node":"/usr/bin/node"}}',
    };
    expect(buildObservedNodeOperation(request, result)).toEqual({
      method: "node.invoke",
      command: "system.which",
      params: { bins: ["node"] },
      ok: true,
      result: { bins: { node: "/usr/bin/node" } },
    });
    expect(() => buildObservedNodeOperation(request, { ...result, id: "forged" })).toThrow(
      /matching successful node invocation/u,
    );
    expect(() => buildObservedNodeOperation(undefined, result)).toThrow(
      /matching successful node invocation/u,
    );
  });

  it("treats signal exits as terminal and bounds child shutdown", async () => {
    expect(isChildTerminal({ exitCode: null, signalCode: "SIGTERM" })).toBe(true);
    if (process.platform === "win32") {
      return;
    }
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let closed = false;
    child.once("close", () => {
      closed = true;
    });
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        child.stdout?.once("data", () => resolvePromise());
        child.once("error", rejectPromise);
      });
      await stopChild(child, { graceMs: 25, killWaitMs: 1_000 });
      expect(child.signalCode).toBe("SIGKILL");
      expect(closed).toBe(true);
    } finally {
      if (!isChildTerminal(child)) {
        child.kill("SIGKILL");
      }
    }
  });

  it("derives only the cross-version system.which operation from approved capabilities", () => {
    expect(
      resolveApprovedNodeOperation({
        nodeId: "baseline-node",
        paired: true,
        connected: true,
        commands: ["system.which"],
      }),
    ).toEqual({
      command: "system.which",
      params: { bins: ["node"] },
    });
    expect(
      resolveApprovedNodeOperation({
        nodeId: "candidate-node",
        paired: true,
        connected: true,
        approvalState: "approved",
        commands: ["system.which", "system.run"],
      }),
    ).toEqual({
      command: "system.which",
      params: { bins: ["node"] },
    });
    for (const node of [
      { paired: false, connected: true, commands: ["system.which"] },
      { paired: true, connected: false, commands: ["system.which"] },
      {
        paired: true,
        connected: true,
        approvalState: "pending-approval",
        commands: ["system.which"],
      },
      { paired: true, connected: true, commands: ["system.run"] },
    ]) {
      expect(resolveApprovedNodeOperation(node)).toBeNull();
    }
  });

  it("rejects case output with a forged connect identity", () => {
    expect(() =>
      parseCaseResult(
        Buffer.from(
          JSON.stringify({
            architecture: "x64",
            observation: {
              ...validObservation,
              identity: { ...validObservation.identity, clientId: "forged" },
            },
          }),
        ),
        "x64",
      ),
    ).toThrow(/Linux node-host/u);
  });

  it("rejects evidence from a different container architecture", () => {
    expect(() =>
      parseCaseResult(
        Buffer.from(JSON.stringify({ architecture: "x64", observation: validObservation })),
        "arm64",
      ),
    ).toThrow(/container architecture/u);
  });

  it("requires the exact candidate, baseline, and disjoint protocol tuples", () => {
    const candidate = { gatewayProtocol: 4, nodeMinProtocol: 3, nodeMaxProtocol: 4 };
    const baseline = { gatewayProtocol: 3, nodeMinProtocol: 3, nodeMaxProtocol: 3 };
    for (const [gateway, node, clientMax, helloProtocol] of [
      ["candidate", "candidate", 4, 4],
      ["candidate", "baseline", 3, 4],
      ["baseline", "candidate", 4, 3],
      ["baseline", "baseline", 3, 3],
    ] as const) {
      const passed = {
        observation: {
          ...validObservation,
          clientMin: 3,
          clientMax,
          helloProtocol,
        },
      };
      expect(
        validateCaseProtocolContract({ gateway, node, outcome: "passed" }, passed, {
          gateway: gateway === "candidate" ? candidate : baseline,
          node: node === "candidate" ? candidate : baseline,
        }),
      ).toBe(passed);
    }
    expect(() =>
      validateCaseProtocolContract(
        { gateway: "candidate", node: "candidate", outcome: "passed" },
        {
          observation: {
            ...validObservation,
            clientMax: 4,
            clientMin: 2,
            helloProtocol: 4,
          },
        },
        { gateway: candidate, node: candidate },
      ),
    ).toThrow(/exact protocol contract/u);
    expect(() =>
      validateCaseProtocolContract(
        { gateway: "candidate", node: "baseline", outcome: "passed" },
        {
          observation: {
            ...validObservation,
            clientMin: 3,
            clientMax: 3,
            helloProtocol: 3,
          },
        },
        { gateway: candidate, node: baseline },
      ),
    ).toThrow(/exact protocol contract/u);
    expect(
      validateCaseProtocolContract(
        { gateway: "baseline", node: "candidate", outcome: "protocol-mismatch" },
        {
          mismatch: { expectedProtocol: 3 },
          observation: { ...validObservation },
        },
        { gateway: baseline, node: candidate },
      ),
    ).toMatchObject({ mismatch: { expectedProtocol: 3 } });
    expect(() =>
      validateCaseProtocolContract(
        { gateway: "candidate", node: "candidate", outcome: "protocol-mismatch" },
        {
          mismatch: { expectedProtocol: 3 },
          observation: { ...validObservation },
        },
        { gateway: candidate, node: candidate },
      ),
    ).toThrow(/exact 1\.\.2 contract/u);
  });

  it("merges bounded Actions job pages with stable totals and unique ids", () => {
    const firstPage = {
      total_count: 101,
      jobs: Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })),
    };
    const secondPage = { total_count: 101, jobs: [{ id: 101 }] };
    expect(mergeActionsWorkflowJobPages([firstPage, secondPage])).toMatchObject({
      total_count: 101,
      jobs: expect.arrayContaining([{ id: 1 }, { id: 101 }]),
    });
    expect(() =>
      mergeActionsWorkflowJobPages([
        firstPage,
        { total_count: 102, jobs: [{ id: 101 }, { id: 102 }] },
      ]),
    ).toThrow(/unstable/u);
    expect(() =>
      mergeActionsWorkflowJobPages([firstPage, { total_count: 101, jobs: [{ id: 100 }] }]),
    ).toThrow(/duplicate/u);
  });

  it.each([
    ["success", 0],
    ["nonzero", 7],
  ] as const)("removes the managed container after %s", async (_label, runStatus) => {
    const calls: string[][] = [];
    await runManagedContainer({
      args: ["image", "true"],
      logPath: join(process.cwd(), ".local", `managed-container-${runStatus}.log`),
      name: `openclaw-managed-test-${runStatus}`,
      timeoutMs: 1_000,
      runCommand: async ({ args }) => {
        calls.push(args ?? []);
        if (args?.[0] === "run") {
          const cidfile = args[args.indexOf("--cidfile") + 1];
          writeFileSync(cidfile!, `owned-${runStatus}\n`);
          return runStatus;
        }
        return 0;
      },
    }).catch((error: unknown) => {
      if (runStatus === 0) {
        throw error;
      }
    });
    expect(calls.find((args) => args[0] === "run")?.slice(0, 9)).toEqual([
      "run",
      "--cidfile",
      expect.any(String),
      "--name",
      `openclaw-managed-test-${runStatus}`,
      "--rm",
      "--log-driver",
      "none",
      "image",
    ]);
    expect(calls.some((args) => args[0] === "rm" && args[1] === "--force")).toBe(true);
    expect(calls.some((args) => args[0] === "ps" && args.includes("id=owned-" + runStatus))).toBe(
      true,
    );
  });

  it("does not remove a same-name container when docker run never creates the requested one", async () => {
    const calls: string[][] = [];
    await expect(
      runManagedContainer({
        args: ["image", "true"],
        logPath: join(process.cwd(), ".local", "managed-container-name-conflict.log"),
        name: "openclaw-managed-test-name-conflict",
        timeoutMs: 1_000,
        runCommand: async ({ args }) => {
          calls.push(args ?? []);
          return args?.[0] === "run" ? 125 : 0;
        },
      }),
    ).rejects.toThrow(/failed/u);
    expect(calls.map((args) => args[0])).toEqual(["run"]);
  });

  it("removes the managed container after a real runner SIGTERM", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "openclaw-managed-container-sigterm-"));
    const binDir = join(dir, "bin");
    const callsPath = join(dir, "calls.log");
    const readyPath = join(dir, "ready");
    const dockerPath = join(binDir, "docker");
    const helperUrl = pathToFileURL(
      resolve("scripts/lib/cross-os-release-checks/managed-container.ts"),
    ).href;
    mkdirSync(binDir);
    writeFileSync(
      dockerPath,
      `#!/bin/sh
set -eu
case "$1" in
  run)
    cidfile=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--cidfile" ]; then
        cidfile="$2"
        break
      fi
      shift
    done
    echo owned-sigterm >"$cidfile"
    echo ready >"$OPENCLAW_TEST_READY"
    trap 'exit 143' TERM INT HUP
    while :; do sleep 1; done
    ;;
  rm|ps)
    echo "$1" >>"$OPENCLAW_TEST_CALLS"
    exit 0
    ;;
  *)
    exit 2
    ;;
esac
`,
      "utf8",
    );
    chmodSync(dockerPath, 0o755);
    const runnerScript = `
import { runManagedContainer } from ${JSON.stringify(helperUrl)};
await runManagedContainer({
  args: ["image", "true"],
  logPath: ${JSON.stringify(join(dir, "managed.log"))},
  name: "openclaw-managed-test-real-sigterm",
  timeoutMs: 60_000,
});
`;
    const runner = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", runnerScript],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          OPENCLAW_TEST_CALLS: callsPath,
          OPENCLAW_TEST_READY: readyPath,
        },
        stdio: "ignore",
      },
    );
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !readOptional(readyPath)) {
        await delay(25);
      }
      expect(readOptional(readyPath)).toBe("ready\n");
      runner.kill("SIGTERM");
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => rejectPromise(new Error("runner did not exit")), 10_000);
        runner.once("close", () => {
          clearTimeout(timer);
          resolvePromise();
        });
      });
      expect(readOptional(callsPath).trim().split("\n")).toEqual(["rm", "ps"]);
    } finally {
      if (runner.exitCode === null) {
        runner.kill("SIGKILL");
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clears the node identity bootstrap timeout after a quick capture", async () => {
    vi.useFakeTimers();
    try {
      await captureExpectedIdentity({
        bootstrap: Promise.resolve(),
        childExit: new Promise<number>(() => {}),
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes the managed container after timeout", async () => {
    const calls: string[][] = [];
    await expect(
      runManagedContainer({
        args: ["image", "true"],
        logPath: join(process.cwd(), ".local", "managed-container-timeout.log"),
        name: "openclaw-managed-test-timeout",
        timeoutMs: 1,
        runCommand: async ({ args }) => {
          calls.push(args ?? []);
          if (args?.[0] === "run") {
            throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
          }
          return 0;
        },
      }),
    ).rejects.toThrow(/failed/u);
    expect(calls.map((args) => args[0])).toEqual(["run"]);
  });

  it("fails when container cleanup cannot be verified", async () => {
    await expect(
      runManagedContainer({
        args: ["image", "true"],
        logPath: join(process.cwd(), ".local", "managed-container-probe.log"),
        name: "openclaw-managed-test-probe",
        timeoutMs: 1_000,
        runCommand: async ({ args }) => {
          if (args?.[0] === "run") {
            const cidfile = args[args.indexOf("--cidfile") + 1];
            writeFileSync(cidfile!, "owned-probe\n");
          }
          return args?.[0] === "ps" ? 125 : 0;
        },
      }),
    ).rejects.toThrow(/cleanup could not be verified/u);
  });

  it("consumes current-run artifacts without repacking or re-uploading them", () => {
    type WorkflowStep = Record<string, unknown> & {
      env?: Record<string, unknown>;
      id?: string;
      if?: string;
      name?: string;
      run?: string;
      uses?: string;
      with?: Record<string, unknown>;
    };
    type WorkflowJob = {
      "continue-on-error"?: string;
      if?: string;
      outputs?: Record<string, unknown>;
      "runs-on"?: string;
      steps: WorkflowStep[];
      strategy?: {
        matrix: { include: Array<{ architecture: string; runner: string }> };
      };
    };
    const workflow = parse(
      readFileSync(".github/workflows/openclaw-cross-os-release-checks-reusable.yml", "utf8"),
    ) as {
      concurrency: { "cancel-in-progress": string; group: string };
      on: {
        workflow_call: { inputs: Record<string, Record<string, unknown>> };
        workflow_dispatch: { inputs: Record<string, Record<string, unknown>> };
      };
      jobs: {
        cross_os_release_checks: WorkflowJob;
        gateway_node_linux_compat: WorkflowJob & {
          "runs-on": string;
          strategy: {
            matrix: { include: Array<{ architecture: string; runner: string }> };
          };
        };
        prepare: WorkflowJob & { outputs: Record<string, unknown> };
      };
    };
    const job = workflow.jobs.gateway_node_linux_compat;
    const prepare = workflow.jobs.prepare;
    expect(workflow.concurrency).toEqual({
      group:
        "openclaw-cross-os-release-checks-${{ inputs.ref }}-${{ inputs.provider }}-${{ inputs.mode }}-${{ inputs.suite_filter || 'all' }}",
      "cancel-in-progress": "${{ inputs.ref == 'main' }}",
    });
    expect(job.if).toBe("needs.prepare.outputs.gateway_node_compat_enabled == 'true'");
    expect(job["continue-on-error"]).toBe("${{ inputs.advisory }}");
    expect(job.strategy.matrix).toEqual({
      include: [
        { architecture: "x64", runner: "ubuntu-24.04" },
        { architecture: "arm64", runner: "ubuntu-24.04-arm" },
      ],
    });
    expect(job["runs-on"]).toBe("${{ matrix.runner }}");
    const installIndex = job.steps.findIndex(
      (step) => step.name === "Install trusted observer dependencies",
    );
    const producerIndex = job.steps.findIndex(
      (step) => step.name === "Produce six canonical compatibility cases",
    );
    expect(installIndex).toBeGreaterThan(-1);
    expect(installIndex).toBeLessThan(producerIndex);
    expect(job.steps[installIndex]?.run).toBe(
      "pnpm install --frozen-lockfile --prefer-offline --ignore-scripts",
    );
    const serialized = JSON.stringify(job);
    const executionSteps = JSON.stringify(
      job.steps.filter((step) => !String(step.uses).startsWith("actions/upload-artifact")),
    );
    expect(serialized).toContain("actions/download-artifact");
    expect(executionSteps).not.toContain("actions/upload-artifact");
    expect(executionSteps).not.toContain("npm pack");
    const producer = job.steps.find(
      (step) => step.name === "Produce six canonical compatibility cases",
    );
    expect(producer?.id).toBe("produce_compat");
    expect(producer?.run).not.toContain("${{ needs.prepare.outputs");
    expect(producer?.env).not.toHaveProperty("GH_TOKEN");
    expect(producer?.env).toHaveProperty(
      "GATEWAY_NODE_COMPAT_EXPECTED_ARCH",
      "${{ matrix.architecture }}",
    );
    expect(producer?.env).not.toHaveProperty("GATEWAY_NODE_COMPAT_PRODUCER_JOB_NAME");
    expect(producer?.env).toHaveProperty(
      "CANDIDATE_ARTIFACT_RUN_ATTEMPT",
      "${{ needs.prepare.outputs.candidate_artifact_run_attempt }}",
    );
    expect(producer?.env).toHaveProperty(
      "BASELINE_ARTIFACT_RUN_ATTEMPT",
      "${{ needs.prepare.outputs.compat_baseline_artifact_run_attempt }}",
    );
    expect(producer?.run).not.toContain("--gateway-node-compat-producer-job-name");
    expect(producer?.run).toContain('--candidate-workflow-jobs-metadata "$ROOT/metadata/jobs"');
    const provenance = job.steps.find(
      (step) => step.name === "Capture current-run artifact provenance",
    );
    expect(provenance?.run).toContain("for page in $(seq 1 10)");
    expect(provenance?.run).toContain("per_page=100&page=${page}");
    expect(provenance?.run).toContain("attempts/${PRODUCER_RUN_ATTEMPT}");
    expect(provenance?.run).toContain("collected == total_count");
    const matrixSteps = prepare.steps.filter((step) => step.name === "Resolve runner matrix");
    expect(matrixSteps).toHaveLength(1);
    const matrix = matrixSteps[0]!;
    expect(matrix.run).toContain("--resolve-selection true");
    expect(matrix.run).toContain("set -euo pipefail");
    expect(matrix.run).toContain("jq -ce");
    expect(matrix.run).toContain("jq -er");
    expect(matrix.run).toContain('[[ -n "$value" ]]');
    expect(matrix.run).toContain("candidate_preparation_enabled=");
    expect(matrix.run).toContain("packaged_upgrade_enabled=");
    expect(matrix.run).toContain("cross_os_release_checks_enabled=");
    expect(matrix.run).toContain("gateway_node_compat_enabled=");
    expect(prepare.outputs.gateway_node_compat_producer_run_attempt).toBe(
      "${{ github.run_attempt }}",
    );
    expect(prepare.outputs).not.toHaveProperty("gateway_node_compat_producer_job_name");
    const matrixIndex = prepare.steps.indexOf(matrix);
    for (const name of [
      "Validate provider secret availability",
      "Validate provided candidate artifact binding",
      "Checkout public source ref",
      "Setup pnpm",
      "Install workflow validation dependencies",
      "Build candidate artifact once",
      "Resolve baseline package spec",
      "Pack Gateway compatibility baseline",
    ]) {
      expect(matrixIndex).toBeLessThan(prepare.steps.findIndex((step) => step.name === name));
    }
    expect(
      prepare.steps.find((step) => step.name === "Validate provider secret availability")?.if,
    ).toBe("steps.matrix.outputs.cross_os_release_checks_enabled == 'true'");
    for (const name of [
      "Validate provided candidate artifact binding",
      "Checkout public source ref",
      "Setup pnpm",
      "Ensure pnpm store cache directory exists",
      "Install workflow validation dependencies",
      "Build candidate artifact once",
      "Download provided candidate artifact",
      "Resolve provided candidate package",
      "Capture candidate metadata",
      "Upload candidate artifact",
    ]) {
      expect(String(prepare.steps.find((step) => step.name === name)?.if)).toContain(
        "steps.matrix.outputs.candidate_preparation_enabled == 'true'",
      );
    }
    for (const name of [
      "Resolve baseline package spec",
      "Pack baseline artifact",
      "Capture baseline metadata",
      "Upload baseline artifact",
    ]) {
      expect(prepare.steps.find((step) => step.name === name)?.if).toBe(
        "steps.matrix.outputs.packaged_upgrade_enabled == 'true'",
      );
    }
    expect(workflow.jobs.cross_os_release_checks.if).toBe(
      "needs.prepare.outputs.cross_os_release_checks_enabled == 'true'",
    );
    for (const trigger of ["workflow_call", "workflow_dispatch"] as const) {
      expect(workflow.on[trigger].inputs).not.toHaveProperty(
        "gateway_node_compat_producer_job_name",
      );
    }
    const diagnostics = job.steps.find(
      (step) => step.name === "Upload Gateway/node compatibility diagnostics",
    );
    expect(diagnostics?.if).toBe("${{ failure() && steps.produce_compat.outcome != 'skipped' }}");
    expect(diagnostics?.with?.path).toContain("diagnostics/producer-failure.json");
    expect(diagnostics?.with?.path).toContain("diagnostics/raw/*.json");
    expect(diagnostics?.with?.path).toContain("evidence/*.json");
    expect(diagnostics?.with?.path).toContain("logs/*.log");
    expect(diagnostics?.with?.["if-no-files-found"]).toBe("error");
    const evidenceUpload = job.steps.find(
      (step) => step.name === "Upload Gateway/node compatibility evidence",
    );
    expect(evidenceUpload?.with).toHaveProperty(
      "name",
      "openclaw-gateway-node-linux-compat-${{ matrix.architecture }}-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    for (const name of [
      "Pack Gateway compatibility baseline",
      "Upload Gateway compatibility baseline",
    ]) {
      expect(prepare.steps.find((step) => step.name === name)?.if).toBe(
        "steps.matrix.outputs.gateway_node_compat_enabled == 'true'",
      );
    }

    const releaseWorkflow = parse(
      readFileSync(".github/workflows/openclaw-release-checks.yml", "utf8"),
    ) as {
      jobs: {
        cross_os_release_checks: { with?: Record<string, unknown> };
      };
    };
    expect(releaseWorkflow.jobs.cross_os_release_checks.with).not.toHaveProperty(
      "gateway_node_compat_producer_job_name",
    );
  });

  it("does not load Gateway compatibility dependencies for non-compat modes", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-gateway-node-loader-"));
    try {
      const loaderPath = join(dir, "reject-gateway-compat-loader.mjs");
      writeFileSync(
        loaderPath,
        `export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith("/gateway-node-compat.ts")) {
    throw new Error("Gateway compatibility module loaded outside compatibility mode");
  }
  return nextResolve(specifier, context);
}
`,
        "utf8",
      );
      const result = spawnSync(
        process.execPath,
        [
          "--loader",
          loaderPath,
          "scripts/openclaw-cross-os-release-checks.ts",
          "--resolve-matrix",
          "true",
          "--mode",
          "fresh",
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      expect(result.stderr).not.toContain(
        "Gateway compatibility module loaded outside compatibility mode",
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ include: expect.any(Array) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hashes the complete installed runtime tree deterministically", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-runtime-tree-"));
    try {
      mkdirSync(join(dir, "dist"));
      writeFileSync(join(dir, "openclaw.mjs"), "launcher\n");
      writeFileSync(join(dir, "dist", "runtime.js"), "one\n");
      const first = sha256RuntimeTree(dir);
      expect(sha256RuntimeTree(dir)).toBe(first);
      writeFileSync(join(dir, "dist", "runtime.js"), "two\n");
      expect(sha256RuntimeTree(dir)).not.toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function readOptional(path: string) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
