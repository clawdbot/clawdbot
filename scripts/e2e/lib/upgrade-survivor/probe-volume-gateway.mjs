#!/usr/bin/env node

// Read migrated conversations through the installed CLI and the live Gateway.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import {
  getVolumeSessionFixture,
  getVolumeSpec,
  getVolumeTranscriptEvent,
} from "./sqlite-volume.mjs";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    out: { type: "string" },
  },
});
assert(values.url && values.out, "--url and --out are required");
const token = process.env.GATEWAY_AUTH_TOKEN_REF;
assert(token, "GATEWAY_AUTH_TOKEN_REF is required");
const run = promisify(execFile);
const startedAt = Date.now();
const deadline = startedAt + 120_000;
const historyLimit = 100;
const spec = getVolumeSpec();

async function gatewayCall(method, params) {
  const remainingMs = deadline - Date.now();
  assert(remainingMs > 0, "volume Gateway probe exceeded its two-minute budget");
  try {
    const result = await run(
      "openclaw",
      [
        "gateway",
        "call",
        method,
        "--url",
        values.url,
        "--token",
        token,
        "--timeout",
        String(Math.min(30_000, remainingMs)),
        "--json",
        "--params",
        JSON.stringify(params),
      ],
      { timeout: remainingMs, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" },
    );
    return JSON.parse(result.stdout);
  } catch (error) {
    // execFile's default error includes argv and its auth token.
    // eslint-disable-next-line preserve-caught-error -- Never retain credential-bearing argv as the cause.
    throw new Error(
      `${method} volume probe failed: ${error.stderr || error.code || "invalid JSON"}`,
    );
  }
}

const indexes = [...new Set([0, 1, 2, 3, 4, 5, spec.sessions - 2, spec.sessions - 1])].filter(
  (index) => index >= 0 && index < spec.sessions,
);
const samples = [];
for (const index of indexes) {
  const fixture = getVolumeSessionFixture(index);
  const { agentId, label, sessionId, sessionKey } = fixture;
  const listing = await gatewayCall("sessions.list", { agentId, label, limit: 2 });
  assert(Array.isArray(listing.sessions), "sessions.list omitted its sessions array");
  assert.equal(listing.sessions.length, 1, `volume session ${index} was not uniquely listed`);
  const [listed] = listing.sessions;
  assert.equal(listed.key, sessionKey, `volume session ${index} changed its listed key`);
  assert.equal(listed.sessionId, sessionId, `volume session ${index} changed its listed identity`);
  assert.equal(listed.label, label, `volume session ${index} changed its listed label`);

  const history = await gatewayCall("chat.history", { agentId, sessionKey, limit: historyLimit });
  assert.equal(history.sessionId, sessionId, `volume history ${index} changed its identity`);
  assert(Array.isArray(history.messages), `volume history ${index} omitted its messages array`);
  const expected = [];
  if (!fixture.metadataOnly && !fixture.missingTranscript) {
    for (
      let sequence = Math.max(1, spec.eventsPerSession - historyLimit);
      sequence < spec.eventsPerSession;
      sequence += 1
    ) {
      const event = getVolumeTranscriptEvent(index, sessionId, sequence);
      expected.push({ id: event.id, role: event.message.role, content: event.message.content });
    }
  }
  const actual = history.messages.map((message) => ({
    // eslint-disable-next-line no-underscore-dangle -- Public Gateway transcript metadata field.
    id: message.__openclaw?.id,
    role: message.role,
    content: message.content,
  }));
  assert.deepEqual(actual, expected, `volume history ${index} changed message content or order`);
  samples.push({
    index,
    agentId,
    sessionId,
    sessionKey,
    label,
    messages: actual.length,
    messagesSha256: createHash("sha256").update(JSON.stringify(actual)).digest("hex"),
  });
}

await fs.mkdir(path.dirname(values.out), { recursive: true });
await fs.writeFile(
  values.out,
  `${JSON.stringify({ status: "passed", elapsedMs: Date.now() - startedAt, samples }, null, 2)}\n`,
);
console.log(
  `sqlite-volume Gateway RPC verified ${samples.length} conversations across ${new Set(samples.map((sample) => sample.agentId)).size} agents`,
);
