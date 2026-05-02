import fs from "node:fs";
import path from "node:path";

const DEFAULT_OPENCLAW_TESTBOX_CLAIM_TTL_MINUTES = 12 * 60;
const TESTBOX_ID_PATTERN = /^tbx_[a-z0-9]+$/u;
const OPENCLAW_TESTBOX_CLAIM_FILE = "openclaw-runner.json";

function parsePositiveInteger(value, fallback) {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseTestboxIdArg(argv = []) {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--id" || value === "--testbox-id") {
      return argv[index + 1] ?? "";
    }
    if (value?.startsWith("--id=")) {
      return value.slice("--id=".length);
    }
    if (value?.startsWith("--testbox-id=")) {
      return value.slice("--testbox-id=".length);
    }
  }
  return "";
}

export function resolveTestboxId({ argv = [], env = process.env } = {}) {
  return (
    parseTestboxIdArg(argv) ||
    env.OPENCLAW_TESTBOX_ID ||
    env.BLACKSMITH_TESTBOX_ID ||
    env.TESTBOX_ID ||
    ""
  ).trim();
}

function resolveBlacksmithTestboxStateDir({ env = process.env, homeDir } = {}) {
  if (env.OPENCLAW_BLACKSMITH_TESTBOX_STATE_DIR) {
    return env.OPENCLAW_BLACKSMITH_TESTBOX_STATE_DIR;
  }
  const blacksmithHome =
    env.BLACKSMITH_HOME || path.join(homeDir || env.HOME || process.cwd(), ".blacksmith");
  return path.join(blacksmithHome, "testboxes");
}

export function evaluateLocalTestboxKey({
  testboxId,
  env = process.env,
  exists = fs.existsSync,
  homeDir,
} = {}) {
  if (!testboxId) {
    return { ok: true, checked: false, problems: [] };
  }

  const problems = [];
  if (!TESTBOX_ID_PATTERN.test(testboxId)) {
    problems.push(`invalid Testbox id: ${testboxId}`);
    return {
      ok: false,
      checked: true,
      keyPath: "",
      problems,
      testboxId,
    };
  }

  const stateDir = resolveBlacksmithTestboxStateDir({ env, homeDir });
  const testboxDir = path.join(stateDir, testboxId);
  const keyPath = path.join(testboxDir, "id_ed25519");
  if (!exists(keyPath)) {
    problems.push(
      `local Testbox SSH key missing for ${testboxId}: expected ${keyPath}. ` +
        "This id may be visible in `blacksmith testbox list` but unusable by this operator; warm a fresh box instead.",
    );
  }

  return {
    ok: problems.length === 0,
    checked: true,
    keyPath,
    problems,
    testboxDir,
    testboxId,
  };
}

function resolveOpenClawTestboxClaimPath({ testboxId, env = process.env, homeDir } = {}) {
  const stateDir = resolveBlacksmithTestboxStateDir({ env, homeDir });
  return path.join(stateDir, testboxId, OPENCLAW_TESTBOX_CLAIM_FILE);
}

export function evaluateOpenClawTestboxClaim({
  testboxId,
  cwd,
  env = process.env,
  exists = fs.existsSync,
  now = () => new Date(),
  readFile = fs.readFileSync,
  homeDir,
} = {}) {
  if (!testboxId) {
    return { ok: true, checked: false, problems: [] };
  }

  const claimPath = resolveOpenClawTestboxClaimPath({ testboxId, env, homeDir });
  const expectedRepoRoot = path.resolve(cwd || process.cwd());
  const maxAgeMinutes = parsePositiveInteger(
    env.OPENCLAW_TESTBOX_CLAIM_TTL_MINUTES,
    DEFAULT_OPENCLAW_TESTBOX_CLAIM_TTL_MINUTES,
  );
  const problems = [];

  if (!exists(claimPath)) {
    problems.push(
      `OpenClaw Testbox claim missing for ${testboxId}: expected ${claimPath}. ` +
        "Do not reuse ids from `blacksmith testbox list`; warm a fresh box and claim it with `pnpm testbox:claim --id <id>`.",
    );
    return {
      ok: false,
      checked: true,
      claimPath,
      expectedRepoRoot,
      problems,
      testboxId,
    };
  }

  let claim;
  try {
    claim = JSON.parse(readFile(claimPath, "utf8"));
  } catch (error) {
    problems.push(`OpenClaw Testbox claim is unreadable for ${testboxId}: ${error.message}`);
  }

  const claimedRepoRoot = claim?.repoRoot ? path.resolve(claim.repoRoot) : "";
  if (!claimedRepoRoot) {
    problems.push(`OpenClaw Testbox claim is missing repoRoot for ${testboxId}: ${claimPath}`);
  } else if (claimedRepoRoot !== expectedRepoRoot) {
    problems.push(
      `OpenClaw Testbox claim repo mismatch for ${testboxId}: claimed ${claimedRepoRoot}, current ${expectedRepoRoot}. ` +
        "Warm and claim a fresh box for this checkout.",
    );
  }

  const claimedAtMs = Date.parse(claim?.claimedAt ?? "");
  if (!Number.isFinite(claimedAtMs)) {
    problems.push(`OpenClaw Testbox claim is missing claimedAt for ${testboxId}: ${claimPath}`);
  } else {
    const ageMinutes = Math.floor((now().getTime() - claimedAtMs) / 60000);
    if (ageMinutes > maxAgeMinutes) {
      problems.push(
        `OpenClaw Testbox claim is stale for ${testboxId}: ${ageMinutes}m old, limit ${maxAgeMinutes}m. ` +
          "Warm and claim a fresh box after crashes or long pauses.",
      );
    }
  }

  return {
    ok: problems.length === 0,
    checked: true,
    claim,
    claimPath,
    expectedRepoRoot,
    problems,
    testboxId,
  };
}

export function writeOpenClawTestboxClaim({
  testboxId,
  cwd,
  env = process.env,
  homeDir,
  mkdir = fs.mkdirSync,
  writeFile = fs.writeFileSync,
  now = () => new Date(),
} = {}) {
  const claimPath = resolveOpenClawTestboxClaimPath({ testboxId, env, homeDir });
  const repoRoot = path.resolve(cwd || process.cwd());
  const payload = {
    claimedAt: now().toISOString(),
    repoRoot,
    runnerVersion: 1,
  };
  mkdir(path.dirname(claimPath), { recursive: true });
  writeFile(claimPath, `${JSON.stringify(payload, null, 2)}\n`);
  return { claimPath, payload, testboxId };
}
