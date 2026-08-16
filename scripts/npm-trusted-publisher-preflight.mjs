#!/usr/bin/env node

import { readBoundedResponseText } from "./lib/bounded-response.mjs";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

const AUDIENCE = "npm:registry.npmjs.org";
const NPM_REGISTRY = "https://registry.npmjs.org";
const REQUEST_TIMEOUT_MS = 20_000;
const RESPONSE_BODY_MAX_BYTES = 16 * 1024;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;

async function requestToken(url, init, label, tokenField) {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      ...init,
      signal,
    });
  } catch (error) {
    const detail =
      error instanceof Error && error.name === "TimeoutError" ? " timed out" : " failed";
    throw new Error(`${label}${detail}.`, { cause: error });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${label} failed (HTTP ${response.status}).`);
  }

  let text;
  try {
    text = await readBoundedResponseText(response, label, RESPONSE_BODY_MAX_BYTES, { signal });
  } catch (error) {
    const detail =
      error instanceof Error && error.name === "TimeoutError"
        ? " timed out"
        : " returned an invalid response body";
    throw new Error(`${label}${detail}.`, { cause: error });
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON.`, { cause: error });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`${label} returned an invalid response shape.`);
  }
  const token = body[tokenField];
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(`${label} response is missing ${tokenField}.`);
  }
  return token;
}

export async function preflightNpmTrustedPublisher(packageName) {
  if (
    typeof packageName !== "string" ||
    packageName.length > 214 ||
    !PACKAGE_NAME_PATTERN.test(packageName)
  ) {
    throw new Error("A canonical npm package name is required.");
  }

  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const githubRequestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !githubRequestToken) {
    throw new Error("GitHub OIDC request credentials are unavailable; grant id-token: write.");
  }

  let githubOidcUrl;
  try {
    githubOidcUrl = new URL(requestUrl);
  } catch {
    throw new Error("GitHub OIDC request URL is invalid.");
  }
  githubOidcUrl.searchParams.append("audience", AUDIENCE);
  const githubOidcToken = await requestToken(
    githubOidcUrl.href,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${githubRequestToken}`,
      },
    },
    "GitHub OIDC token request",
    "value",
  );

  // npm-package-arg's escapedName preserves the scope and escapes only its slash.
  const escapedPackageName = packageName.replaceAll("/", "%2f");
  await requestToken(
    `${NPM_REGISTRY}/-/npm/v1/oidc/token/exchange/package/${escapedPackageName}`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${githubOidcToken}`,
      },
    },
    `npm trusted-publisher exchange for ${packageName}`,
    "token",
  );

  console.log(`npm trusted-publisher OIDC exchange verified for ${packageName}.`);
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    await preflightNpmTrustedPublisher(process.argv[2]);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "npm trusted-publisher preflight failed.",
    );
    process.exitCode = 1;
  }
}
