import { spawnSync } from "node:child_process";

const usage = () => {
  console.error("Usage: assertions.mjs <run-with-timeout|assert-image-providers> [...]");
  process.exit(2);
};

const [mode, ...args] = process.argv.slice(2);

if (mode === "run-with-timeout") {
  const [timeoutMs, command, ...commandArgs] = args;
  const timeout = Number(timeoutMs);
  if (!Number.isFinite(timeout) || timeout <= 0 || !command) {
    usage();
  }

  const result = spawnSync(command, commandArgs, { encoding: "utf8", env: process.env, timeout });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) {
    console.error(`command failed: ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.signal) {
    console.error(`command terminated: ${command}: ${result.signal}`);
    process.exit(1);
  }
  process.exit(result.status ?? 0);
}

if (mode === "assert-image-providers") {
  const raw = process.env.OPENCLAW_IMAGE_PROVIDERS_JSON ?? "";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(raw);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`image providers output is not JSON: ${message}`, { cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new Error("image providers output must be a JSON array");
  }
  if (parsed.length === 0) {
    throw new Error("image providers output is empty");
  }
  const ids = new Set(parsed.map((entry) => (typeof entry?.id === "string" ? entry.id : "")));
  for (const expected of ["google", "openai", "xai"]) {
    if (!ids.has(expected)) {
      throw new Error(`image providers output is missing bundled provider '${expected}'`);
    }
  }
  console.log(`bun-global-install-smoke: image providers OK (${parsed.length} providers)`);
  process.exit(0);
}

usage();
