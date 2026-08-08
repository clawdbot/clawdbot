import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as evidenceModule from "../../scripts/gateway-node-compat-evidence.mjs";
import {
  GATEWAY_NODE_COMPAT_CASE_CONTRACTS,
  GATEWAY_NODE_COMPAT_SCHEMA,
  buildGatewayNodeCompatCaseId,
  canonicalizeGatewayNodeCompatEvidence as canonicalizeGatewayNodeCompatEvidenceWithIdentities,
  validateGatewayNodeCompatEvidence as validateGatewayNodeCompatEvidenceWithIdentities,
} from "../../scripts/gateway-node-compat-evidence.mjs";
import type {
  GatewayNodeCompatArtifactIdentities,
  GatewayNodeCompatCaseContract,
  GatewayNodeCompatOutcome,
} from "../../scripts/gateway-node-compat-evidence.mjs";

const SCRIPT_PATH = "scripts/gateway-node-compat-evidence.mjs";
const CANDIDATE_PACKAGE_SHA256 = "b".repeat(64);
const BASELINE_PACKAGE_SHA256 = "d".repeat(64);
const ARTIFACT_IDENTITIES: GatewayNodeCompatArtifactIdentities = {
  candidatePackageSha256: CANDIDATE_PACKAGE_SHA256,
  baselinePackageSha256: BASELINE_PACKAGE_SHA256,
};
const tempRoots: string[] = [];

function validateGatewayNodeCompatEvidence(value: unknown) {
  return validateGatewayNodeCompatEvidenceWithIdentities(value, ARTIFACT_IDENTITIES);
}

function canonicalizeGatewayNodeCompatEvidence(value: unknown) {
  return canonicalizeGatewayNodeCompatEvidenceWithIdentities(value, ARTIFACT_IDENTITIES);
}

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-gateway-node-compat-"));
  tempRoots.push(root);
  return root;
}

function packagedArtifact(
  version: string,
  sourceSha: string,
  name: string,
  sha256: string,
  artifactSeed: string,
) {
  return {
    version,
    sourceSha,
    name,
    sha256,
    actionsArtifact: {
      id: Number.parseInt(artifactSeed.repeat(4), 10),
      name: `${name}-input`,
      digest: `sha256:${artifactSeed.repeat(64)}`,
      sizeBytes: 4096,
      runId: artifactSeed.repeat(9),
      runAttempt: 2,
    },
  };
}

function installedRuntime(
  version: string,
  sourceSha: string,
  packageSha256: string,
  identitySha256: string,
) {
  return { version, sourceSha, packageSha256, identitySha256 };
}

function validPassEvidence(): Record<string, any> {
  const gatewayVersion = "v2026.8.6";
  const gatewaySourceSha = "a".repeat(40);
  const nodeVersion = "v2026.5.7";
  const nodeSourceSha = "c".repeat(40);
  return {
    schema: GATEWAY_NODE_COMPAT_SCHEMA,
    caseId: "linux-x64-candidate-gateway-baseline-node",
    direction: "candidate-gateway-baseline-node",
    connection: {
      transport: "gateway-websocket",
      role: "node",
      mode: "node",
    },
    gateway: {
      packagedArtifact: packagedArtifact(
        gatewayVersion,
        gatewaySourceSha,
        "openclaw-candidate.tgz",
        CANDIDATE_PACKAGE_SHA256,
        "1",
      ),
      installedRuntime: installedRuntime(
        gatewayVersion,
        gatewaySourceSha,
        CANDIDATE_PACKAGE_SHA256,
        "2".repeat(64),
      ),
    },
    node: {
      kind: "linux",
      architecture: "x64",
      protocolClientId: "node-host",
      packagedArtifact: packagedArtifact(
        nodeVersion,
        nodeSourceSha,
        "openclaw-baseline.tgz",
        BASELINE_PACKAGE_SHA256,
        "3",
      ),
      installedRuntime: installedRuntime(
        nodeVersion,
        nodeSourceSha,
        BASELINE_PACKAGE_SHA256,
        "4".repeat(64),
      ),
    },
    protocol: {
      gatewayProtocolVersion: 4,
      gatewayAcceptedNodeMin: 3,
      protocolClientAdvertisedMin: 3,
      protocolClientAdvertisedMax: 3,
      helloProtocol: 4,
    },
    operation: {
      method: "node.invoke",
      command: "system.which",
      params: {
        bins: ["node"],
      },
      ok: true,
      result: {
        bins: {
          node: "/usr/bin/node",
        },
      },
    },
    result: {
      outcome: "passed",
      startedAt: "2026-08-06T12:00:00.000Z",
      completedAt: "2026-08-06T12:00:05.000Z",
    },
    producer: {
      repository: "openclaw/openclaw",
      workflowPath: ".github/workflows/openclaw-cross-os-release-checks-reusable.yml",
      workflowSha: "e".repeat(40),
      runId: "123456789",
      runAttempt: 2,
      job: "gateway-node-compat-linux-x64",
    },
  };
}

function deviceInfoOperation() {
  return {
    method: "node.invoke",
    command: "device.info",
    params: {},
    ok: true,
    result: {
      systemName: "iOS",
      systemVersion: "18.0",
    },
  };
}

function setNodeKind(
  evidence: Record<string, any>,
  kind: "android" | "ios" | "linux" | "macos" | "windows",
  protocolClientId: string,
) {
  evidence.node.kind = kind;
  evidence.node.protocolClientId = protocolClientId;
  evidence.caseId = `${kind}-${evidence.node.architecture}-${evidence.direction}`;
  if (kind === "android" || kind === "ios") {
    evidence.operation = deviceInfoOperation();
    evidence.operation.result.systemName = kind === "android" ? "Android" : "iOS";
  }
}

function validMismatchEvidence(): Record<string, any> {
  const evidence = validPassEvidence();
  const candidateRuntime = runtimeBindingForRole("candidate");
  evidence.caseId = "linux-x64-candidate-gateway-disjoint-node";
  evidence.direction = "candidate-gateway-disjoint-node";
  evidence.node.packagedArtifact = candidateRuntime.packagedArtifact;
  evidence.node.installedRuntime = candidateRuntime.installedRuntime;
  evidence.protocol.protocolClientAdvertisedMin = 5;
  evidence.protocol.protocolClientAdvertisedMax = 5;
  evidence.protocol.helloProtocol = null;
  evidence.operation = null;
  evidence.result = {
    outcome: "protocol-mismatch",
    failureCode: "PROTOCOL_MISMATCH",
    failurePhase: "connect",
    startedAt: "2026-08-06T12:00:00.000Z",
    completedAt: "2026-08-06T12:00:01.000Z",
  };
  return evidence;
}

function validBaselineMismatchEvidence(): Record<string, any> {
  const evidence = validMismatchEvidence();
  const baselineRuntime = runtimeBindingForRole("baseline");
  evidence.caseId = "linux-x64-baseline-gateway-disjoint-node";
  evidence.direction = "baseline-gateway-disjoint-node";
  evidence.gateway = baselineRuntime;
  evidence.protocol.gatewayProtocolVersion = 3;
  evidence.protocol.gatewayAcceptedNodeMin = 3;
  evidence.protocol.protocolClientAdvertisedMin = 4;
  evidence.protocol.protocolClientAdvertisedMax = 4;
  return evidence;
}

function runtimeBindingForRole(role: "baseline" | "candidate") {
  const identityFixture = validPassEvidence();
  return role === "candidate"
    ? clone(identityFixture.gateway)
    : {
        packagedArtifact: clone(identityFixture.node.packagedArtifact),
        installedRuntime: clone(identityFixture.node.installedRuntime),
      };
}

function validEvidenceForContract(contract: GatewayNodeCompatCaseContract): Record<string, any> {
  const evidence =
    contract.direction === "baseline-gateway-disjoint-node"
      ? validBaselineMismatchEvidence()
      : contract.outcome === "protocol-mismatch"
        ? validMismatchEvidence()
        : validPassEvidence();
  evidence.gateway = runtimeBindingForRole(contract.gatewayArtifactRole);
  const nodeRuntime = runtimeBindingForRole(contract.nodeArtifactRole);
  evidence.node.packagedArtifact = nodeRuntime.packagedArtifact;
  evidence.node.installedRuntime = nodeRuntime.installedRuntime;
  evidence.direction = contract.direction;
  evidence.caseId = buildGatewayNodeCompatCaseId({
    architecture: evidence.node.architecture,
    direction: contract.direction,
    kind: evidence.node.kind,
  });
  return evidence;
}

function setOutcome(evidence: Record<string, any>, outcome: GatewayNodeCompatOutcome): void {
  if (outcome === "passed") {
    evidence.protocol.helloProtocol = evidence.protocol.gatewayProtocolVersion;
    evidence.operation = clone(validPassEvidence().operation);
    evidence.result = clone(validPassEvidence().result);
    return;
  }
  evidence.protocol.helloProtocol = null;
  evidence.operation = null;
  evidence.result = clone(validMismatchEvidence().result);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function runCli(args: string[], timeout?: number) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT_PATH,
      ...args,
      "--candidate-package-sha256",
      CANDIDATE_PACKAGE_SHA256,
      "--baseline-package-sha256",
      BASELINE_PACKAGE_SHA256,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout,
    },
  );
}

function writeMalformedUtf8Evidence(root: string): string {
  const inputPath = path.join(root, "invalid-utf8.json");
  const encoded = Buffer.from(JSON.stringify(validPassEvidence()), "utf8");
  const markerOffset = encoded.indexOf(Buffer.from("/usr/bin/node", "utf8"));
  expect(markerOffset).toBeGreaterThanOrEqual(0);
  encoded[markerOffset] = 0x80;
  writeFileSync(inputPath, encoded);
  return inputPath;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("gateway node compatibility evidence", () => {
  it("accepts observed direct WebSocket node invocation evidence", () => {
    const evidence = validPassEvidence();

    expect(validateGatewayNodeCompatEvidence(evidence)).toBe(evidence);
  });

  it("accepts observed structured protocol mismatch evidence", () => {
    const evidence = validMismatchEvidence();

    expect(validateGatewayNodeCompatEvidence(evidence)).toBe(evidence);
  });

  it("accepts observed baseline Gateway protocol mismatch evidence", () => {
    const evidence = validBaselineMismatchEvidence();

    expect(validateGatewayNodeCompatEvidence(evidence)).toBe(evidence);
  });

  it.each(GATEWAY_NODE_COMPAT_CASE_CONTRACTS)(
    "accepts the $direction case contract",
    (contract) => {
      const evidence = validEvidenceForContract(contract);

      expect(validateGatewayNodeCompatEvidence(evidence)).toBe(evidence);
    },
  );

  it.each(
    GATEWAY_NODE_COMPAT_CASE_CONTRACTS.flatMap((contract) =>
      (["gateway", "node"] as const).map((subject) => ({ contract, subject })),
    ),
  )(
    "rejects $contract.direction when the $subject artifact has the opposite package identity",
    ({ contract, subject }) => {
      const evidence = validEvidenceForContract(contract);
      const expectedRole =
        subject === "gateway" ? contract.gatewayArtifactRole : contract.nodeArtifactRole;
      const oppositeRole = expectedRole === "candidate" ? "baseline" : "candidate";
      const oppositeRuntime = runtimeBindingForRole(oppositeRole);
      if (subject === "gateway") {
        evidence.gateway = oppositeRuntime;
      } else {
        evidence.node.packagedArtifact = oppositeRuntime.packagedArtifact;
        evidence.node.installedRuntime = oppositeRuntime.installedRuntime;
      }

      expect(() => validateGatewayNodeCompatEvidence(evidence)).toThrow(
        new RegExp(`${subject} artifact identity must match the ${expectedRole} package`, "u"),
      );
    },
  );

  it("defines the exact direction and outcome contracts", () => {
    expect(GATEWAY_NODE_COMPAT_CASE_CONTRACTS).toEqual([
      {
        direction: "baseline-gateway-baseline-node",
        gatewayArtifactRole: "baseline",
        nodeArtifactRole: "baseline",
        outcome: "passed",
      },
      {
        direction: "baseline-gateway-candidate-node",
        gatewayArtifactRole: "baseline",
        nodeArtifactRole: "candidate",
        outcome: "passed",
      },
      {
        direction: "baseline-gateway-disjoint-node",
        gatewayArtifactRole: "baseline",
        nodeArtifactRole: "candidate",
        outcome: "protocol-mismatch",
      },
      {
        direction: "candidate-gateway-baseline-node",
        gatewayArtifactRole: "candidate",
        nodeArtifactRole: "baseline",
        outcome: "passed",
      },
      {
        direction: "candidate-gateway-candidate-node",
        gatewayArtifactRole: "candidate",
        nodeArtifactRole: "candidate",
        outcome: "passed",
      },
      {
        direction: "candidate-gateway-disjoint-node",
        gatewayArtifactRole: "candidate",
        nodeArtifactRole: "candidate",
        outcome: "protocol-mismatch",
      },
    ]);
    expect(GATEWAY_NODE_COMPAT_CASE_CONTRACTS.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(GATEWAY_NODE_COMPAT_CASE_CONTRACTS)).toBe(true);
  });

  it.each(
    GATEWAY_NODE_COMPAT_CASE_CONTRACTS.flatMap((contract) =>
      GATEWAY_NODE_COMPAT_CASE_CONTRACTS.filter(
        (other) => other.direction !== contract.direction,
      ).map((other) => ({ contract, contradictoryDirection: other.direction })),
    ),
  )(
    "rejects $contract.direction evidence paired with $contradictoryDirection",
    ({ contract, contradictoryDirection }) => {
      const evidence = validEvidenceForContract(contract);
      evidence.direction = contradictoryDirection;

      expect(() => validateGatewayNodeCompatEvidence(evidence)).toThrow(
        /caseId must be .* for direction/u,
      );
    },
  );

  it.each(
    GATEWAY_NODE_COMPAT_CASE_CONTRACTS.flatMap((contract) =>
      GATEWAY_NODE_COMPAT_CASE_CONTRACTS.filter(
        (other) => other.direction !== contract.direction,
      ).map((other) => ({ contract, contradictoryCase: other })),
    ),
  )(
    "rejects $contract.direction evidence with the $contradictoryCase.direction case ID",
    ({ contract, contradictoryCase }) => {
      const evidence = validEvidenceForContract(contract);
      evidence.caseId = buildGatewayNodeCompatCaseId({
        architecture: evidence.node.architecture,
        direction: contradictoryCase.direction,
        kind: evidence.node.kind,
      });

      expect(() => validateGatewayNodeCompatEvidence(evidence)).toThrow(
        /caseId must be .* for direction/u,
      );
    },
  );

  it.each(GATEWAY_NODE_COMPAT_CASE_CONTRACTS)(
    "rejects $direction evidence with the contradictory outcome",
    (contract) => {
      const evidence = validEvidenceForContract(contract);
      const contradictoryOutcome = contract.outcome === "passed" ? "protocol-mismatch" : "passed";
      setOutcome(evidence, contradictoryOutcome);

      expect(() => validateGatewayNodeCompatEvidence(evidence)).toThrow(
        new RegExp(`${contract.direction} requires result\\.outcome ${contract.outcome}`, "u"),
      );
    },
  );

  it("builds case IDs from the canonical node topology and direction", () => {
    expect(
      buildGatewayNodeCompatCaseId({
        architecture: "arm64",
        direction: "baseline-gateway-candidate-node",
        kind: "ios",
      }),
    ).toBe("ios-arm64-baseline-gateway-candidate-node");
  });

  it.each([
    ["root", (value: Record<string, any>) => (value.extra = true)],
    ["connection", (value: Record<string, any>) => (value.connection.extra = true)],
    ["gateway", (value: Record<string, any>) => (value.gateway.extra = true)],
    [
      "gateway package",
      (value: Record<string, any>) => (value.gateway.packagedArtifact.extra = true),
    ],
    [
      "gateway Actions artifact",
      (value: Record<string, any>) => (value.gateway.packagedArtifact.actionsArtifact.extra = true),
    ],
    [
      "gateway installed runtime",
      (value: Record<string, any>) => (value.gateway.installedRuntime.extra = true),
    ],
    ["node", (value: Record<string, any>) => (value.node.extra = true)],
    ["protocol", (value: Record<string, any>) => (value.protocol.extra = true)],
    ["operation", (value: Record<string, any>) => (value.operation.extra = true)],
    ["operation result", (value: Record<string, any>) => (value.operation.result.extra = true)],
    ["result", (value: Record<string, any>) => (value.result.extra = true)],
    ["producer", (value: Record<string, any>) => (value.producer.extra = true)],
  ])("rejects unknown keys at the %s level", (_label, mutate) => {
    const evidence = validPassEvidence();
    mutate(evidence);

    expect(() => validateGatewayNodeCompatEvidence(evidence)).toThrow(/not allowed/u);
  });

  it.each([
    ["case ID", (value: Record<string, any>) => delete value.caseId],
    ["connection", (value: Record<string, any>) => delete value.connection.mode],
    [
      "package artifact",
      (value: Record<string, any>) => delete value.gateway.packagedArtifact.sha256,
    ],
    [
      "Actions artifact",
      (value: Record<string, any>) => delete value.gateway.packagedArtifact.actionsArtifact.digest,
    ],
    [
      "installed runtime",
      (value: Record<string, any>) => delete value.gateway.installedRuntime.identitySha256,
    ],
    [
      "installed package",
      (value: Record<string, any>) => delete value.gateway.installedRuntime.packageSha256,
    ],
    ["node", (value: Record<string, any>) => delete value.node.kind],
    ["protocol", (value: Record<string, any>) => delete value.protocol.helloProtocol],
    ["operation", (value: Record<string, any>) => delete value.operation.command],
    ["result", (value: Record<string, any>) => delete value.result.completedAt],
    ["producer", (value: Record<string, any>) => delete value.producer.job],
  ])("rejects missing keys at the %s level", (_label, mutate) => {
    const evidence = validPassEvidence();
    mutate(evidence);

    expect(() => validateGatewayNodeCompatEvidence(evidence)).toThrow(/is required/u);
  });

  it("requires a stable bounded case ID and supported direction", () => {
    for (const caseId of ["Linux-X64", "-leading", "contains/slash", "x".repeat(129)]) {
      const evidence = validPassEvidence();
      evidence.caseId = caseId;
      expect(() => validateGatewayNodeCompatEvidence(evidence)).toThrow(/caseId/u);
    }

    for (const unsupportedDirection of [
      "old-to-new",
      "baseline-gateway-disjoint-client",
      "disjoint-gateway-baseline-node",
    ]) {
      const evidence = validPassEvidence();
      evidence.direction = unsupportedDirection;
      expect(() => validateGatewayNodeCompatEvidence(evidence)).toThrow(
        /direction is unsupported/u,
      );
    }
  });

  it("requires direct Gateway WebSocket role=node mode=node", () => {
    for (const [field, value, message] of [
      ["transport", "watch-node-http", /transport must be gateway-websocket/u],
      ["role", "operator", /role must be node/u],
      ["mode", "ui", /mode must be node/u],
    ] as const) {
      const evidence = validPassEvidence();
      evidence.connection[field] = value;
      expect(() => validateGatewayNodeCompatEvidence(evidence)).toThrow(message);
    }
  });

  it.each([
    ["android", "openclaw-android"],
    ["ios", "openclaw-ios"],
  ] as const)("accepts the %s direct node with a device.info proof", (kind, protocolClientId) => {
    const evidence = validPassEvidence();
    setNodeKind(evidence, kind, protocolClientId);

    expect(validateGatewayNodeCompatEvidence(evidence)).toBe(evidence);
  });

  it("accepts iPadOS device.info evidence for the iOS node family", () => {
    const evidence = validPassEvidence();
    setNodeKind(evidence, "ios", "openclaw-ios");
    evidence.operation.result.systemName = "iPadOS";

    expect(validateGatewayNodeCompatEvidence(evidence)).toBe(evidence);
  });

  it.each([
    ["android", "openclaw-android", "iOS", "Android"],
    ["android", "openclaw-android", "iPadOS", "Android"],
    ["ios", "openclaw-ios", "Android", "iOS"],
  ] as const)(
    "rejects crossed device.info systemName evidence for %s",
    (kind, protocolClientId, crossedSystemName, expectedSystemName) => {
      const evidence = validPassEvidence();
      setNodeKind(evidence, kind, protocolClientId);
      evidence.operation.result.systemName = crossedSystemName;

      expect(() => validateGatewayNodeCompatEvidence(evidence)).toThrow(
        new RegExp(
          `${kind} nodes require operation\\.result\\.systemName ${expectedSystemName}`,
          "u",
        ),
      );
    },
  );

  it.each([
    ["linux", "node-host"],
    ["macos", "openclaw-macos"],
    ["windows", "node-host"],
  ] as const)("accepts the %s direct node with a system.which proof", (kind, protocolClientId) => {
    const evidence = validPassEvidence();
    setNodeKind(evidence, kind, protocolClientId);

    expect(validateGatewayNodeCompatEvidence(evidence)).toBe(evidence);
  });

  it.each(["watchos", "wearos"])("rejects the %s non-WebSocket-node topology", (kind) => {
    const evidence = validPassEvidence();
    evidence.node.kind = kind;

    expect(() => validateGatewayNodeCompatEvidence(evidence)).toThrow(/node.kind is unsupported/u);
  });

  it("rejects removed proxy concepts and incorrect client topology", () => {
    const proxy = validPassEvidence();
    proxy.node.proxy = { kind: "android" };
    expect(() => validateGatewayNodeCompatEvidence(proxy)).toThrow(/node.proxy is not allowed/u);

    const wrongClient = validPassEvidence();
    wrongClient.node.kind = "windows";
    wrongClient.node.protocolClientId = "openclaw-ios";
    expect(() => validateGatewayNodeCompatEvidence(wrongClient)).toThrow(
      /windows nodes require protocol client node-host/u,
    );
  });

  it("requires lowercase package, runtime, source, and Actions identities", () => {
    const invalidCases: Array<[string, (value: Record<string, any>) => void, RegExp]> = [
      [
        "source SHA",
        (value) => (value.gateway.packagedArtifact.sourceSha = "A".repeat(40)),
        /sourceSha is invalid/u,
      ],
      [
        "package SHA",
        (value) => (value.node.packagedArtifact.sha256 = "D".repeat(64)),
        /sha256 is invalid/u,
      ],
      [
        "installed package SHA",
        (value) => (value.node.installedRuntime.packageSha256 = "D".repeat(64)),
        /packageSha256 is invalid/u,
      ],
      [
        "runtime identity",
        (value) => (value.node.installedRuntime.identitySha256 = "z".repeat(64)),
        /identitySha256 is invalid/u,
      ],
      [
        "Actions digest",
        (value) => (value.gateway.packagedArtifact.actionsArtifact.digest = "b".repeat(64)),
        /digest is invalid/u,
      ],
    ];
    for (const [_label, mutate, message] of invalidCases) {
      const evidence = validPassEvidence();
      mutate(evidence);
      expect(() => validateGatewayNodeCompatEvidence(evidence)).toThrow(message);
    }
  });

  it("requires complete positive Actions artifact binding", () => {
    for (const [field, value] of [
      ["id", 0],
      ["sizeBytes", 0],
      ["runAttempt", 0],
      ["runId", "01"],
    ] as const) {
      const evidence = validPassEvidence();
      evidence.gateway.packagedArtifact.actionsArtifact[field] = value;
      expect(() => validateGatewayNodeCompatEvidence(evidence)).toThrow(
        /positive integer|is invalid/u,
      );
    }

    for (const name of ["../candidate", "artifact/candidate", "artifact\\candidate", ".", ".."]) {
      const evidence = validPassEvidence();
      evidence.gateway.packagedArtifact.actionsArtifact.name = name;
      expect(() => validateGatewayNodeCompatEvidence(evidence)).toThrow(/must be a basename/u);
    }
  });

  it("binds the installed runtime to its package while keeping runtime identity distinct", () => {
    const version = validPassEvidence();
    version.node.installedRuntime.version = "v2026.8.6";
    expect(() => validateGatewayNodeCompatEvidence(version)).toThrow(
      /installedRuntime.version must match packaged artifact version/u,
    );

    const source = validPassEvidence();
    source.gateway.installedRuntime.sourceSha = "f".repeat(40);
    expect(() => validateGatewayNodeCompatEvidence(source)).toThrow(
      /installedRuntime.sourceSha must match packaged artifact sourceSha/u,
    );

    const packageDigest = validPassEvidence();
    packageDigest.gateway.installedRuntime.packageSha256 = "f".repeat(64);
    expect(() => validateGatewayNodeCompatEvidence(packageDigest)).toThrow(
      /installedRuntime.packageSha256 must match packaged artifact sha256/u,
    );

    const distinctIdentity = validPassEvidence();
    expect(distinctIdentity.gateway.installedRuntime.identitySha256).not.toBe(
      distinctIdentity.gateway.packagedArtifact.sha256,
    );
    expect(validateGatewayNodeCompatEvidence(distinctIdentity)).toBe(distinctIdentity);
  });

  it("requires positive ordered observed protocol fields", () => {
    const zero = validPassEvidence();
    zero.protocol.gatewayProtocolVersion = 0;
    expect(() => validateGatewayNodeCompatEvidence(zero)).toThrow(/positive integer/u);

    const gatewayRange = validPassEvidence();
    gatewayRange.protocol.gatewayAcceptedNodeMin = 5;
    expect(() => validateGatewayNodeCompatEvidence(gatewayRange)).toThrow(
      /must equal protocol.gatewayProtocolVersion or its N-1 floor/u,
    );

    const nodeRange = validPassEvidence();
    nodeRange.protocol.protocolClientAdvertisedMin = 4;
    nodeRange.protocol.protocolClientAdvertisedMax = 3;
    expect(() => validateGatewayNodeCompatEvidence(nodeRange)).toThrow(
      /must not exceed protocol.protocolClientAdvertisedMax/u,
    );
  });

  it.each([
    ["above the current protocol", 5, 5],
    ["below the accepted node floor", 1, 2],
  ])("rejects passed evidence advertising a range %s", (_label, minProtocol, maxProtocol) => {
    const evidence = validPassEvidence();
    evidence.protocol.protocolClientAdvertisedMin = minProtocol;
    evidence.protocol.protocolClientAdvertisedMax = maxProtocol;

    expect(() => validateGatewayNodeCompatEvidence(evidence)).toThrow(
      /passed evidence requires the advertised protocol range to include an accepted Gateway protocol/u,
    );
  });

  it.each([
    ["the accepted node floor", 3, 3],
    ["the current protocol", 4, 4],
    ["both accepted protocols", 3, 4],
  ])("rejects protocol-mismatch evidence advertising %s", (_label, minProtocol, maxProtocol) => {
    const evidence = validMismatchEvidence();
    evidence.protocol.protocolClientAdvertisedMin = minProtocol;
    evidence.protocol.protocolClientAdvertisedMax = maxProtocol;

    expect(() => validateGatewayNodeCompatEvidence(evidence)).toThrow(
      /protocol-mismatch evidence requires the advertised protocol range to exclude accepted Gateway protocols/u,
    );
  });

  it.each([
    ["the accepted node floor", 3, 3],
    ["the current protocol", 4, 4],
    ["both accepted protocols", 3, 4],
  ])("accepts passed evidence advertising %s", (_label, minProtocol, maxProtocol) => {
    const evidence = validPassEvidence();
    evidence.protocol.protocolClientAdvertisedMin = minProtocol;
    evidence.protocol.protocolClientAdvertisedMax = maxProtocol;

    expect(validateGatewayNodeCompatEvidence(evidence)).toBe(evidence);
  });

  it("rejects desktop pass evidence without a matching hello and successful system.which invoke", () => {
    const staleHello = validPassEvidence();
    staleHello.protocol.helloProtocol = 3;
    expect(() => validateGatewayNodeCompatEvidence(staleHello)).toThrow(
      /helloProtocol to equal gatewayProtocolVersion/u,
    );

    for (const [mutate, message] of [
      [(value: Record<string, any>) => (value.operation = null), /operation must be an object/u],
      [
        (value: Record<string, any>) => (value.operation.method = "gateway.status"),
        /method must be node.invoke/u,
      ],
      [
        (value: Record<string, any>) => (value.operation.command = "system.run"),
        /linux nodes require operation.command system.which/u,
      ],
      [
        (value: Record<string, any>) => (value.operation.params.bins = []),
        /must contain 1 to 32 requested binaries/u,
      ],
      [
        (value: Record<string, any>) => (value.operation.params.bins = ["node", "node"]),
        /must not contain duplicates/u,
      ],
      [(value: Record<string, any>) => (value.operation.ok = false), /operation.ok must be true/u],
      [
        (value: Record<string, any>) => (value.operation.result.bins = {}),
        /must contain 1 to 32 resolved binaries/u,
      ],
      [
        (value: Record<string, any>) => (value.operation.result.bins.node = ""),
        /bounded non-control string/u,
      ],
      [
        (value: Record<string, any>) => (value.operation.result.bins = { bun: "/usr/bin/bun" }),
        /was not requested/u,
      ],
    ] as const) {
      const evidence = validPassEvidence();
      mutate(evidence);
      expect(() => validateGatewayNodeCompatEvidence(evidence)).toThrow(message);
    }
  });

  it.each([
    ["android", "openclaw-android"],
    ["ios", "openclaw-ios"],
  ] as const)("requires a successful device.info invoke for %s pass evidence", (kind, clientId) => {
    const evidence = validPassEvidence();
    setNodeKind(evidence, kind, clientId);
    expect(validateGatewayNodeCompatEvidence(evidence)).toBe(evidence);

    const desktopOperation = clone(evidence);
    desktopOperation.operation = clone(validPassEvidence().operation);
    expect(() => validateGatewayNodeCompatEvidence(desktopOperation)).toThrow(
      new RegExp(`${kind} nodes require operation\\.command device\\.info`, "u"),
    );

    const extraParams = clone(evidence);
    extraParams.operation.params.notificationPermission = "denied";
    expect(() => validateGatewayNodeCompatEvidence(extraParams)).toThrow(
      /operation.params.notificationPermission is not allowed/u,
    );

    const emptySystemName = clone(evidence);
    emptySystemName.operation.result.systemName = "";
    expect(() => validateGatewayNodeCompatEvidence(emptySystemName)).toThrow(
      /operation.result.systemName must be a bounded non-control string/u,
    );

    const payload = clone(evidence);
    delete payload.operation.result.systemVersion;
    expect(() => validateGatewayNodeCompatEvidence(payload)).toThrow(
      /operation.result.systemVersion is required/u,
    );
  });

  it.each([
    ["android", "openclaw-android"],
    ["ios", "openclaw-ios"],
  ] as const)(
    "does not require notification permission for %s compatibility evidence",
    (kind, clientId) => {
      const evidence = validPassEvidence();
      setNodeKind(evidence, kind, clientId);

      expect(evidence.operation.command).toBe("device.info");
      expect(evidence.operation.params).toEqual({});
      expect(validateGatewayNodeCompatEvidence(evidence)).toBe(evidence);
    },
  );

  it("rejects false-green protocol mismatch evidence", () => {
    const hello = validMismatchEvidence();
    hello.protocol.helloProtocol = 4;
    expect(() => validateGatewayNodeCompatEvidence(hello)).toThrow(/helloProtocol to be null/u);

    const operation = validMismatchEvidence();
    operation.operation = clone(validPassEvidence().operation);
    expect(() => validateGatewayNodeCompatEvidence(operation)).toThrow(/operation to be null/u);

    const code = validMismatchEvidence();
    code.result.failureCode = "AUTH_FAILED";
    expect(() => validateGatewayNodeCompatEvidence(code)).toThrow(/PROTOCOL_MISMATCH/u);

    const phase = validMismatchEvidence();
    phase.result.failurePhase = "websocket-handshake";
    expect(() => validateGatewayNodeCompatEvidence(phase)).toThrow(/failurePhase connect/u);

    const missingCode = validMismatchEvidence();
    delete missingCode.result.failureCode;
    expect(() => validateGatewayNodeCompatEvidence(missingCode)).toThrow(
      /result.failureCode is required/u,
    );
  });

  it("requires the accepted node floor to be the Gateway protocol or N-1", () => {
    const staleFloor = validPassEvidence();
    staleFloor.protocol.gatewayAcceptedNodeMin = 1;
    staleFloor.protocol.protocolClientAdvertisedMin = 1;
    staleFloor.protocol.protocolClientAdvertisedMax = 1;
    expect(() => validateGatewayNodeCompatEvidence(staleFloor)).toThrow(
      /must equal protocol\.gatewayProtocolVersion or its N-1 floor/u,
    );

    const currentOnly = validPassEvidence();
    currentOnly.protocol.gatewayAcceptedNodeMin = 4;
    currentOnly.protocol.protocolClientAdvertisedMin = 4;
    currentOnly.protocol.protocolClientAdvertisedMax = 4;
    expect(validateGatewayNodeCompatEvidence(currentOnly)).toBe(currentOnly);

    const versionThree = validBaselineMismatchEvidence();
    expect(validateGatewayNodeCompatEvidence(versionThree)).toBe(versionThree);
  });

  it("requires canonical ordered timestamps", () => {
    const nonCanonical = validPassEvidence();
    nonCanonical.result.startedAt = "2026-08-06T12:00:00Z";
    expect(() => validateGatewayNodeCompatEvidence(nonCanonical)).toThrow(
      /canonical ISO timestamp/u,
    );

    const reversed = validPassEvidence();
    reversed.result.completedAt = "2026-08-06T11:59:59.000Z";
    expect(() => validateGatewayNodeCompatEvidence(reversed)).toThrow(/must not precede/u);

    const extremeYears = validPassEvidence();
    extremeYears.result.startedAt = "+010000-01-01T00:00:00.000Z";
    extremeYears.result.completedAt = "-000001-01-01T00:00:00.000Z";
    expect(() => validateGatewayNodeCompatEvidence(extremeYears)).toThrow(/must not precede/u);
  });

  it("rejects invalid producer identity fields", () => {
    for (const repositoryValue of [
      "openclaw",
      "openclaw/",
      "/openclaw",
      "openclaw/..",
      "./openclaw",
      "owner//repo",
      "owner/repo/extra",
      "owner\\repo",
    ]) {
      const repository = validPassEvidence();
      repository.producer.repository = repositoryValue;
      expect(() => validateGatewayNodeCompatEvidence(repository)).toThrow(/producer.repository/u);
    }

    for (const workflowPath of [
      "../workflow.yml",
      ".github/workflows//release.yml",
      ".github/workflows/./release.yml",
      ".github/workflows/../release.yml",
      ".github\\workflows\\release.yml",
      ".github/workflows/release.json",
    ]) {
      const workflow = validPassEvidence();
      workflow.producer.workflowPath = workflowPath;
      expect(() => validateGatewayNodeCompatEvidence(workflow)).toThrow(/producer.workflowPath/u);
    }

    const run = validPassEvidence();
    run.producer.runId = "01";
    expect(() => validateGatewayNodeCompatEvidence(run)).toThrow(/producer.runId is invalid/u);
  });

  it("canonicalizes to exact deterministic fixture bytes", () => {
    const evidence = validPassEvidence();
    const shuffled = {
      result: clone(evidence.result),
      protocol: clone(evidence.protocol),
      node: clone(evidence.node),
      schema: evidence.schema,
      producer: clone(evidence.producer),
      operation: clone(evidence.operation),
      gateway: clone(evidence.gateway),
      direction: evidence.direction,
      connection: clone(evidence.connection),
      caseId: evidence.caseId,
    };

    const canonical = canonicalizeGatewayNodeCompatEvidence(shuffled);
    const expected = `{
  "caseId": "linux-x64-candidate-gateway-baseline-node",
  "connection": {
    "mode": "node",
    "role": "node",
    "transport": "gateway-websocket"
  },
  "direction": "candidate-gateway-baseline-node",
  "gateway": {
    "installedRuntime": {
      "identitySha256": "2222222222222222222222222222222222222222222222222222222222222222",
      "packageSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "version": "v2026.8.6"
    },
    "packagedArtifact": {
      "actionsArtifact": {
        "digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        "id": 1111,
        "name": "openclaw-candidate.tgz-input",
        "runAttempt": 2,
        "runId": "111111111",
        "sizeBytes": 4096
      },
      "name": "openclaw-candidate.tgz",
      "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "version": "v2026.8.6"
    }
  },
  "node": {
    "architecture": "x64",
    "installedRuntime": {
      "identitySha256": "4444444444444444444444444444444444444444444444444444444444444444",
      "packageSha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      "sourceSha": "cccccccccccccccccccccccccccccccccccccccc",
      "version": "v2026.5.7"
    },
    "kind": "linux",
    "packagedArtifact": {
      "actionsArtifact": {
        "digest": "sha256:3333333333333333333333333333333333333333333333333333333333333333",
        "id": 3333,
        "name": "openclaw-baseline.tgz-input",
        "runAttempt": 2,
        "runId": "333333333",
        "sizeBytes": 4096
      },
      "name": "openclaw-baseline.tgz",
      "sha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      "sourceSha": "cccccccccccccccccccccccccccccccccccccccc",
      "version": "v2026.5.7"
    },
    "protocolClientId": "node-host"
  },
  "operation": {
    "command": "system.which",
    "method": "node.invoke",
    "ok": true,
    "params": {
      "bins": [
        "node"
      ]
    },
    "result": {
      "bins": {
        "node": "/usr/bin/node"
      }
    }
  },
  "producer": {
    "job": "gateway-node-compat-linux-x64",
    "repository": "openclaw/openclaw",
    "runAttempt": 2,
    "runId": "123456789",
    "workflowPath": ".github/workflows/openclaw-cross-os-release-checks-reusable.yml",
    "workflowSha": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  },
  "protocol": {
    "gatewayAcceptedNodeMin": 3,
    "gatewayProtocolVersion": 4,
    "helloProtocol": 4,
    "protocolClientAdvertisedMax": 3,
    "protocolClientAdvertisedMin": 3
  },
  "result": {
    "completedAt": "2026-08-06T12:00:05.000Z",
    "outcome": "passed",
    "startedAt": "2026-08-06T12:00:00.000Z"
  },
  "schema": "openclaw.gateway-node-compat/v1"
}
`;

    expect(Buffer.from(canonical)).toEqual(Buffer.from(expected));
    expect(canonicalizeGatewayNodeCompatEvidence(JSON.parse(canonical))).toBe(canonical);
  });

  it.each([
    ["root caseId", (value: Record<string, any>) => value, "caseId"],
    [
      "nested protocol floor",
      (value: Record<string, any>) => value.protocol,
      "gatewayAcceptedNodeMin",
    ],
  ] as const)("rejects a non-enumerable required %s", (_label, selectOwner, key) => {
    const evidence = validPassEvidence();
    const owner = selectOwner(evidence);
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    Object.defineProperty(owner, key, {
      ...descriptor,
      enumerable: false,
    });

    expect(() => validateGatewayNodeCompatEvidence(evidence)).toThrow(
      new RegExp(`${key} must be enumerable`, "u"),
    );
  });

  it("rejects accessor-backed required evidence before canonicalization", () => {
    const evidence = validPassEvidence();
    const caseId = evidence.caseId;
    let getterCalls = 0;
    Object.defineProperty(evidence, "caseId", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return caseId;
      },
    });

    expect(() => canonicalizeGatewayNodeCompatEvidence(evidence)).toThrow(
      /caseId must be a JSON data property/u,
    );
    expect(getterCalls).toBe(0);
  });

  it.each([
    [
      "requested binary",
      (evidence: Record<string, any>, getter: () => string) => {
        Object.defineProperty(evidence.operation.params.bins, "0", {
          enumerable: true,
          get: getter,
        });
      },
      /operation\.params\.bins\.0 must be a JSON data property/u,
    ],
    [
      "resolved binary",
      (evidence: Record<string, any>, getter: () => string) => {
        Object.defineProperty(evidence.operation.result.bins, "node", {
          enumerable: true,
          get: getter,
        });
      },
      /operation\.result\.bins\.node must be a JSON data property/u,
    ],
  ] as const)("rejects an accessor-backed %s without invoking it", (_label, install, message) => {
    const evidence = validPassEvidence();
    let getterCalls = 0;
    install(evidence, () => {
      getterCalls += 1;
      return "node";
    });

    expect(() => canonicalizeGatewayNodeCompatEvidence(evidence)).toThrow(message);
    expect(getterCalls).toBe(0);
  });

  it("rejects inherited serialization hooks without invoking them", () => {
    const evidence = validPassEvidence();
    let hookCalls = 0;
    Object.setPrototypeOf(evidence.operation.result.bins, {
      toJSON: () => {
        hookCalls += 1;
        return evidence.operation.result.bins;
      },
    });

    expect(() => canonicalizeGatewayNodeCompatEvidence(evidence)).toThrow(
      /operation\.result\.bins must use a plain JSON data container/u,
    );
    expect(hookCalls).toBe(0);
  });

  it("rejects array serialization hooks inherited through Object.prototype", () => {
    let hookCalls = 0;
    const priorDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    Reflect.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value: () => {
        hookCalls += 1;
        return [];
      },
    });
    try {
      expect(() => canonicalizeGatewayNodeCompatEvidence([])).toThrow(
        /gateway-node compatibility evidence must not inherit a JSON serialization hook/u,
      );
      expect(hookCalls).toBe(0);
    } finally {
      if (priorDescriptor) {
        Reflect.defineProperty(Object.prototype, "toJSON", priorDescriptor);
      } else {
        Reflect.deleteProperty(Object.prototype, "toJSON");
      }
    }
  });

  it("rejects proxies without invoking reflection traps", () => {
    const evidence = validPassEvidence();
    let trapCalls = 0;
    evidence.operation.result.bins = new Proxy(evidence.operation.result.bins, {
      getPrototypeOf: (target) => {
        trapCalls += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys: (target) => {
        trapCalls += 1;
        return Reflect.ownKeys(target);
      },
    });

    expect(() => canonicalizeGatewayNodeCompatEvidence(evidence)).toThrow(
      /operation\.result\.bins must use a plain JSON data container/u,
    );
    expect(trapCalls).toBe(0);
  });

  it("rejects non-JSON required values before canonicalization", () => {
    const evidence = validPassEvidence();
    evidence.caseId = undefined;

    expect(() => canonicalizeGatewayNodeCompatEvidence(evidence)).toThrow(
      /caseId must be JSON representable/u,
    );
  });

  it("rejects required evidence inherited from a prototype", () => {
    const evidence = validPassEvidence();
    const inheritedCaseId = evidence.caseId;
    delete evidence.caseId;
    Object.setPrototypeOf(evidence, { caseId: inheritedCaseId });

    expect(() => canonicalizeGatewayNodeCompatEvidence(evidence)).toThrow(
      /must use a plain JSON data container/u,
    );
  });

  it("enforces the 64 KiB input limit", () => {
    const evidence = validPassEvidence();
    evidence.gateway.packagedArtifact.version = "x".repeat(65 * 1024);

    expect(() => validateGatewayNodeCompatEvidence(evidence)).toThrow(/exceeds 65536 bytes/u);
  });

  it("rejects compact input whose canonical form exceeds 64 KiB", () => {
    const evidence = validPassEvidence();
    const bins = Array.from({ length: 16 }, (_, index) => `node-${index}`);
    evidence.operation.params.bins = bins;
    evidence.operation.result.bins = Object.fromEntries(
      bins.map((bin, index) => [bin, `/tmp/${"x".repeat(3_881)}-${index}`]),
    );
    const compact = JSON.stringify(evidence);
    const pretty = `${JSON.stringify(evidence, null, 2)}\n`;

    expect(Buffer.byteLength(compact)).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(pretty)).toBeGreaterThan(64 * 1024);
    expect(() => validateGatewayNodeCompatEvidence(evidence)).toThrow(/exceeds 65536 bytes/u);

    const root = makeTempRoot();
    const inputPath = path.join(root, "compact.json");
    const outputPath = path.join(root, "canonical.json");
    writeFileSync(inputPath, compact, "utf8");

    const result = runCli(["canonicalize", "--input", inputPath, "--output", outputPath]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("exceeds 65536 bytes");
    expect(() => readFileSync(outputPath, "utf8")).toThrow();
  });

  it("validates and canonicalizes evidence through the CLI", () => {
    const root = makeTempRoot();
    const inputPath = path.join(root, "input.json");
    const outputPath = path.join(root, "output.json");
    writeFileSync(inputPath, JSON.stringify(validPassEvidence()), "utf8");

    const validateResult = runCli(["validate", inputPath]);
    expect(validateResult.status).toBe(0);
    expect(validateResult.stdout).toBe("valid\n");
    expect(validateResult.stderr).toBe("");

    const canonicalizeResult = runCli([
      "canonicalize",
      "--output",
      outputPath,
      "--input",
      inputPath,
    ]);
    expect(canonicalizeResult.status).toBe(0);
    expect(canonicalizeResult.stdout).toBe("");
    expect(canonicalizeResult.stderr).toBe("");
    expect(readFileSync(outputPath, "utf8")).toBe(
      canonicalizeGatewayNodeCompatEvidence(validPassEvidence()),
    );
  });

  it("rejects malformed UTF-8 bytes during CLI validation", () => {
    const inputPath = writeMalformedUtf8Evidence(makeTempRoot());

    const result = runCli(["validate", inputPath]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must be valid UTF-8");
  });

  it("rejects malformed UTF-8 bytes before CLI canonicalization writes output", () => {
    const root = makeTempRoot();
    const inputPath = writeMalformedUtf8Evidence(root);
    const outputPath = path.join(root, "canonical.json");

    const result = runCli(["canonicalize", "--input", inputPath, "--output", outputPath]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must be valid UTF-8");
    expect(() => readFileSync(outputPath, "utf8")).toThrow(/ENOENT/u);
  });

  it("atomically canonicalizes when input and output are the same file", () => {
    const root = makeTempRoot();
    const evidencePath = path.join(root, "evidence.json");
    writeFileSync(evidencePath, JSON.stringify(validPassEvidence()), "utf8");

    const result = runCli(["canonicalize", "--input", evidencePath, "--output", evidencePath]);

    expect(result.status).toBe(0);
    expect(readFileSync(evidencePath, "utf8")).toBe(
      canonicalizeGatewayNodeCompatEvidence(validPassEvidence()),
    );
    expect(readdirSync(root).filter((entry) => entry.includes(".tmp-"))).toEqual([]);
  });

  it("preserves an existing destination when validation fails", () => {
    const root = makeTempRoot();
    const inputPath = path.join(root, "invalid.json");
    const outputPath = path.join(root, "evidence.json");
    const invalid = validPassEvidence();
    invalid.operation.ok = false;
    writeFileSync(inputPath, JSON.stringify(invalid), "utf8");
    writeFileSync(outputPath, "existing evidence\n", "utf8");

    const result = runCli(["canonicalize", "--input", inputPath, "--output", outputPath]);

    expect(result.status).not.toBe(0);
    expect(readFileSync(outputPath, "utf8")).toBe("existing evidence\n");
    expect(readdirSync(root).filter((entry) => entry.includes(".tmp-"))).toEqual([]);
  });

  it("cleans the same-directory temp file when atomic replacement fails", () => {
    const root = makeTempRoot();
    const inputPath = path.join(root, "input.json");
    const outputPath = path.join(root, "destination");
    const markerPath = path.join(outputPath, "marker.txt");
    writeFileSync(inputPath, JSON.stringify(validPassEvidence()), "utf8");
    mkdirSync(outputPath);
    writeFileSync(markerPath, "keep\n", "utf8");

    const result = runCli(["canonicalize", "--input", inputPath, "--output", outputPath]);

    expect(result.status).not.toBe(0);
    expect(readFileSync(markerPath, "utf8")).toBe("keep\n");
    expect(readdirSync(root).filter((entry) => entry.includes(".tmp-"))).toEqual([]);
  });

  it("requires CLI input to be a regular file", () => {
    const root = makeTempRoot();

    const result = runCli(["validate", root]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("input must be a regular file");
  });

  it.skipIf(process.platform === "win32")("rejects symlink CLI input", () => {
    const root = makeTempRoot();
    const targetPath = path.join(root, "target.json");
    const inputPath = path.join(root, "input.json");
    writeFileSync(targetPath, JSON.stringify(validPassEvidence()), "utf8");
    symlinkSync(targetPath, inputPath);

    const result = runCli(["validate", inputPath]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("input must be a regular file");
  });

  it.skipIf(process.platform === "win32")("rejects FIFO CLI input without blocking", () => {
    const root = makeTempRoot();
    const inputPath = path.join(root, "evidence.json");
    const makeFifo = spawnSync("mkfifo", [inputPath], { encoding: "utf8" });
    expect(makeFifo.status).toBe(0);

    const result = runCli(["validate", inputPath], 1_000);

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("input must be a regular file");
  });

  it("rejects oversized CLI input before parsing", () => {
    const root = makeTempRoot();
    const inputPath = path.join(root, "oversized.json");
    writeFileSync(inputPath, `${JSON.stringify(validPassEvidence())}${" ".repeat(65 * 1024)}`);

    const result = runCli(["validate", inputPath]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("exceeds 65536 bytes");
  });

  it("prints one stack-free error line for CLI failures", () => {
    const root = makeTempRoot();
    const inputPath = path.join(root, "invalid.json");
    writeFileSync(inputPath, "{\nnot-json\n", "utf8");

    const result = runCli(["validate", inputPath]);
    const lines = result.stderr.trimEnd().split("\n");

    expect(result.status).not.toBe(0);
    expect(lines).toHaveLength(1);
    expect(result.stderr).not.toContain("\n    at ");
  });

  it("sanitizes terminal controls from attacker-controlled CLI errors", () => {
    const root = makeTempRoot();
    const inputPath = path.join(root, "invalid.json");
    const invalid = validPassEvidence();
    invalid["owned\u001b]0;gateway evidence\u0007\u009b31m\u007f\u2028\u2029"] = true;
    writeFileSync(inputPath, JSON.stringify(invalid), "utf8");

    const result = runCli(["validate", inputPath]);
    const errorLine = result.stderr.trimEnd();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe(`${errorLine}\n`);
    expect(errorLine.length).toBeLessThanOrEqual(512);
    expect(
      Array.from(errorLine).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return (
          codePoint <= 0x1f ||
          (codePoint >= 0x7f && codePoint <= 0x9f) ||
          codePoint === 0x2028 ||
          codePoint === 0x2029
        );
      }),
    ).toBe(false);
    expect(errorLine).toContain("gateway evidence");
  });

  it("keeps declaration value exports aligned with runtime exports", () => {
    const declaration = readFileSync("scripts/gateway-node-compat-evidence.d.mts", "utf8");
    const declaredValueExports = Array.from(
      declaration.matchAll(/export (?:declare )?(?:const|function) ([A-Za-z0-9_]+)/gu),
      (match) => match[1] ?? "",
    ).toSorted(compareStrings);

    expect(Object.keys(evidenceModule).toSorted(compareStrings)).toEqual(declaredValueExports);
  });
});
