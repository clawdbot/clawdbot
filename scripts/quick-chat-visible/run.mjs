import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { correlateQuickChatConnection } from "./correlation.mjs";
import { correlatePublication } from "./publication.mjs";
import { hasOperatorTransport } from "./operator-readiness.mjs";
import { verifyListenerRuntime } from "./listener-runtime.mjs";

const product = "ff58c1c42fd6353974b2da8b9ba7384248b0c634";
const [executable, driver, evidence] = process.argv.slice(2);
assert.equal(process.platform, "darwin", "Only the admitted disposable macOS lane may run this support");
assert.equal(process.env.CI, "true");
assert.ok(executable && driver && evidence && [executable, driver, evidence].every(path.isAbsolute));
assert.equal(process.env.HOME, process.env.CFFIXED_USER_HOME);
assert.ok(process.env.OPENCLAW_PROFILE?.startsWith("test-"));
assert.ok(process.env.OPENCLAW_CONFIG_PATH && process.env.OPENCLAW_STATE_DIR);
assert.ok(!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN && !process.env.OPENCLAW_GATEWAY_TOKEN);
for (const key of ["XCTestConfigurationFilePath", "XCTestBundlePath", "XCTestSessionIdentifier"]) {
  assert.equal(process.env[key], undefined, "Normal app must not inherit test detection");
}
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const recordPath = path.join(evidence, "interaction.jsonl");
const record = (event, fields = {}) => fs.appendFileSync(recordPath, `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
record("runtime-inputs", { product, executable, executableSha256: hash(executable), driverSha256: hash(driver) });
const output = fs.openSync(path.join(evidence, "driver.jsonl"), "wx", 0o600);
const errors = fs.openSync(path.join(evidence, "driver.stderr.log"), "wx", 0o600);
const child = spawn(driver, [executable, evidence], { env: process.env, stdio: ["pipe", "pipe", errors] });
fs.closeSync(errors);
let launchError;
let closed = false;
let stopped = false;
const responses = new Map();
let ready = false;
let sequence = 0;
child.once("error", error => { launchError = error; });
child.once("close", (code, signal) => {
  closed = true;
  fs.closeSync(output);
  record("driver-closed", { code, signal });
});
child.stdout.on("data", bytes => fs.writeSync(output, bytes));
const lines = createInterface({ input: child.stdout });
lines.on("line", line => {
  try {
    const observation = JSON.parse(line);
    if (observation.kind === "ready-for-command") ready = true;
    if (observation.kind === "action-completed") responses.set(observation.id, observation);
    if (observation.kind === "stop") launchError = new Error(observation.reason);
  } catch (error) { launchError = error; }
});
const waitFor = async (description, predicate) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (await predicate()) return;
    if (closed) throw new Error(`Driver closed before ${description}`);
    await delay(100);
  }
  throw new Error(`Unreached boundary: ${description}`);
};
const action = async (actionName, fields = {}) => {
  const id = String(++sequence);
  record("driver-action", { id, action: actionName, ...fields });
  child.stdin.write(`${JSON.stringify({ id, action: actionName, ...fields })}\n`);
  await waitFor(actionName, () => responses.has(id));
};
let fixture;
let result = "stopped";
try {
  await waitFor("non-prompting native permissions", () => ready);
  const listenerRuntime = verifyListenerRuntime(import.meta.dirname);
  const fixtureModule = await import("./fixture.mjs");
  assert.equal(fixtureModule.SOURCE, product);
  record("fixture-input", { requiredRuntime: listenerRuntime });
  fixture = await fixtureModule.startFixture({
    packageRoot: process.cwd(),
    output: path.join(evidence, "fixture"),
    durationSeconds: 420,
    scope: "per-agent",
    capability: "supported",
  });
  const endpoint = new URL(fixture.ready.gatewayUrl);
  assert.equal(endpoint.protocol, "ws:");
  assert.equal(endpoint.hostname, "127.0.0.1");
  fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify({
    gateway: {
      mode: "remote",
      remote: { transport: "direct", url: fixture.ready.gatewayUrl, token: fixture.ready.gatewayToken },
    },
  }), { flag: "wx", mode: 0o600 });
  const control = async (route, body) => {
    const response = await fetch(`${fixture.ready.controlUrl}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${fixture.ready.controlToken}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const value = await response.json();
    record("fixture-control", { route, body, status: response.status, response: value });
    assert.ok(response.ok, "Fixture rejected its explicit control request");
    assert.equal(value.boundaryCount ?? 0, 0, "Fixture surfaced an unsupported normal-app request");
    return value;
  };
  const wire = () => fs.readFileSync(fixture.ready.wirePath, "utf8").trim().split("\n").map(line => JSON.parse(line));
  let connection;
  await action("start");
  await waitFor("operator transport admission", async () => {
    const status = await control("/status");
    return hasOperatorTransport({ records: wire(), status });
  });
  await action("activate");
  const openWatermark = wire().at(-1).record;
  record("quick-chat-open-watermark", { wireRecord: openWatermark, sessionKey: "agent:a:main", agentId: "a" });
  await action("open");
  await action("ready");
  const correlate = async () => {
    const status = await control("/status");
    const correlation = correlateQuickChatConnection({
      records: wire(), status, afterRecord: openWatermark, sessionKey: "agent:a:main", agentId: "a",
    });
    record("destination-correlation", correlation);
    assert.notEqual(correlation.state, "ambiguous", "Multiple post-open scoped readers need owner attribution; no first-connection or broadcast fallback");
    return correlation;
  };
  await waitFor("post-open snapshot destination correlation", async () => {
    const correlation = await correlate();
    if (correlation.state !== "correlated") return false;
    connection = correlation.destination.connectionId;
    return true;
  });
  await action("draft", { text: "Synthetic Quick Chat draft stays unsent" });
  await action("ready");
  await action("capture", { name: "initial-draft" });
  const captureMenu = async name => {
    await action("model-menu");
    await action("provider", { text: "Fixture" });
    await action("capture", { name });
    await action("dismiss-menu");
  };
  await captureMenu("initial-menu");
  const publish = async name => {
    const current = await correlate();
    assert.equal(current.state, "correlated", "Original destination no longer has current wire evidence");
    assert.equal(current.destination.connectionId, connection, "Original presentation destination changed; no implicit reconnect retarget");
    const before = wire().at(-1).record;
    const event = "chat.metadata.changed";
    const receipt = await control("/publish", { connectionId: connection, event });
    await waitFor("publication request and matching wire response", () => {
      const observation = correlatePublication({
        records: wire(), receipt, connectionId: connection, afterRecord: before, event,
        sessionKey: "agent:a:main", agentId: "a",
      });
      assert.notEqual(observation.state, "ambiguous", observation.reason);
      if (observation.state !== "correlated") return false;
      record("publication-response", { name, ...observation });
      return true;
    });
    await action("ready");
    await action("capture", { name: `${name}-draft` });
    await captureMenu(`${name}-menu`);
    await control("/status");
  };
  await control("/catalog", { models: ["choice-a", "choice-c"] });
  await publish("published");
  await control("/failure", { method: "chat.metadata", kind: "rpc" });
  await publish("rpc-failure");
  await control("/failure", { method: "chat.metadata", kind: "decode" });
  await publish("decode-failure");
  await control("/failure", { method: "chat.metadata", kind: null });
  await control("/catalog", { models: ["choice-a", "choice-d"] });
  await publish("recovered");
  await action("stop");
  stopped = true;
  await waitFor("normal driver exit", () => closed);
  result = "observations-recorded-not-acceptance";
} catch (error) {
  record("stop", { error: String(error) });
  process.exitCode = 1;
} finally {
  if (!stopped && !closed) {
    child.kill("SIGTERM");
    const deadline = Date.now() + 5000;
    while (!closed && Date.now() < deadline) await delay(100);
    if (!closed) throw new Error("Driver remains live; retain resources under the outer process-tree owner");
  }
  if (fixture) await fixture.stop("normal-app-proof-finished");
  record("finished", { result, driverClosed: closed });
}
