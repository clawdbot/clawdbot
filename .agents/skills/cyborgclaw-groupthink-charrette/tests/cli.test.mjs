import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildAuthorityEvidencePayload,
  computeDecisionContextDigest,
  computeFreezeDigest,
  skillRoot,
} from "../scripts/charrette-lib.mjs";
import { canonicalJson, MAX_JSON_BYTES, sha256 } from "../scripts/json-utils.mjs";
import { fixtureCase, rebind } from "./test-helpers.mjs";

const cliPath = join(skillRoot, "scripts", "charrette.mjs");

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: skillRoot,
    encoding: "utf8",
  });
}

function parseFailure(result) {
  assert.equal(result.status, 1, `expected failure; stdout=${result.stdout}`);
  assert.equal(result.signal, null);
  return JSON.parse(result.stderr.slice(0, result.stderr.indexOf("}\n") + 1));
}

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "charrette-cli-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeProceedInputs(directory) {
  const { session, findings } = fixtureCase("proceed");
  const sessionPath = join(directory, "session.json");
  const findingsPath = join(directory, "findings.json");
  await writeFile(sessionPath, `${JSON.stringify(session)}\n`);
  await writeFile(findingsPath, `${JSON.stringify(findings)}\n`);
  return { session, findings, sessionPath, findingsPath };
}

async function createProceedRecord(directory) {
  const inputs = await writeProceedInputs(directory);
  const jsonPath = join(directory, "decision.json");
  const markdownPath = join(directory, "decision.md");
  const earliest = Date.now();
  const result = runCli([
    "decide",
    "--session",
    inputs.sessionPath,
    "--findings",
    inputs.findingsPath,
    "--output-json",
    jsonPath,
  ]);
  const latest = Date.now();
  assert.equal(result.status, 0, result.stderr);
  const renderResult = runCli(["render-record", "--input", jsonPath, "--output-md", markdownPath]);
  assert.equal(renderResult.status, 0, renderResult.stderr);
  return {
    ...inputs,
    jsonPath,
    markdownPath,
    record: JSON.parse(await readFile(jsonPath, "utf8")),
    earliest,
    latest,
  };
}

function rebindCurrentAuthoritySession(session) {
  session.proxy_charter.mission_id = session.mission_id;
  session.proxy_charter.decision_context_digest = computeDecisionContextDigest(session);
  const authorityEvidence = session.evidence.find(
    (item) => item.id === session.proxy_charter.authority_custody.evidence_id,
  );
  assert.ok(authorityEvidence, "fixture must contain its charter authority evidence");
  authorityEvidence.content = canonicalJson(buildAuthorityEvidencePayload(session.proxy_charter));
  authorityEvidence.encoding = "utf8";
  authorityEvidence.sha256 = sha256(authorityEvidence.content);
  session.freeze_digest = null;
  session.freeze_digest = computeFreezeDigest(session);
  return session;
}

test("freeze rejects an exact input/output collision before parsing or writing", async () => {
  await withTemporaryDirectory(async (directory) => {
    const shared = join(directory, "session.json");
    const original = '{"sentinel":"unchanged"}\n';
    await writeFile(shared, original);

    const result = runCli([
      "freeze",
      "--input",
      shared,
      "--timestamp",
      "2026-07-31T12:00:00.000Z",
      "--output",
      shared,
    ]);

    assert.equal(parseFailure(result).code, "PATH_ALIAS_COLLISION");
    assert.equal(await readFile(shared, "utf8"), original);
  });
});

test("route rejects an output symlink that resolves to its input", async () => {
  await withTemporaryDirectory(async (directory) => {
    const input = join(directory, "session.json");
    const output = join(directory, "result.json");
    const original = '{"sentinel":"unchanged"}\n';
    await writeFile(input, original);
    await symlink(input, output);

    const result = runCli(["route", "--input", input, "--output", output]);

    assert.equal(parseFailure(result).code, "PATH_ALIAS_COLLISION");
    assert.equal(await readFile(input, "utf8"), original);
  });
});

test("route resolves symlinked parent directories before comparing paths", async () => {
  await withTemporaryDirectory(async (directory) => {
    const realDirectory = join(directory, "real");
    const aliasDirectory = join(directory, "alias");
    const input = join(realDirectory, "session.json");
    const output = join(aliasDirectory, "session.json");
    const original = '{"sentinel":"unchanged"}\n';
    await mkdir(realDirectory);
    await writeFile(input, original);
    await symlink(realDirectory, aliasDirectory);

    const result = runCli(["route", "--input", input, "--output", output]);

    assert.equal(parseFailure(result).code, "PATH_ALIAS_COLLISION");
    assert.equal(await readFile(input, "utf8"), original);
  });
});

test("render rejects a hard-linked output alias", async () => {
  await withTemporaryDirectory(async (directory) => {
    const input = join(directory, "decision.json");
    const output = join(directory, "decision.md");
    const original = '{"sentinel":"unchanged"}\n';
    await writeFile(input, original);
    await link(input, output);

    const result = runCli(["render-record", "--input", input, "--output-md", output]);

    assert.equal(parseFailure(result).code, "PATH_ALIAS_COLLISION");
    assert.equal(await readFile(input, "utf8"), original);
    assert.equal(await readFile(output, "utf8"), original);
  });
});

test("decide rejects legacy --output-md before parsing or writing", async () => {
  await withTemporaryDirectory(async (directory) => {
    const session = join(directory, "session.json");
    const findings = join(directory, "findings.json");
    const output = join(directory, "decision.json");
    const markdown = join(directory, "decision.md");
    await writeFile(session, "{}\n");
    await writeFile(findings, "{}\n");

    const result = runCli([
      "decide",
      "--session",
      session,
      "--findings",
      findings,
      "--output-json",
      output,
      "--output-md",
      markdown,
    ]);

    const failure = parseFailure(result);
    assert.equal(failure.code, "USAGE");
    assert.match(failure.error, /Unknown flag --output-md/);
    await assert.rejects(access(output), { code: "ENOENT" });
    await assert.rejects(access(markdown), { code: "ENOENT" });
  });
});

test("decide rejects an unsafe JSON output without replacing its target", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { sessionPath, findingsPath } = await writeProceedInputs(directory);
    const jsonPath = join(directory, "decision.json");
    const sentinelPath = join(directory, "sentinel.json");
    const sentinel = "do not replace this target\n";
    await writeFile(sentinelPath, sentinel);
    await symlink(sentinelPath, jsonPath);

    const result = runCli([
      "decide",
      "--session",
      sessionPath,
      "--findings",
      findingsPath,
      "--output-json",
      jsonPath,
    ]);

    assert.equal(parseFailure(result).code, "UNSAFE_OUTPUT");
    assert.equal(await readFile(sentinelPath, "utf8"), sentinel);
  });
});

test("decide rejects an existing JSON output without clobbering it", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { sessionPath, findingsPath } = await writeProceedInputs(directory);
    const jsonPath = join(directory, "decision.json");
    const sentinel = "existing decision must survive\n";
    await writeFile(jsonPath, sentinel);

    const result = runCli([
      "decide",
      "--session",
      sessionPath,
      "--findings",
      findingsPath,
      "--output-json",
      jsonPath,
    ]);

    assert.equal(parseFailure(result).code, "OUTPUT_EXISTS");
    assert.equal(await readFile(jsonPath, "utf8"), sentinel);
  });
});

test("freeze requires an explicit canonical timestamp flag", async () => {
  await withTemporaryDirectory(async (directory) => {
    const result = runCli([
      "freeze",
      "--input",
      join(directory, "session.json"),
      "--output",
      join(directory, "frozen.json"),
    ]);

    const failure = parseFailure(result);
    assert.equal(failure.code, "USAGE");
    assert.match(failure.error, /Missing required flag --timestamp/);
    assert.match(result.stderr, /freeze --input FILE --timestamp ISO --output FILE/);
  });
});

test("decide rejects caller-supplied evaluation time", async () => {
  await withTemporaryDirectory(async (directory) => {
    const result = runCli([
      "decide",
      "--session",
      join(directory, "session.json"),
      "--findings",
      join(directory, "findings.json"),
      "--output-json",
      join(directory, "decision.json"),
      "--evaluated-at",
      "2020-01-01T00:00:00.000Z",
    ]);

    const failure = parseFailure(result);
    assert.equal(failure.code, "USAGE");
    assert.match(failure.error, /Unknown flag --evaluated-at/);
  });
});

test("decide and render-record create separate outputs with a process-captured current time", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { record, markdownPath, earliest, latest } = await createProceedRecord(directory);
    const evaluatedAt = Date.parse(record.authority_verified_at);
    assert.ok(Number.isFinite(evaluatedAt));
    assert.ok(evaluatedAt >= earliest && evaluatedAt <= latest);
    assert.match(await readFile(markdownPath, "utf8"), /PROCEED/);
  });
});

test("decide and render-record outputs are independently no-clobber", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { sessionPath, findingsPath, jsonPath, markdownPath } =
      await createProceedRecord(directory);
    const originalJson = await readFile(jsonPath, "utf8");
    const originalMarkdown = await readFile(markdownPath, "utf8");

    const result = runCli([
      "decide",
      "--session",
      sessionPath,
      "--findings",
      findingsPath,
      "--output-json",
      jsonPath,
    ]);

    assert.equal(parseFailure(result).code, "OUTPUT_EXISTS");
    assert.equal(await readFile(jsonPath, "utf8"), originalJson);
    assert.equal(await readFile(markdownPath, "utf8"), originalMarkdown);

    const renderResult = runCli([
      "render-record",
      "--input",
      jsonPath,
      "--output-md",
      markdownPath,
    ]);
    assert.equal(parseFailure(renderResult).code, "OUTPUT_EXISTS");
    assert.equal(await readFile(jsonPath, "utf8"), originalJson);
    assert.equal(await readFile(markdownPath, "utf8"), originalMarkdown);
  });
});

test("a record larger than the standard input cap round-trips through validate-record", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { session, findings } = fixtureCase("proceed");
    const evidence = {
      id: "ev-large-inert",
      kind: "adversarial_input",
      source: "test:large-quote-newline-evidence",
      sha256: sha256(""),
      classification: "other",
      untrusted: true,
      encoding: "utf8",
      content: "",
    };
    session.evidence.push(evidence);
    rebind(session, findings);

    const emptySessionBytes = Buffer.byteLength(`${JSON.stringify(session)}\n`, "utf8");
    const targetSessionBytes = MAX_JSON_BYTES - 2_048;
    const encodedBytesPerPair = Buffer.byteLength(JSON.stringify('"\n').slice(1, -1), "utf8");
    const pairCount = Math.floor((targetSessionBytes - emptySessionBytes) / encodedBytesPerPair);
    assert.ok(pairCount > 0);
    evidence.content = '"\n'.repeat(pairCount);
    evidence.sha256 = sha256(evidence.content);
    rebind(session, findings);

    const sessionText = `${JSON.stringify(session)}\n`;
    const findingsText = `${JSON.stringify(findings)}\n`;
    assert.ok(Buffer.byteLength(sessionText, "utf8") < MAX_JSON_BYTES);
    assert.ok(Buffer.byteLength(findingsText, "utf8") < MAX_JSON_BYTES);

    const sessionPath = join(directory, "large-session.json");
    const findingsPath = join(directory, "findings.json");
    const recordPath = join(directory, "large-record.json");
    await writeFile(sessionPath, sessionText);
    await writeFile(findingsPath, findingsText);

    const decideResult = runCli([
      "decide",
      "--session",
      sessionPath,
      "--findings",
      findingsPath,
      "--output-json",
      recordPath,
    ]);
    assert.equal(decideResult.status, 0, decideResult.stderr);
    assert.ok((await readFile(recordPath)).byteLength > MAX_JSON_BYTES);

    const validateResult = runCli(["validate-record", "--input", recordPath]);
    assert.equal(validateResult.status, 0, validateResult.stderr);
    assert.equal(JSON.parse(validateResult.stdout).valid, true);
  });
});

test("malformed UTF-8 input is rejected as INVALID_JSON", async () => {
  await withTemporaryDirectory(async (directory) => {
    const input = join(directory, "malformed.json");
    await writeFile(input, Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]));

    const result = runCli(["route", "--input", input]);

    const failure = parseFailure(result);
    assert.equal(failure.code, "INVALID_JSON");
    assert.match(failure.error, /malformed UTF-8/);
  });
});

test("recheck-record authorizes the exact live frozen session at current time", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { jsonPath, sessionPath } = await createProceedRecord(directory);
    const earliest = Date.now();

    const result = runCli([
      "recheck-record",
      "--input",
      jsonPath,
      "--authority-session",
      sessionPath,
    ]);

    assert.equal(result.status, 0, result.stderr);
    const latest = Date.now();
    const recheck = JSON.parse(result.stdout);
    assert.equal(recheck.authorized, true);
    assert.equal(recheck.authority_status, "WITHIN_DELEGATION");
    const evaluatedAt = Date.parse(recheck.evaluated_at);
    assert.ok(Number.isFinite(evaluatedAt));
    assert.ok(evaluatedAt >= earliest && evaluatedAt <= latest);
  });
});

test("recheck-record denies an expired current authority session", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { jsonPath, session } = await createProceedRecord(directory);
    const expiredSession = structuredClone(session);
    expiredSession.proxy_charter.expires_at = "2000-01-01T00:00:00.000Z";
    rebindCurrentAuthoritySession(expiredSession);
    const expiredPath = join(directory, "expired-session.json");
    await writeFile(expiredPath, `${JSON.stringify(expiredSession)}\n`);

    const result = runCli([
      "recheck-record",
      "--input",
      jsonPath,
      "--authority-session",
      expiredPath,
    ]);

    assert.equal(result.status, 2, result.stderr);
    const recheck = JSON.parse(result.stdout);
    assert.equal(recheck.authorized, false);
    assert.equal(recheck.authority_status, "EXPIRED");
    assert.ok(recheck.reason_codes.includes("AUTHORITY_EXPIRED"));
  });
});

test("recheck-record denies a valid but mismatched current decision context", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { jsonPath, session } = await createProceedRecord(directory);
    const mismatchedSession = structuredClone(session);
    mismatchedSession.mission_statement =
      "Exercise a different local decision context without external effects.";
    rebindCurrentAuthoritySession(mismatchedSession);
    const mismatchedPath = join(directory, "mismatched-session.json");
    await writeFile(mismatchedPath, `${JSON.stringify(mismatchedSession)}\n`);

    const result = runCli([
      "recheck-record",
      "--input",
      jsonPath,
      "--authority-session",
      mismatchedPath,
    ]);

    assert.equal(result.status, 2, result.stderr);
    const recheck = JSON.parse(result.stdout);
    assert.equal(recheck.authorized, false);
    assert.ok(recheck.reason_codes.includes("AUTHORITY_CONFLICT"));
  });
});

test("recheck-record rejects output flags and writes only to stdout", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { jsonPath, sessionPath } = await createProceedRecord(directory);
    const outputPath = join(directory, "recheck.json");
    const result = runCli([
      "recheck-record",
      "--input",
      jsonPath,
      "--authority-session",
      sessionPath,
      "--output",
      outputPath,
    ]);

    const failure = parseFailure(result);
    assert.equal(failure.code, "USAGE");
    assert.match(failure.error, /Unknown flag --output/);
    await assert.rejects(access(outputPath), { code: "ENOENT" });
  });
});
