import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { describeSecretResolutionError } from "./resolve-errors.js";
import { resolveSecretRefString } from "./resolve.js";
import { isRetryableSecretDegradationReason } from "./runtime-degraded-state.js";
import { writeSecretStoreEntry } from "./store/secret-store.js";

const roots: string[] = [];

async function createStateEnv(): Promise<NodeJS.ProcessEnv> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-resolve-store-"));
  roots.push(root);
  return { OPENCLAW_STATE_DIR: path.join(root, "state") };
}

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("store SecretRef resolution", () => {
  it("resolves a team store value through the implicit default provider", async () => {
    const env = await createStateEnv();
    writeSecretStoreEntry({
      scope: { kind: "team" },
      name: "STORED_API_KEY",
      value: "resolved-store-secret",
      kind: "secret",
      updatedBy: "test",
      database: { env },
    });

    await expect(
      resolveSecretRefString(
        { source: "store", provider: "default", id: "STORED_API_KEY" },
        { config: {}, env },
      ),
    ).resolves.toBe("resolved-store-secret");
  });

  it("maps a missing name to a retryable not-found degradation", async () => {
    const env = await createStateEnv();
    const error = await resolveSecretRefString(
      { source: "store", provider: "default", id: "MISSING_API_KEY" },
      { config: {}, env },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "SECRET_REF_NOT_FOUND", source: "store" });
    const reason = describeSecretResolutionError(error);
    expect(reason).toBe("secret reference was not found");
    expect(isRetryableSecretDegradationReason(reason ?? "")).toBe(true);
  });

  it("maps database access failures to provider unavailable", async () => {
    const env = await createStateEnv();
    await fs.mkdir(path.dirname(env.OPENCLAW_STATE_DIR as string), { recursive: true });
    await fs.writeFile(env.OPENCLAW_STATE_DIR as string, "not a directory", "utf8");
    const error = await resolveSecretRefString(
      { source: "store", provider: "default", id: "STORED_API_KEY" },
      { config: {}, env },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "SECRET_PROVIDER_UNAVAILABLE", source: "store" });
    expect(describeSecretResolutionError(error)).toBe("secret provider failed");
  });
});
