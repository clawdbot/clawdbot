import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AUTH_MODES = new Set(["live", "mock"]);
const CLI_KEYS = new Set(["auth", "include", "plan", "profile", "repeat", "report", "target"]);

function check(condition, reason) {
  if (!condition) {
    throw new Error(reason);
  }
}

function object(value, label) {
  check(value !== null && typeof value === "object" && !Array.isArray(value), `invalid ${label}`);
  return value;
}

function array(value, label) {
  check(Array.isArray(value), `invalid ${label}`);
  return value;
}

function text(value, label) {
  check(typeof value === "string" && value.trim().length > 0, `invalid ${label}`);
  return value;
}

function positiveInteger(value, label) {
  check(Number.isSafeInteger(value) && value > 0, `invalid ${label}`);
  return value;
}

function exactStrings(value, expected, label) {
  const actual = array(value, label);
  check(
    actual.length === expected.length && actual.every((item, index) => item === expected[index]),
    `${label} did not match`,
  );
}

function pairKey(scenario, state, label) {
  return `${text(scenario, `${label} scenario`)}\u0000${text(state, `${label} state`)}`;
}

function displayPair(key) {
  return key.replace("\u0000", "/");
}

function profileId(value, label) {
  return text(object(value, label).id, `${label} id`);
}

function repeatIndexesFor(selectedPairs) {
  return new Map([...selectedPairs].map((key) => [key, new Set()]));
}

function validateLiveRecord(record, key) {
  const auth = object(record.auth, `record ${displayPair(key)} auth`);
  const provider = object(record.providerEvidence, `record ${displayPair(key)} provider evidence`);
  check(
    auth.environmentDependent === true,
    `live record ${displayPair(key)} auth was not environment-dependent`,
  );
  check(provider.authMode === "live", `live record ${displayPair(key)} provider auth was not live`);
  check(
    provider.environmentDependent === true,
    `live record ${displayPair(key)} provider evidence was not environment-dependent`,
  );
  check(
    provider.source === "openclaw-timeline",
    `live record ${displayPair(key)} provider source was ${provider.source}`,
  );
  check(
    provider.available === true,
    `live record ${displayPair(key)} provider evidence was unavailable`,
  );
  positiveInteger(provider.requestCount, `live record ${displayPair(key)} provider request count`);
}

export function validateKovaWorkflowEvidence({
  plan,
  report,
  profile,
  target,
  repeat,
  includeFilters,
  authMode,
}) {
  const expectedProfile = text(profile, "expected profile");
  const expectedTarget = text(target, "expected target");
  const expectedRepeat = positiveInteger(repeat, "expected repeat");
  const expectedFilters = array(includeFilters, "expected include filters").map((value, index) =>
    text(value, `expected include filter ${index}`),
  );
  const expectedAuth = text(authMode, "expected auth mode");
  check(AUTH_MODES.has(expectedAuth), `unsupported expected auth mode ${expectedAuth}`);
  check(expectedFilters.length > 0, "expected include filters were empty");

  const lanePlan = object(plan, "lane plan");
  const laneReport = object(report, "lane report");
  check(lanePlan.schemaVersion === "kova.matrix.plan.v1", "unexpected lane plan schema");
  check(laneReport.schemaVersion === "kova.report.v1", "unexpected lane report schema");
  check(laneReport.mode === "execution", `lane report mode was ${laneReport.mode}`);
  check(
    profileId(lanePlan.profile, "lane plan profile") === expectedProfile,
    "lane plan profile did not match",
  );
  check(
    profileId(laneReport.profile, "lane report profile") === expectedProfile,
    "lane report profile did not match",
  );
  check(lanePlan.target === expectedTarget, "lane plan target did not match");
  check(laneReport.target === expectedTarget, "lane report target did not match");

  const planControls = object(lanePlan.controls, "lane plan controls");
  const reportControls = object(laneReport.controls, "lane report controls");
  exactStrings(planControls.include, expectedFilters, "lane plan include filters");
  exactStrings(reportControls.include, expectedFilters, "lane report include filters");
  check(planControls.repeat === expectedRepeat, "lane plan repeat did not match");
  check(reportControls.repeat === expectedRepeat, "lane report repeat did not match");

  const selectedPairs = new Set();
  for (const [index, value] of array(lanePlan.entries, "lane plan entries").entries()) {
    const entry = object(value, `lane plan entry ${index}`);
    const status = text(entry.status, `lane plan entry ${index} status`);
    check(status === "SELECTED" || status === "SKIPPED", `invalid lane plan entry ${index} status`);
    if (status === "SKIPPED") {
      continue;
    }
    const key = pairKey(
      object(entry.scenario, `lane plan entry ${index} scenario`).id,
      object(entry.state, `lane plan entry ${index} state`).id,
      `lane plan entry ${index}`,
    );
    check(!selectedPairs.has(key), `lane plan selected duplicate ${displayPair(key)}`);
    selectedPairs.add(key);
  }
  check(selectedPairs.size > 0, "lane plan selected no scenario/state pairs");

  const reportAuth = object(laneReport.auth, "lane report auth");
  check(reportAuth.requestedMode === expectedAuth, "lane report requested auth did not match");
  if (expectedAuth === "live") {
    check(
      object(reportAuth.live, "lane report live auth").environmentDependent === true,
      "lane report live auth was not environment-dependent",
    );
  }

  const records = array(laneReport.records, "lane report records");
  const repeatIndexes = repeatIndexesFor(selectedPairs);
  for (const [index, value] of records.entries()) {
    const record = object(value, `lane report record ${index}`);
    const state = object(record.state, `lane report record ${index} state`);
    const key = pairKey(record.scenario, state.id, `lane report record ${index}`);
    check(selectedPairs.has(key), `lane report contained unexpected ${displayPair(key)}`);
    const status = text(record.status, `record ${displayPair(key)} status`);
    check(
      ["BLOCKED", "FAIL", "PASS"].includes(status),
      `invalid record ${displayPair(key)} status`,
    );

    const recordRepeat = object(record.repeat, `record ${displayPair(key)} repeat`);
    check(
      recordRepeat.total === expectedRepeat,
      `record ${displayPair(key)} repeat total did not match`,
    );
    const repeatIndex = positiveInteger(
      recordRepeat.index,
      `record ${displayPair(key)} repeat index`,
    );
    check(
      repeatIndex <= expectedRepeat,
      `record ${displayPair(key)} repeat index exceeded ${expectedRepeat}`,
    );
    const indexes = repeatIndexes.get(key);
    check(!indexes.has(repeatIndex), `record ${displayPair(key)} repeated index ${repeatIndex}`);
    indexes.add(repeatIndex);

    const recordAuth = object(record.auth, `record ${displayPair(key)} auth`);
    check(recordAuth.mode === expectedAuth, `record ${displayPair(key)} auth mode did not match`);
    if (expectedAuth === "live") {
      validateLiveRecord(record, key);
    }
  }

  for (const [key, indexes] of repeatIndexes) {
    check(
      indexes.size === expectedRepeat,
      `lane report collapsed ${displayPair(key)} coverage to ${indexes.size}/${expectedRepeat} repeats`,
    );
    for (let index = 1; index <= expectedRepeat; index += 1) {
      check(indexes.has(index), `lane report missed ${displayPair(key)} repeat ${index}`);
    }
  }
  check(
    records.length === selectedPairs.size * expectedRepeat,
    "lane report record count did not match selected coverage",
  );

  return {
    authMode: expectedAuth,
    pairCount: selectedPairs.size,
    recordCount: records.length,
    repeat: expectedRepeat,
  };
}

function parseCliArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    check(name?.startsWith("--") && value !== undefined, "invalid CLI arguments");
    const key = name.slice(2);
    check(CLI_KEYS.has(key), `unknown --${key}`);
    check(!Object.hasOwn(flags, key), `duplicate --${key}`);
    flags[key] = value;
  }
  for (const key of ["plan", "report", "profile", "target", "repeat", "include", "auth"]) {
    text(flags[key], `--${key}`);
  }
  return flags;
}

function readJson(pathValue, label) {
  const file = text(pathValue, label);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function runCli() {
  const flags = parseCliArgs(process.argv.slice(2));
  const result = validateKovaWorkflowEvidence({
    plan: readJson(flags.plan, "--plan"),
    report: readJson(flags.report, "--report"),
    profile: flags.profile,
    target: flags.target,
    repeat: Number(flags.repeat),
    includeFilters: flags.include
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    authMode: flags.auth,
  });
  console.log(
    `Kova plan/report evidence validated: ${result.pairCount} scenario/state pairs x ${result.repeat} repeats (${result.authMode})`,
  );
}

const modulePath = fs.realpathSync.native(fileURLToPath(import.meta.url));
const invokedPath = process.argv[1] ? fs.realpathSync.native(path.resolve(process.argv[1])) : "";

if (modulePath === invokedPath) {
  try {
    runCli();
  } catch (error) {
    console.error(
      `Kova evidence validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
