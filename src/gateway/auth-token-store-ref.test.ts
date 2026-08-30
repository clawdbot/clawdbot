import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSecretStoreValue, writeSecretStoreEntry } from "../secrets/store/secret-store.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { provisionGatewayTokenStoreRef } from "./auth-token-store-ref.js";

const STORE_SCOPE = { kind: "team" } as const;
const STORE_NAME = "OPENCLAW_GATEWAY_TOKEN";

function readStored(): string | undefined {
  const result = readSecretStoreValue({ scope: STORE_SCOPE, name: STORE_NAME });
  return result.ok ? result.value : undefined;
}

describe("provisionGatewayTokenStoreRef", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gateway-token-store-")));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("mints a token into the store and returns a default-provider store ref", () => {
    const result = provisionGatewayTokenStoreRef({ config: {} });

    expect(result.ref).toEqual({
      source: "store",
      provider: "default",
      id: STORE_NAME,
    });
    expect(result.token.length).toBeGreaterThan(8);
    expect(readStored()).toBe(result.token);
  });

  it("reuses an existing entry so reruns never rotate a paired token", () => {
    writeSecretStoreEntry({
      scope: STORE_SCOPE,
      name: STORE_NAME,
      value: "already-paired-token",
      kind: "secret",
      updatedBy: "test",
    });

    const result = provisionGatewayTokenStoreRef({ config: {} });

    expect(result.token).toBe("already-paired-token");
    expect(readStored()).toBe("already-paired-token");
  });

  it("lets an explicit token win so a persisted plaintext token migrates unchanged", () => {
    writeSecretStoreEntry({
      scope: STORE_SCOPE,
      name: STORE_NAME,
      value: "stale-token",
      kind: "secret",
      updatedBy: "test",
    });

    const result = provisionGatewayTokenStoreRef({ config: {}, token: "operator-token" });

    expect(result.token).toBe("operator-token");
    expect(readStored()).toBe("operator-token");
  });

  it("honors a configured store provider alias", () => {
    const result = provisionGatewayTokenStoreRef({
      config: { secrets: { defaults: { store: "vault" } } },
    });

    expect(result.ref.provider).toBe("vault");
  });
});
