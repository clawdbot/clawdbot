#!/usr/bin/env node

import { readSecretFileSync } from "@openclaw/fs-safe/secret";
import { parseVaultSecretId } from "./vault-secret-id.js";

const KUBERNETES_SERVICE_ACCOUNT_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const VAULT_FETCH_TIMEOUT_MS = 5000;
const VAULT_ERROR_BODY_MAX_BYTES = 64 * 1024;

class VaultProviderError extends Error {}
class VaultForbiddenError extends Error {}

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += String(chunk);
    });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(input));
  });
}

function writeResponse(response) {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function parseRequest(input) {
  const parsed = JSON.parse(input);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.ids)) {
    throw new Error("invalid exec SecretRef request");
  }
  return {
    protocolVersion: 1,
    ids: parsed.ids.filter((id) => typeof id === "string" && id.length > 0),
  };
}

function normalizeVaultAddress() {
  const raw = process.env.VAULT_ADDR?.trim();
  if (!raw) {
    throw new Error("VAULT_ADDR is required.");
  }
  const address = raw.replace(/\/+$/u, "");
  let parsed;
  try {
    parsed = new URL(address);
  } catch {
    throw new Error("VAULT_ADDR must be a valid http or https URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("VAULT_ADDR must be a valid http or https URL.");
  }
  return address;
}

function normalizeOptionalString(value) {
  return value?.trim() || undefined;
}

function readVaultCredentialFile(filePath, label, emptyMessage) {
  try {
    return readSecretFileSync(filePath, label, { rejectHardlinks: false });
  } catch (error) {
    if (error?.code === "not-found" && error.cause) {
      throw error.cause;
    }
    if (error?.code === "invalid-path" && error.message?.endsWith(" is empty.")) {
      throw new Error(emptyMessage, { cause: error });
    }
    throw error;
  }
}

function resolveVaultAuthMethod() {
  const method = normalizeOptionalString(process.env.OPENCLAW_VAULT_AUTH_METHOD) ?? "token";
  if (
    method === "token" ||
    method === "token_file" ||
    method === "jwt" ||
    method === "kubernetes"
  ) {
    return method;
  }
  throw new Error("OPENCLAW_VAULT_AUTH_METHOD must be token, token_file, jwt, or kubernetes.");
}

function resolveVaultTokenEnv() {
  const token = process.env.VAULT_TOKEN?.trim();
  if (!token) {
    throw new Error("VAULT_TOKEN is required.");
  }
  return token;
}

function resolveVaultTokenFile() {
  const tokenFile = normalizeOptionalString(process.env.VAULT_TOKEN_FILE);
  if (!tokenFile) {
    throw new Error("VAULT_TOKEN_FILE is required.");
  }
  return readVaultCredentialFile(
    tokenFile,
    "Vault token",
    "VAULT_TOKEN_FILE did not contain a token.",
  );
}

function resolveKvMount() {
  return process.env.OPENCLAW_VAULT_KV_MOUNT?.trim().replace(/^\/+|\/+$/gu, "") || "secret";
}

function resolveKvVersion() {
  const raw = process.env.OPENCLAW_VAULT_KV_VERSION?.trim();
  if (!raw || raw === "2") {
    return 2;
  }
  if (raw === "1") {
    return 1;
  }
  throw new Error("OPENCLAW_VAULT_KV_VERSION must be 1 or 2.");
}

function encodePath(pathValue) {
  return pathValue
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function buildVaultUrl(baseUrl, params) {
  const mount = encodePath(resolveKvMount());
  const secretPath = encodePath(params.secretPath);
  if (resolveKvVersion() === 2) {
    return `${baseUrl}/v1/${mount}/data/${secretPath}`;
  }
  return `${baseUrl}/v1/${mount}/${secretPath}`;
}

function assertVaultRequestUrl(baseUrl, requestUrl) {
  const base = new URL(baseUrl);
  const target = new URL(requestUrl);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("Vault request URL must be a valid http or https URL.");
  }
  if (target.origin !== base.origin) {
    throw new Error("Vault request URL must stay on the configured VAULT_ADDR origin.");
  }
}

async function readVaultErrorPayload(response) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > VAULT_ERROR_BODY_MAX_BYTES) {
    try {
      await response.body?.cancel();
    } catch {
      // The fetch timeout still owns a stuck or failed cancellation.
    }
    return undefined;
  }
  const reader = response.body?.getReader();
  if (!reader) {
    return undefined;
  }
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      text += decoder.decode();
      break;
    }
    bytesRead += value.byteLength;
    if (bytesRead > VAULT_ERROR_BODY_MAX_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // The fetch timeout still owns a stuck or failed cancellation.
      }
      return undefined;
    }
    text += decoder.decode(value, { stream: true });
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function fetchVault(baseUrl, url, init) {
  assertVaultRequestUrl(baseUrl, url);
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), VAULT_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: abortController.signal,
    });
    return {
      response,
      payload: response.ok ? await response.json() : await readVaultErrorPayload(response),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function isInvalidVaultTokenPayload(payload) {
  return (
    Array.isArray(payload?.errors) &&
    payload.errors.some(
      (entry) => typeof entry === "string" && entry.trim().toLowerCase() === "invalid token",
    )
  );
}

function addVaultNamespaceHeader(headers) {
  const namespace = process.env.VAULT_NAMESPACE?.trim();
  if (namespace) {
    headers["X-Vault-Namespace"] = namespace;
  }
}

function resolveVaultAuthMount(method) {
  return process.env.OPENCLAW_VAULT_AUTH_MOUNT?.trim().replace(/^\/+|\/+$/gu, "") || method;
}

function resolveVaultAuthRole(method) {
  const role = normalizeOptionalString(process.env.OPENCLAW_VAULT_AUTH_ROLE);
  if (!role) {
    throw new Error(`OPENCLAW_VAULT_AUTH_ROLE is required for ${method} auth.`);
  }
  return role;
}

function resolveVaultJwt(method) {
  const jwtFile =
    normalizeOptionalString(process.env.OPENCLAW_VAULT_JWT_FILE) ??
    (method === "kubernetes" ? KUBERNETES_SERVICE_ACCOUNT_TOKEN_PATH : undefined);
  if (!jwtFile) {
    throw new Error("OPENCLAW_VAULT_JWT_FILE is required for jwt auth.");
  }
  return readVaultCredentialFile(
    jwtFile,
    "Vault JWT",
    "OPENCLAW_VAULT_JWT_FILE did not contain a JWT.",
  );
}

function readVaultLoginToken(payload, method) {
  const token = payload?.auth?.client_token;
  if (typeof token !== "string" || !token.trim()) {
    throw new Error(`Vault ${method} login response did not include auth.client_token.`);
  }
  return token;
}

async function resolveVaultTokenFromJwt(baseUrl, method) {
  const mount = encodePath(resolveVaultAuthMount(method));
  const headers = {
    "Content-Type": "application/json",
  };
  addVaultNamespaceHeader(headers);
  const { response, payload } = await fetchVault(baseUrl, `${baseUrl}/v1/auth/${mount}/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      role: resolveVaultAuthRole(method),
      jwt: resolveVaultJwt(method),
    }),
  });
  if (!response.ok) {
    throw new Error(`Vault ${method} login failed (${response.status}).`);
  }
  return readVaultLoginToken(payload, method);
}

async function resolveVaultClientToken(baseUrl) {
  switch (resolveVaultAuthMethod()) {
    case "token":
      return resolveVaultTokenEnv();
    case "token_file":
      return resolveVaultTokenFile();
    case "jwt":
      return await resolveVaultTokenFromJwt(baseUrl, "jwt");
    case "kubernetes":
      return await resolveVaultTokenFromJwt(baseUrl, "kubernetes");
  }
  throw new Error("Unsupported Vault auth method.");
}

async function classifyVaultClientToken(baseUrl, vaultToken) {
  const headers = {
    "X-Vault-Token": vaultToken,
  };
  addVaultNamespaceHeader(headers);
  let response;
  let payload;
  try {
    ({ response, payload } = await fetchVault(baseUrl, `${baseUrl}/v1/auth/token/lookup-self`, {
      headers,
    }));
  } catch {
    return "unknown";
  }
  if (response.ok) {
    return "valid";
  }
  if (response.status === 401 || isInvalidVaultTokenPayload(payload)) {
    return "invalid";
  }
  // Token introspection is advisory. Preserve the concrete per-id ACL failures
  // when this probe is denied, unavailable, or otherwise inconclusive.
  return "unknown";
}

function readStringField(payload, parsedId) {
  const record = payload;
  const data = resolveKvVersion() === 2 ? record?.data?.data : record?.data;
  const value = data?.[parsedId.field];
  if (typeof value !== "string") {
    throw new Error(
      `Vault secret "${parsedId.secretPath}/${parsedId.field}" did not contain a string field "${parsedId.field}".`,
    );
  }
  return value;
}

async function readVaultSecret(baseUrl, vaultToken, id) {
  const parsedId = parseVaultSecretId(id);
  const headers = {
    "X-Vault-Token": vaultToken,
  };
  addVaultNamespaceHeader(headers);
  let response;
  let payload;
  try {
    ({ response, payload } = await fetchVault(baseUrl, buildVaultUrl(baseUrl, parsedId), {
      headers,
    }));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Vault read response for "${id}" was not valid JSON.`, { cause: error });
    }
    throw new VaultProviderError("Vault request failed.", { cause: error });
  }
  if (!response.ok) {
    if (
      response.status === 401 ||
      (response.status === 403 && isInvalidVaultTokenPayload(payload)) ||
      response.status === 408 ||
      response.status === 412 ||
      response.status === 425 ||
      response.status === 429 ||
      response.status === 472 ||
      response.status === 473 ||
      response.status >= 500
    ) {
      throw new VaultProviderError(`Vault read failed (${response.status}).`);
    }
    if (response.status === 403) {
      throw new VaultForbiddenError(`Vault read failed for "${id}" (403).`);
    }
    throw new Error(`Vault read failed for "${id}" (${response.status}).`);
  }
  return readStringField(payload, parsedId);
}

async function resolveFromVault(ids) {
  const response = { protocolVersion: 1, values: {}, errors: {} };
  if (ids.length === 0) {
    return response;
  }
  // Address and authentication are provider-wide. Let those failures terminate the
  // subprocess so OpenClaw fans one provider diagnostic out to every affected owner.
  const baseUrl = normalizeVaultAddress();
  const vaultToken = await resolveVaultClientToken(baseUrl);
  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        return { id, value: await readVaultSecret(baseUrl, vaultToken, id) };
      } catch (error) {
        return {
          id,
          error,
          providerFailure: error instanceof VaultProviderError,
          forbidden: error instanceof VaultForbiddenError,
        };
      }
    }),
  );
  const providerFailures = results.filter((result) => result.providerFailure);
  const firstProviderFailure = providerFailures[0];
  // A batch-wide outage is provider-scoped only when every requested read failed that way.
  // Mixed results retain their values and per-id failures instead of misclassifying all owners.
  if (firstProviderFailure && providerFailures.length === results.length) {
    throw firstProviderFailure.error;
  }
  if (results.every((result) => result.forbidden)) {
    if ((await classifyVaultClientToken(baseUrl, vaultToken)) === "invalid") {
      throw new VaultProviderError("Vault token is invalid.");
    }
  }
  for (const result of results) {
    if ("value" in result) {
      response.values[result.id] = result.value;
      continue;
    }
    response.errors[result.id] = {
      message: result.error instanceof Error ? result.error.message : String(result.error),
    };
  }
  return response;
}

async function main() {
  const input = await readStdin();
  const request = parseRequest(input);
  writeResponse(await resolveFromVault(request.ids));
}

/** @param {unknown} error */
function handleFatalError(error) {
  process.exitCode = 1;
  writeResponse({
    protocolVersion: 1,
    values: {},
    errors: {
      request: {
        message: error instanceof Error ? error.message : String(error),
      },
    },
  });
}

main().catch(handleFatalError);
