import assert from "node:assert/strict";

const [scenario, url] = process.argv.slice(2);
if (!scenario || !url) {
  throw new Error("usage: hosting-profiles-client.mjs <scenario> <ready-url>");
}

const response = await fetch(url);
const body = await response.json();

function condition(type) {
  const value = findCondition(type);
  assert.ok(value, `missing ${type} condition: ${JSON.stringify(body)}`);
  return value;
}

function findCondition(type) {
  return body.conditions?.find((entry) => entry.type === type);
}

function assertSelectedProfile(profile) {
  const selected = condition("ProfileSelected");
  assert.equal(selected.status, "True");
  assert.match(selected.message, new RegExp(`\\b${profile}\\b`));
  assert.equal(body.profileContractVersion, 1);
  assert.equal(body.profile, profile);
  assert.ok(["argument", "environment", "config"].includes(body.profileSource));
  assert.equal(body.activation?.profile, profile);
  assert.equal(typeof body.activation?.runtimeId, "string");
  assert.equal(typeof body.activation?.incarnationId, "string");
}

if (scenario === "unprofiled") {
  assert.equal(response.status, 200);
  assert.equal(body.ready, true);
  assert.equal(findCondition("ProfileSelected"), undefined);
  assert.equal(findCondition("WorkspaceWritable"), undefined);
  assert.equal(findCondition("RuntimeActivationIdentified"), undefined);
  assert.equal(body.profileContractVersion, undefined);
  assert.equal(body.profile, undefined);
  assert.equal(body.profileSource, undefined);
  assert.equal(body.activation, undefined);
  assert.equal(condition("ConfigLoaded").requirement, "required");
  assert.equal(condition("GatewayResponding").requirement, "required");
  assert.deepEqual(body.failures, []);
} else if (scenario === "local") {
  assert.equal(response.status, 200);
  assertSelectedProfile("local");
  assert.equal(body.ready, true);
  assert.equal(condition("ProfileSelected").requirement, "required");
  assert.equal(condition("ConfigLoaded").requirement, "required");
  assert.equal(condition("GatewayResponding").requirement, "required");
  assert.equal(condition("WorkspaceWritable").status, "True");
  assert.equal(condition("WorkspaceWritable").requirement, "required");
  assert.equal(condition("RuntimeActivationIdentified").status, "True");
  assert.equal(condition("PluginsLoaded").requirement, "advisory");
  assert.deepEqual(body.failures, []);
  assert.ok(Array.isArray(body.advisories));
} else if (scenario === "container-ready") {
  assert.equal(response.status, 200);
  assertSelectedProfile("container");
  assert.equal(body.ready, true);
  assert.equal(condition("ContainerStateReady").status, "True");
  assert.equal(condition("ContainerStateReady").requirement, "required");
  assert.deepEqual(body.failures, []);
} else if (scenario === "container-loopback") {
  assert.equal(response.status, 503);
  assertSelectedProfile("container");
  assert.equal(body.ready, false);
  assert.equal(condition("ContainerStateReady").status, "False");
  assert.equal(condition("ContainerStateReady").requirement, "required");
  assert.equal(condition("ContainerStateReady").reason, "ContainerGatewayLoopback");
  assert.ok(body.failures.includes("ContainerGatewayLoopback"));
} else if (scenario === "reverse-proxy-ready") {
  assert.equal(response.status, 200);
  assertSelectedProfile("reverse-proxy");
  assert.equal(body.ready, true);
  assert.equal(condition("TrustedProxyReady").status, "True");
  assert.equal(condition("TrustedProxyReady").requirement, "required");
  assert.deepEqual(body.failures, []);
} else if (scenario === "reverse-proxy-auth-missing") {
  assert.equal(response.status, 503);
  assertSelectedProfile("reverse-proxy");
  assert.equal(body.ready, false);
  assert.equal(condition("TrustedProxyReady").status, "False");
  assert.equal(condition("TrustedProxyReady").requirement, "required");
  assert.equal(condition("TrustedProxyReady").reason, "TrustedProxyAuthMissing");
  assert.ok(body.failures.includes("TrustedProxyAuthMissing"));
} else if (scenario === "node-not-ready") {
  assert.equal(response.status, 503);
  assertSelectedProfile("node-mode");
  assert.equal(body.ready, false);
  assert.equal(condition("NodePairingReady").status, "False");
  assert.equal(condition("ControlledTargetsReady").status, "False");
  assert.equal(condition("CommandApprovalReady").status, "False");
  assert.equal(condition("ControlChannelReady").status, "False");
  assert.ok(body.failures.includes("NodePairingMissing"));
  assert.ok(body.failures.includes("ControlledTargetsDisconnected"));
  assert.ok(body.failures.includes("CommandApprovalMissing"));
  assert.ok(body.failures.includes("ControlChannelUnavailable"));
} else if (scenario === "node-unapproved") {
  assert.equal(response.status, 503);
  assertSelectedProfile("node-mode");
  assert.equal(body.ready, false);
  assert.equal(condition("NodePairingReady").status, "False");
  assert.equal(condition("NodePairingReady").reason, "NodePairingPending");
  assert.equal(condition("ControlledTargetsReady").status, "False");
  assert.equal(condition("CommandApprovalReady").status, "False");
  assert.equal(condition("ControlChannelReady").status, "False");
} else if (scenario === "node-ready") {
  assert.equal(response.status, 200);
  assertSelectedProfile("node-mode");
  assert.equal(body.ready, true);
  for (const type of [
    "NodePairingReady",
    "ControlledTargetsReady",
    "CommandApprovalReady",
    "ControlChannelReady",
  ]) {
    assert.equal(condition(type).status, "True");
    assert.equal(condition(type).requirement, "required");
  }
  assert.deepEqual(body.failures, []);
} else if (scenario === "workspace-ready" || scenario === "workspace-recovered") {
  assert.equal(response.status, 200);
  assertSelectedProfile("local");
  assert.equal(body.ready, true);
  assert.equal(condition("WorkspaceWritable").status, "True");
  assert.equal(condition("WorkspaceWritable").reason, "WorkspaceWritable");
  assert.deepEqual(body.failures, []);
} else if (scenario === "workspace-full") {
  assert.equal(response.status, 503);
  assertSelectedProfile("local");
  assert.equal(body.ready, false);
  assert.equal(condition("WorkspaceWritable").status, "False");
  assert.equal(condition("WorkspaceWritable").requirement, "required");
  assert.equal(condition("WorkspaceWritable").reason, "WorkspaceStorageFull");
  assert.ok(body.failures.includes("WorkspaceStorageFull"));
} else {
  throw new Error(`unknown hosting profile scenario: ${scenario}`);
}

console.log(JSON.stringify({ scenario, status: response.status, readiness: body }, null, 2));
