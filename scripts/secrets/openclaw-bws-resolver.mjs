#!/usr/bin/env node
// Resolves SecretRef requests against Bitwarden Secrets Manager without printing secrets.
import { execFileSync } from "node:child_process";

const readStdin = () =>
  new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk.toString();
    });
    process.stdin.on("end", () => resolve(input));
    process.stdin.on("error", reject);
  });

const parseRequest = (input) => {
  try {
    return JSON.parse(input || "{}");
  } catch (error) {
    throw new Error(`Failed to parse request JSON: ${error.message}`, { cause: error });
  }
};

const isSecretRecord = (value) =>
  value &&
  typeof value === "object" &&
  typeof value.key === "string" &&
  typeof value.value === "string";

const main = async () => {
  const request = parseRequest(await readStdin());
  if (request.protocolVersion !== 1) {
    throw new Error("Unsupported SecretRef protocolVersion");
  }

  const ids = Array.isArray(request.ids)
    ? request.ids.filter((id) => typeof id === "string" && id.length > 0)
    : [];
  if (ids.length === 0) {
    process.stdout.write(JSON.stringify({ protocolVersion: 1, values: {}, errors: {} }));
    return;
  }

  if (!process.env.BWS_ACCESS_TOKEN) {
    throw new Error("BWS_ACCESS_TOKEN is required");
  }

  const bwsBin =
    process.env.BWS_BIN && process.env.BWS_BIN.trim() ? process.env.BWS_BIN.trim() : "bws";
  const raw = execFileSync(bwsBin, ["secret", "list"], {
    encoding: "utf8",
    env: {
      BWS_ACCESS_TOKEN: process.env.BWS_ACCESS_TOKEN,
      BWS_SERVER_URL: process.env.BWS_SERVER_URL,
      PATH: process.env.PATH || "",
    },
    maxBuffer: 1024 * 1024,
    timeout: 15_000,
  });

  let secrets;
  try {
    secrets = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse bws output: ${error.message}`, { cause: error });
  }

  const byKey = new Map();
  for (const secret of Array.isArray(secrets) ? secrets : []) {
    if (isSecretRecord(secret)) {
      const values = byKey.get(secret.key) || [];
      values.push(secret.value);
      byKey.set(secret.key, values);
    }
  }

  const values = {};
  const errors = {};
  for (const id of ids) {
    const matches = byKey.get(id) || [];
    if (matches.length === 1) {
      values[id] = matches[0];
    } else if (matches.length > 1) {
      errors[id] = { code: "AMBIGUOUS_DUPLICATE_KEY" };
    } else {
      errors[id] = { code: "NOT_FOUND" };
    }
  }

  process.stdout.write(JSON.stringify({ protocolVersion: 1, values, errors }));
};

main().catch(
  /** @param {unknown} error */ (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  },
);
