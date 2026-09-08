import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MOBILE_PAIRING_AUDIT_CLIENT,
  MOBILE_PAIRING_APPROVAL_SCOPES,
  MOBILE_PAIRING_CLIENT,
  MOBILE_PAIRING_NODE_CAPS,
  MOBILE_PAIRING_NODE_COMMANDS,
  MOBILE_PAIRING_NODE_PERMISSIONS,
  MOBILE_PAIRING_OPERATOR_CAPS,
  approveBaselineNodePairing,
  assertGatewayHealth,
  attemptConnect,
  buildConnectRequest,
  buildDeviceAuthCompatibilityPayloadV2,
  buildRedactedEvidence,
  createMobilePairingIdentity,
  extractBootstrapCredentials,
  inspectBaselineNodePairing,
  parseConnectChallengePayload,
  parseQrBootstrapJson,
  persistHelloCredential,
  validatePairingAudit,
  verifyDeviceAuthPayloadSignature,
} from "../../scripts/e2e/lib/upgrade-survivor/mobile-pairing-client.mts";

const CLIENT_PATH = "scripts/e2e/lib/upgrade-survivor/mobile-pairing-client.mts";
const RUNNER_PATH = "scripts/e2e/lib/upgrade-survivor/run.sh";

afterEach(() => {
  vi.useRealTimers();
});

function tokenHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function bootstrapHello(nodeToken: string, operatorToken: string) {
  return {
    type: "hello-ok",
    auth: {
      role: "node",
      scopes: [],
      deviceToken: nodeToken,
      deviceTokens: [
        {
          role: "operator",
          scopes: [
            "operator.approvals",
            "operator.read",
            "operator.talk.secrets",
            "operator.write",
          ],
          deviceToken: operatorToken,
          issuedAtMs: 1,
        },
      ],
    },
  };
}

describe("upgrade survivor mobile pairing client", () => {
  it("closes the WebSocket when the connect response times out", async () => {
    vi.useFakeTimers();
    class SilentResponseSocket extends EventEmitter {
      static CLOSED = 3;
      static instances: SilentResponseSocket[] = [];
      readyState = 0;
      closeCalls = 0;

      constructor(_url: string) {
        super();
        SilentResponseSocket.instances.push(this);
        queueMicrotask(() => {
          this.readyState = 1;
          this.emit("open");
          this.emit(
            "message",
            JSON.stringify({
              type: "event",
              event: "connect.challenge",
              payload: { nonce: "nonce-timeout", ts: 1_700_000_000_000 },
            }),
          );
        });
      }

      send(_value: string): void {}

      close(): void {
        this.closeCalls += 1;
        this.readyState = SilentResponseSocket.CLOSED;
        this.emit("close", 1000);
      }
    }

    const connectAttempt = expect(
      attemptConnect({
        WebSocket: SilentResponseSocket,
        url: "ws://127.0.0.1:18789",
        client: MOBILE_PAIRING_CLIENT,
        mode: "node",
        role: "node",
        scopes: [],
      }),
    ).rejects.toThrow("Gateway response timed out");
    await vi.advanceTimersByTimeAsync(15_000);
    await connectAttempt;

    expect(SilentResponseSocket.instances).toHaveLength(1);
    expect(SilentResponseSocket.instances[0]?.closeCalls).toBe(1);
    expect(SilentResponseSocket.instances[0]?.readyState).toBe(SilentResponseSocket.CLOSED);
  });

  it("requires the Gateway health RPC to report ok", () => {
    expect(() => assertGatewayHealth({ ok: true })).not.toThrow();
    expect(() => assertGatewayHealth({ ok: false })).toThrow(/health response invalid/);
    expect(() => assertGatewayHealth({})).toThrow(/health response invalid/);
  });

  it("uses the node approval CLI backend identity for pairing audits", () => {
    expect(MOBILE_PAIRING_AUDIT_CLIENT).toMatchObject({
      id: "gateway-client",
      version: MOBILE_PAIRING_CLIENT.version,
      instanceId: "c0202128-dbd7-42a5-a8ac-aaf20dc14c9c",
    });
    const request = buildConnectRequest({
      challengePayload: { nonce: "nonce-audit", ts: 1_700_000_000_000 },
      client: MOBILE_PAIRING_AUDIT_CLIENT,
      mode: "backend",
      role: "operator",
      scopes: ["operator.pairing"],
      auth: { password: "audit-password" },
    });
    expect(request.params).toMatchObject({
      client: { id: "gateway-client", mode: "backend" },
      role: "operator",
      scopes: ["operator.pairing"],
      auth: { password: "audit-password" },
    });
    expect(request.params).not.toHaveProperty("device");
  });

  it("pins the shipped iOS 2026.8.10 V2 compatibility payload bytes", () => {
    expect(
      buildDeviceAuthCompatibilityPayloadV2({
        deviceId: "dev-1",
        clientId: "openclaw-ios",
        clientMode: "ui",
        role: "operator",
        scopes: ["operator.read", "operator.write"],
        signedAtMs: 1_700_000_000_001,
        token: "operator-token",
        nonce: "nonce-1",
      }),
    ).toBe(
      "v2|dev-1|openclaw-ios|ui|operator|operator.read,operator.write|1700000000001|operator-token|nonce-1",
    );
  });

  it("uses shipped protocol ranges, challenge time, instance id, and auth.token", () => {
    const identity = createMobilePairingIdentity();
    const challengePayload = { nonce: " nonce-1 ", ts: 1_700_000_000_001 };
    const nodeRequest = buildConnectRequest({
      id: "connect-1",
      challengePayload,
      client: MOBILE_PAIRING_CLIENT,
      mode: "node",
      role: "node",
      scopes: [],
      auth: { token: "node-token" },
      identity,
    });
    const operatorRequest = buildConnectRequest({
      id: "connect-2",
      challengePayload,
      client: MOBILE_PAIRING_CLIENT,
      mode: "ui",
      role: "operator",
      scopes: ["operator.read"],
      auth: { token: "operator-token" },
      identity,
    });
    const nodeParams = nodeRequest.params as {
      minProtocol: number;
      maxProtocol: number;
      client: Record<string, string>;
      caps: string[];
      commands: string[];
      permissions: Record<string, boolean>;
      locale: string;
      userAgent: string;
      auth: Record<string, string>;
      device: { nonce: string; signature: string; signedAt: number };
    };
    const operatorParams = operatorRequest.params as {
      minProtocol: number;
      maxProtocol: number;
      caps: string[];
      auth: Record<string, string>;
    };
    const payload = buildDeviceAuthCompatibilityPayloadV2({
      deviceId: identity.deviceId,
      clientId: MOBILE_PAIRING_CLIENT.id,
      clientMode: "node",
      role: "node",
      scopes: [],
      signedAtMs: challengePayload.ts,
      token: "node-token",
      nonce: "nonce-1",
    });

    expect(nodeParams).toMatchObject({
      minProtocol: 3,
      maxProtocol: 4,
      client: { instanceId: MOBILE_PAIRING_CLIENT.instanceId },
      caps: MOBILE_PAIRING_NODE_CAPS,
      commands: MOBILE_PAIRING_NODE_COMMANDS,
      permissions: MOBILE_PAIRING_NODE_PERMISSIONS,
      locale: "en-US",
      userAgent: "Version 26.6.1",
      auth: { token: "node-token" },
      device: { nonce: "nonce-1", signedAt: challengePayload.ts },
    });
    expect(operatorParams).toMatchObject({
      minProtocol: 4,
      maxProtocol: 4,
      caps: ["inline-widgets"],
      auth: { token: "operator-token" },
    });
    expect(MOBILE_PAIRING_OPERATOR_CAPS).toEqual(["inline-widgets"]);
    expect(operatorParams).not.toHaveProperty("commands");
    expect(operatorParams).not.toHaveProperty("permissions");
    expect(nodeParams.auth).not.toHaveProperty("deviceToken");
    expect(operatorParams.auth).not.toHaveProperty("deviceToken");
    expect(
      verifyDeviceAuthPayloadSignature({
        publicKeyPem: identity.publicKeyPem,
        payload,
        signature: nodeParams.device.signature,
      }),
    ).toBe(true);
  });

  it("requires the connect.challenge timestamp used by the shipped client", () => {
    expect(parseConnectChallengePayload({ nonce: " nonce-1 ", ts: 1_700_000_000_123 })).toEqual({
      nonce: "nonce-1",
      issuedAtMs: 1_700_000_000_123,
    });
    for (const payload of [
      null,
      { nonce: "nonce-1" },
      { nonce: "nonce-1", ts: "1700000000123" },
      { nonce: "nonce-1", ts: -1 },
      { nonce: "nonce-1", ts: 1.5 },
      { nonce: " ", ts: 1_700_000_000_123 },
    ]) {
      expect(() => parseConnectChallengePayload(payload)).toThrow(/Gateway challenge/);
    }
  });

  it("parses the QR bootstrap and extracts both baseline-issued role credentials", () => {
    const nodeToken = "node-token-secret";
    const operatorToken = "operator-token-secret";
    const setupCode = Buffer.from(
      JSON.stringify({
        url: "ws://127.0.0.1:18789",
        bootstrapToken: "bootstrap-token-secret",
      }),
    ).toString("base64url");
    const identity = createMobilePairingIdentity();
    const bootstrap = parseQrBootstrapJson({ setupCode });
    const credentials = extractBootstrapCredentials({
      url: bootstrap.url,
      client: MOBILE_PAIRING_CLIENT,
      identity,
      hello: bootstrapHello(nodeToken, operatorToken),
    });

    expect(bootstrap).toEqual({
      url: "ws://127.0.0.1:18789",
      bootstrapToken: "bootstrap-token-secret",
    });
    expect(credentials.node).toEqual({ token: nodeToken, scopes: [] });
    expect(credentials.operator).toEqual({
      token: operatorToken,
      scopes: ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"],
    });
    expect(credentials.operator.scopes).not.toContain("operator.pairing");
    expect(credentials.operator.scopes).not.toContain("operator.admin");
    expect(credentials.client.instanceId).toBe(MOBILE_PAIRING_CLIENT.instanceId);
  });

  it("persists rotated hello tokens and uses the newest credential on the next reconnect", () => {
    const identity = createMobilePairingIdentity();
    const credentials = extractBootstrapCredentials({
      url: "ws://127.0.0.1:18789",
      client: MOBILE_PAIRING_CLIENT,
      identity,
      hello: bootstrapHello("node-token-1", "operator-token-1"),
    });
    const nodeTransition = persistHelloCredential({
      credentials,
      role: "node",
      hello: {
        type: "hello-ok",
        auth: {
          role: "node",
          scopes: [],
          deviceToken: "node-token-2",
        },
      },
    });
    const nextRequest = buildConnectRequest({
      challengePayload: { nonce: "nonce-2", ts: 1_700_000_000_002 },
      client: MOBILE_PAIRING_CLIENT,
      mode: "node",
      role: "node",
      scopes: credentials.node.scopes,
      auth: { token: credentials.node.token },
      identity,
    });
    const nextParams = nextRequest.params as { auth: Record<string, string> };

    expect(nodeTransition).toEqual({
      role: "node",
      scopes: [],
      usedTokenHash: tokenHash("node-token-1"),
      storedTokenHash: tokenHash("node-token-2"),
      deviceTokenReturned: true,
      tokenRotated: true,
    });
    expect(credentials.node).toEqual({ token: "node-token-2", scopes: [] });
    expect(nextParams.auth).toEqual({ token: "node-token-2" });
  });

  it("accepts only the known node authority expansion for the mobile identity", () => {
    const pairedNode = {
      nodeId: "device-1",
      commands: ["camera.snap"],
      caps: ["camera"],
      permissions: { camera: false, screenRecording: true },
    };
    const pendingNode = {
      ...pairedNode,
      commands: ["watch.status", "camera.snap", "watch.notify"],
    };
    expect(
      validatePairingAudit({
        devicePairing: { pending: [], paired: [{ deviceId: "device-1" }] },
        nodePairing: { pending: [], paired: [pairedNode] },
        deviceId: "device-1",
      }),
    ).toEqual({
      pendingDevicePairingCount: 0,
      pendingNodePairingCount: 0,
      pairedDevicePresent: true,
      pairedNodePresent: true,
      nodeSurfaceReapprovalRequired: false,
      nodeSurfaceCommandAdditions: [],
    });
    expect(
      validatePairingAudit({
        devicePairing: { pending: [], paired: [{ deviceId: "device-1" }] },
        nodePairing: { pending: [pendingNode], paired: [pairedNode] },
        deviceId: "device-1",
        expectKnownNodeSurfaceUpgrade: true,
      }),
    ).toEqual({
      pendingDevicePairingCount: 0,
      pendingNodePairingCount: 1,
      pairedDevicePresent: true,
      pairedNodePresent: true,
      nodeSurfaceReapprovalRequired: true,
      nodeSurfaceCommandAdditions: ["watch.notify", "watch.status"],
    });
    expect(() =>
      validatePairingAudit({
        devicePairing: { pending: [], paired: [{ deviceId: "device-1" }] },
        nodePairing: { pending: [pendingNode], paired: [pairedNode] },
        deviceId: "device-1",
      }),
    ).toThrow(/unexpected pending request/);
    for (const invalidPending of [
      { ...pendingNode, nodeId: "device-2" },
      { ...pendingNode, commands: ["camera.snap", "watch.status"] },
      { ...pendingNode, caps: ["camera", "microphone"] },
      { ...pendingNode, permissions: { camera: true, screenRecording: true } },
    ]) {
      expect(() =>
        validatePairingAudit({
          devicePairing: { pending: [], paired: [{ deviceId: "device-1" }] },
          nodePairing: { pending: [invalidPending], paired: [pairedNode] },
          deviceId: "device-1",
          expectKnownNodeSurfaceUpgrade: true,
        }),
      ).toThrow();
    }
    for (const narrowedPending of [
      { ...pendingNode, commands: ["watch.notify", "watch.status"] },
      { ...pendingNode, caps: [] },
      { ...pendingNode, permissions: { camera: false } },
    ]) {
      expect(() =>
        validatePairingAudit({
          devicePairing: { pending: [], paired: [{ deviceId: "device-1" }] },
          nodePairing: { pending: [narrowedPending], paired: [pairedNode] },
          deviceId: "device-1",
          expectKnownNodeSurfaceUpgrade: true,
        }),
      ).not.toThrow();
    }
    expect(() =>
      validatePairingAudit({
        devicePairing: { pending: [], paired: [{ deviceId: "device-1" }] },
        nodePairing: { pending: [pendingNode, pendingNode], paired: [pairedNode] },
        deviceId: "device-1",
        expectKnownNodeSurfaceUpgrade: true,
      }),
    ).toThrow(/unexpected pending request/);
    expect(() =>
      validatePairingAudit({
        devicePairing: { pending: [], paired: [{ deviceId: "device-1" }] },
        nodePairing: { pending: [], paired: [pairedNode] },
        deviceId: "device-1",
        expectKnownNodeSurfaceUpgrade: true,
      }),
    ).toThrow(/omitted the expected command-surface reapproval/);
  });

  it("completes legacy baseline node pairing only for the bootstrapped identity", async () => {
    const approvalRequest = buildConnectRequest({
      challengePayload: { nonce: "nonce-approval", ts: 1_700_000_000_003 },
      client: MOBILE_PAIRING_AUDIT_CLIENT,
      mode: "backend",
      role: "operator",
      scopes: [...MOBILE_PAIRING_APPROVAL_SCOPES],
      auth: { password: "approval-password" },
    });
    expect(approvalRequest.params).toMatchObject({
      client: { id: "gateway-client", mode: "backend" },
      role: "operator",
      scopes: ["operator.pairing", "operator.admin"],
      auth: { password: "approval-password" },
    });
    expect(approvalRequest.params).not.toHaveProperty("device");

    expect(
      inspectBaselineNodePairing(
        {
          pending: [{ requestId: "request-1", nodeId: "device-1" }],
          paired: [],
        },
        "device-1",
      ),
    ).toEqual({ pendingRequestId: "request-1", paired: false });
    expect(
      inspectBaselineNodePairing(
        {
          pending: [],
          paired: [{ nodeId: "device-1" }],
        },
        "device-1",
      ),
    ).toEqual({ pendingRequestId: null, paired: true });
    expect(() =>
      inspectBaselineNodePairing(
        {
          pending: [{ requestId: "request-other", nodeId: "device-2" }],
          paired: [],
        },
        "device-1",
      ),
    ).toThrow(/unexpected pending request/);

    const observed: string[] = [];
    const states = [
      { pending: [], paired: [] },
      { pending: [{ requestId: "request-1", nodeId: "device-1" }], paired: [] },
      { pending: [], paired: [{ nodeId: "device-1" }] },
    ];
    await approveBaselineNodePairing({
      deviceId: "device-1",
      listPairings: async () => {
        observed.push("list");
        return states.shift();
      },
      approvePairing: async (requestId) => {
        observed.push(`approve:${requestId}`);
      },
      wait: async () => {
        observed.push("wait");
      },
    });
    expect(observed).toEqual(["list", "wait", "list", "approve:request-1", "wait", "list"]);
  });

  it("emits only redacted reconnect evidence", () => {
    const nodeToken = "node-token-must-not-leak";
    const operatorToken = "operator-token-must-not-leak";
    const credentials = extractBootstrapCredentials({
      url: "ws://127.0.0.1:18789",
      client: MOBILE_PAIRING_CLIENT,
      identity: createMobilePairingIdentity(),
      hello: bootstrapHello(nodeToken, operatorToken),
    });
    const node = persistHelloCredential({
      credentials,
      role: "node",
      hello: {
        type: "hello-ok",
        auth: { role: "node", scopes: [], deviceToken: "rotated-node-token" },
      },
    });
    const operator = persistHelloCredential({
      credentials,
      role: "operator",
      hello: {
        type: "hello-ok",
        auth: {
          role: "operator",
          scopes: credentials.operator.scopes,
          deviceToken: operatorToken,
        },
      },
    });
    const serialized = JSON.stringify(
      buildRedactedEvidence({
        phase: "candidate-restart",
        credentials,
        node,
        operator,
        pairing: {
          pendingDevicePairingCount: 0,
          pendingNodePairingCount: 0,
          pairedDevicePresent: true,
          pairedNodePresent: true,
          nodeSurfaceReapprovalRequired: false,
          nodeSurfaceCommandAdditions: [],
        },
        expectKnownNodeSurfaceUpgrade: false,
      }),
    );

    expect(serialized).not.toContain(nodeToken);
    expect(serialized).not.toContain(operatorToken);
    expect(serialized).not.toContain(credentials.identity.privateKeyPem);
    expect(serialized).not.toContain(credentials.client.instanceId);
    expect(JSON.parse(serialized)).toMatchObject({
      phase: "candidate-restart",
      ok: true,
      connectedDevicePresent: true,
      pendingPairingCount: 0,
      pendingDevicePairingCount: 0,
      pendingNodePairingCount: 0,
      pairedDevicePresent: true,
      pairedNodePresent: true,
      nodeSurfaceReapprovalRequired: false,
      nodeSurfaceCommandAdditions: [],
      nodeSurfaceReapprovalExpected: false,
      missingPasswordReason: true,
      missingPasswordClose1008: true,
      credentials: {
        node: {
          usedTokenHash: tokenHash(nodeToken),
          storedTokenHash: tokenHash("rotated-node-token"),
          deviceTokenReturned: true,
          tokenRotated: true,
        },
        operator: {
          usedTokenHash: tokenHash(operatorToken),
          storedTokenHash: tokenHash(operatorToken),
          deviceTokenReturned: true,
          tokenRotated: false,
        },
      },
    });
  });

  it("keeps secrets out of CLI failures", () => {
    const password = "password-must-not-leak";
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "./scripts/tsx.mjs",
        CLIENT_PATH,
        "unknown",
        "--package-root",
        "/tmp/openclaw-package",
        "--credentials",
        "/tmp/openclaw-credentials.json",
        "--evidence",
        "/tmp/openclaw-evidence.json",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, GATEWAY_AUTH_PASSWORD_REF: password },
      },
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain(password);
    expect(result.stderr).toContain("unknown mobile pairing client command");
  });

  it("checks both candidate starts before Doctor and the final phase after Doctor", () => {
    const source = readFileSync(RUNNER_PATH, "utf8");
    const bootstrap = source.indexOf("phase bootstrap-mobile-pairing bootstrap_mobile_pairing");
    const update = source.indexOf("phase update-candidate update_candidate");
    const automaticMigration = source.indexOf("phase assert-automatic-migration assert_survival");
    const historicalPrestart = source.indexOf(
      "phase assert-historical-package-replacement-prestart",
    );
    const candidateFirst = source.indexOf("phase mobile-pairing-candidate-first");
    const historicalStartupRepair = source.indexOf(
      "phase assert-historical-package-replacement-startup-repair",
    );
    const candidateRestart = source.indexOf("phase mobile-pairing-candidate-restart");
    const doctor = source.indexOf("phase doctor run_doctor");
    const final = source.indexOf("phase mobile-pairing-final");

    expect(bootstrap).toBeGreaterThan(-1);
    expect(bootstrap).toBeLessThan(update);
    expect(update).toBeLessThan(automaticMigration);
    expect(automaticMigration).toBeLessThan(candidateFirst);
    expect(update).toBeLessThan(historicalPrestart);
    expect(historicalPrestart).toBeLessThan(candidateFirst);
    expect(update).toBeLessThan(candidateFirst);
    expect(candidateFirst).toBeLessThan(historicalStartupRepair);
    expect(historicalStartupRepair).toBeLessThan(candidateRestart);
    expect(candidateFirst).toBeLessThan(candidateRestart);
    expect(candidateRestart).toBeLessThan(doctor);
    expect(doctor).toBeLessThan(final);
  });

  it("uses npm package-manager replacement only for the exact shipped 7.1 to 8.1 row", () => {
    const source = readFileSync(RUNNER_PATH, "utf8");
    expect(source).toContain('[ "$SCENARIO" = "mobile-pairing-reconnect" ]');
    expect(source).toContain('[ "$baseline_version" = "2026.7.1" ]');
    expect(source).toContain('[ "$candidate_version" = "2026.8.1" ]');
    expect(source).toContain(
      'HISTORICAL_MOBILE_PAIRING_CANDIDATE_SHA="ea806575e6450e4d1efdfc72c19f04be982a1b9b"',
    );
    expect(source).toContain(
      '[ "${OPENCLAW_DOCKER_E2E_SELECTED_SHA:-}" = "$HISTORICAL_MOBILE_PAIRING_CANDIDATE_SHA" ]',
    );
    expect(source).toContain('candidate_install_mode="historical-package-replacement"');
    expect(source).toContain(
      'npm install -g --prefix "$npm_prefix" "$update_spec" --no-fund --no-audit',
    );
    expect(source).toContain('npm_prefix="$(dirname "$(dirname "$(dirname "$live_package")")")"');
    expect(source).not.toContain(".openclaw-mobile-stage");
    expect(source).not.toContain("mobile-backup");
  });

  it("requires the known watch-command reapproval only for 2026.7.1 baselines", () => {
    const source = readFileSync(RUNNER_PATH, "utf8");
    const reconnect = source.slice(
      source.indexOf("mobile_pairing_expects_node_surface_reapproval()"),
      source.indexOf("verify_mobile_pairing_once()"),
    );
    const result = execFileSync(
      "bash",
      [
        "-c",
        `set -eu
${reconnect.slice(0, reconnect.indexOf("\nverify_mobile_pairing()"))}
for baseline_version in 2026.7.1 2026.7.1-2 2026.8.1; do
  if mobile_pairing_expects_node_surface_reapproval; then
    printf '%s=true\\n' "$baseline_version"
  else
    printf '%s=false\\n' "$baseline_version"
  fi
done
`,
      ],
      { encoding: "utf8" },
    );
    expect(result.trim().split("\n")).toEqual([
      "2026.7.1=true",
      "2026.7.1-2=true",
      "2026.8.1=false",
    ]);
    expect(reconnect).toContain('expect_known_node_surface_reapproval="false"');
    expect(reconnect).toContain('expect_known_node_surface_reapproval="true"');
    expect(reconnect).toContain(
      '--expect-known-node-surface-reapproval "$expect_known_node_surface_reapproval"',
    );
    expect(reconnect).not.toContain("candidate_install_mode");
  });

  it("passes candidate source provenance into the isolated package runner", () => {
    const source = readFileSync("scripts/e2e/upgrade-survivor-docker.sh", "utf8");
    expect(source).toContain(
      '-e OPENCLAW_DOCKER_E2E_SELECTED_SHA="${OPENCLAW_DOCKER_E2E_SELECTED_SHA:-}"',
    );
  });

  it.each(["watchos-direct-node", "mobile-pairing-reconnect"])(
    "skips generic plugin fixture phases for the %s companion survivor",
    (scenario) => {
      const source = readFileSync(RUNNER_PATH, "utf8");
      const helpers = source.slice(
        source.indexOf("companion_survivor_scenario()"),
        source.indexOf("\npackage_root()"),
      );
      const result = execFileSync(
        "bash",
        [
          "-c",
          `set -eu
SCENARIO="$1"
${helpers}
phase() { printf '%s\\n' "$1"; }
run_plugin_fixture_phase fixture-phase true
`,
          "companion-plugin-phase",
          scenario,
        ],
        { encoding: "utf8" },
      );

      expect(result).toBe("");
    },
  );

  it("keeps generic plugin fixtures in non-companion upgrade survivor scenarios", () => {
    const source = readFileSync(RUNNER_PATH, "utf8");
    const helpers = source.slice(
      source.indexOf("companion_survivor_scenario()"),
      source.indexOf("\npackage_root()"),
    );
    const result = execFileSync(
      "bash",
      [
        "-c",
        `set -eu
SCENARIO=base
${helpers}
phase() { printf '%s\\n' "$1"; }
run_plugin_fixture_phase fixture-phase true
`,
      ],
      { encoding: "utf8" },
    );

    expect(result).toBe("fixture-phase\n");
  });

  it("routes every generic plugin fixture phase through the companion guard", () => {
    const source = readFileSync(RUNNER_PATH, "utf8");
    const orchestration = source.slice(source.indexOf("phase storage-preflight"));
    const guardedPhases = [
      "install-baseline-plugin-dependencies",
      "seed-legacy-plugin-dependency-debris",
      "assert-legacy-plugin-dependency-debris",
      "seed-source-only-plugin-shadow",
      "seed-legacy-runtime-deps-symlink",
      "configure-plugin-registry",
      "assert-prepublish-requests",
      "assert-package-local-dependency-cleanup",
      "assert-legacy-plugin-dependency-debris-cleaned",
      "assert-legacy-runtime-deps-symlink-repaired",
      "fixture-plugin-consent",
    ];

    for (const phase of guardedPhases) {
      expect(orchestration).toContain(`run_plugin_fixture_phase ${phase} `);
      expect(orchestration).not.toMatch(new RegExp(`^phase ${phase} `, "mu"));
    }
    const helpers = source.slice(
      source.indexOf("companion_survivor_scenario()"),
      source.indexOf("\npackage_root()"),
    );
    const fixtureSetup = orchestration.slice(
      orchestration.indexOf("if companion_survivor_scenario"),
      orchestration.indexOf("\nphase prepare-update-restart-probe"),
    );
    const recoveryStart = orchestration.indexOf("run_plugin_fixture_phase fixture-plugin-consent");
    const fixtureRecovery = orchestration.slice(
      recoveryStart,
      orchestration.indexOf('if [ "$SCENARIO" = "recovery-cleanup" ]; then', recoveryStart),
    );
    for (const scenario of ["watchos-direct-node", "mobile-pairing-reconnect", "base"]) {
      const result = execFileSync(
        "bash",
        [
          "-c",
          `set -eu
SCENARIO="$1"
OPENCLAW_CLAWHUB_URL=synthetic
CLAWHUB_URL=synthetic
${helpers}
phase() { printf '%s\\n' "$1"; }
repair_update_restart_auth() { printf 'recovery-update-restart\\n'; }
${fixtureSetup}
${fixtureRecovery}
printf 'clawhub=%s/%s\\n' "\${OPENCLAW_CLAWHUB_URL-}" "\${CLAWHUB_URL-}"
`,
          "survivor-companion-routing",
          scenario,
        ],
        { encoding: "utf8" },
      );
      expect(result.trim().split("\n"), scenario).toEqual(
        scenario === "base"
          ? ["configure-clawhub-fixture", "fixture-plugin-consent", "clawhub=synthetic/synthetic"]
          : ["recovery-update-restart", "clawhub=/"],
      );
    }
    expect(orchestration).toContain("phase bootstrap-mobile-pairing bootstrap_mobile_pairing");
    expect(orchestration).toContain("phase mobile-pairing-candidate-first");
    expect(orchestration).toContain("phase mobile-pairing-candidate-restart");
    expect(orchestration).toContain("phase mobile-pairing-final");
  });

  it.each(["watchos-direct-node", "mobile-pairing-reconnect"])(
    "preserves update auto-auth recovery for the %s companion survivor",
    (scenario) => {
      const source = readFileSync(RUNNER_PATH, "utf8");
      const helper = source.slice(
        source.indexOf("repair_update_restart_auth()"),
        source.indexOf("\nrepair_fixture_plugin_consent()"),
      );
      const result = execFileSync(
        "bash",
        [
          "-c",
          `set -eu
SCENARIO="$1"
UPDATE_RESTART_MODE=auto-auth
COMMAND_TIMEOUT=1
ARTIFACT_ROOT=/tmp
update_repair_required=0
${helper}
phase() { printf '%s\\n' "$1"; shift; "$@"; }
prepare_restart_inference() { :; }
prepare_restart_fixture() {
  restart_fixture_package=/tmp/future-package.tgz
  restart_fixture_version=2100.1.0
}
install_update_restart_systemctl_shim() { :; }
run_update_restart_probe_gateway() { :; }
check_gateway_status() { :; }
update_candidate() {
  [ "$#" -eq 3 ] && [ "$1" = 1 ] && [ "$2" = file:/tmp/future-package.tgz ] && [ "$3" = 2100.1.0 ]
}
assert_survival() { :; }
repair_update_restart_auth
`,
          "companion-auto-auth-recovery",
          scenario,
        ],
        { encoding: "utf8" },
      );

      expect(result.trim().split("\n")).toEqual([
        "prepare-restart-inference",
        "prepare-restart-fixture",
        "prepare-restart-manager",
        "prepare-recovery-service",
        "prepared-gateway-auth",
        "recovery-update-restart",
      ]);
    },
  );

  it("selects package replacement by the immutable 8.1 source SHA, not its version alone", () => {
    const source = readFileSync(RUNNER_PATH, "utf8");
    const functions = source.slice(
      source.indexOf("resolve_candidate_install_mode()"),
      source.indexOf("\ncandidate_update_spec()"),
    );
    const resolveMode = (selectedSha: string) =>
      execFileSync(
        "bash",
        [
          "-c",
          `set -eu
HISTORICAL_MOBILE_PAIRING_CANDIDATE_SHA=ea806575e6450e4d1efdfc72c19f04be982a1b9b
SCENARIO=mobile-pairing-reconnect
baseline_version=2026.7.1
candidate_version=2026.8.1
OPENCLAW_DOCKER_E2E_SELECTED_SHA="$1"
${functions}
resolve_candidate_install_mode
printf '%s\\n' "$candidate_install_mode"
`,
          "resolve-mode",
          selectedSha,
        ],
        { encoding: "utf8" },
      ).trim();

    expect(resolveMode("ea806575e6450e4d1efdfc72c19f04be982a1b9b")).toBe(
      "historical-package-replacement",
    );
    expect(resolveMode("156596611a465eda8404f9fb19637c6f7756cb07")).toBe("updater");
  });

  it("installs the historical candidate into the live npm prefix with dependency siblings", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-mobile-package-replacement-"));
    try {
      const prefix = join(root, "prefix");
      const packageRoot = join(prefix, "lib", "node_modules", "openclaw");
      const bin = join(root, "bin");
      const artifacts = join(root, "artifacts");
      mkdirSync(packageRoot, { recursive: true });
      mkdirSync(bin, { recursive: true });
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.7.1" }),
      );
      const npm = join(bin, "npm");
      writeFileSync(
        npm,
        `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.NPM_ARGS_FILE, JSON.stringify(args));
const prefix = args[args.indexOf("--prefix") + 1];
const modules = path.join(prefix, "lib", "node_modules");
fs.mkdirSync(path.join(modules, "openclaw"), { recursive: true });
fs.mkdirSync(path.join(modules, "candidate-dependency"), { recursive: true });
fs.writeFileSync(path.join(modules, "openclaw", "package.json"), JSON.stringify({name:"openclaw",version:"2026.8.1"}));
fs.writeFileSync(path.join(modules, "candidate-dependency", "package.json"), JSON.stringify({name:"candidate-dependency",version:"1.0.0"}));
`,
      );
      chmodSync(npm, 0o755);
      const source = readFileSync(RUNNER_PATH, "utf8");
      const functions = source.slice(
        source.indexOf("replace_historical_mobile_pairing_candidate()"),
        source.indexOf("\nassert_root_managed_vps_cli_usable()"),
      );
      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -eu
openclaw_e2e_maybe_timeout() { shift; "$@"; }
openclaw_e2e_print_log() { :; }
package_root() { printf '%s\\n' "$TEST_PACKAGE_ROOT"; }
candidate_update_spec() { printf '%s\\n' "$TEST_CANDIDATE_SPEC"; }
read_installed_version() {
  node -e 'process.stdout.write(require(process.argv[1]).version)' "$TEST_PACKAGE_ROOT/package.json"
}
baseline_spec=openclaw@2026.7.1
baseline_version=2026.7.1
candidate_version=2026.8.1
CANDIDATE_KIND=tarball
UPDATE_JSON="$TEST_ARTIFACTS/update.json"
UPDATE_ERR="$TEST_ARTIFACTS/update.err"
${functions}
replace_historical_mobile_pairing_candidate
`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            NPM_ARGS_FILE: join(root, "npm-args.json"),
            TEST_ARTIFACTS: artifacts,
            TEST_CANDIDATE_SPEC: join(root, "candidate.tgz"),
            TEST_PACKAGE_ROOT: packageRoot,
          },
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(root, "npm-args.json"), "utf8"))).toEqual([
        "install",
        "-g",
        "--prefix",
        prefix,
        join(root, "candidate.tgz"),
        "--no-fund",
        "--no-audit",
      ]);
      expect(
        existsSync(join(prefix, "lib", "node_modules", "candidate-dependency", "package.json")),
      ).toBe(true);
      expect(JSON.parse(readFileSync(join(artifacts, "update.json"), "utf8"))).toMatchObject({
        status: "ok",
        mode: "historical-package-replacement",
        updaterRun: false,
        doctorRun: false,
        before: { version: "2026.7.1" },
        after: { version: "2026.8.1" },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails pairing phases when gateway teardown fails", () => {
    const source = readFileSync(RUNNER_PATH, "utf8");
    const bootstrap = source.slice(
      source.indexOf("bootstrap_mobile_pairing()"),
      source.indexOf("verify_mobile_pairing()"),
    );
    const reconnect = source.slice(
      source.indexOf("verify_mobile_pairing_once()"),
      source.indexOf("source scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh"),
    );

    for (const body of [bootstrap, reconnect]) {
      expect(body).toContain("stop_gateway || stop_status=$?");
      expect(body).toContain('return "$stop_status"');
    }
  });
});
