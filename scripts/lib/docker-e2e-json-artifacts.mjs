import fs from "node:fs";
import { parsePositiveInt } from "./numeric-options.mjs";

const JSON_ARTIFACT_MAX_BYTES_ENV = "OPENCLAW_DOCKER_E2E_JSON_ARTIFACT_MAX_BYTES";
const DEFAULT_JSON_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;

export function readDockerE2eJsonArtifact(file) {
  return JSON.parse(readDockerE2eJsonArtifactText(file));
}

function readDockerE2eJsonArtifactText(file) {
  const maxBytes = readPositiveIntEnv(JSON_ARTIFACT_MAX_BYTES_ENV, DEFAULT_JSON_ARTIFACT_MAX_BYTES);
  const stat = fs.statSync(file);
  if (!stat.isFile()) {
    throw new Error(`JSON artifact is not a file: ${file}`);
  }
  if (stat.size > maxBytes) {
    throw new Error(`JSON artifact exceeded ${maxBytes} bytes: ${file} (${stat.size} bytes)`);
  }
  const text = fs.readFileSync(file, "utf8");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`JSON artifact exceeded ${maxBytes} bytes: ${file} (${bytes} bytes)`);
  }
  return text;
}

function readPositiveIntEnv(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : parsePositiveInt(raw, name);
}
