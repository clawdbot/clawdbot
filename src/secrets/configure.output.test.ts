import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { noteCommittedSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import { readPersistedSharedAuthProfileStoreRaw } from "../agents/auth-profiles/sqlite.js";
import { runSecretsCommand } from "../cli/secrets-cli-output.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runSecretsConfigureInteractive } from "./configure.js";

it.each([true, false])(
  "keeps configure JSON output parseable without changing shared credentials (store present: %s)",
  async (storePresent) => {
    await withOpenClawTestState({ layout: "home" }, async (state) => {
      await state.writeConfig({});
      const sharedStore = {
        version: 1,
        profiles: {
          "openai:plaintext": {
            type: "api_key",
            provider: "openai",
            key: "synthetic-plaintext-value",
          },
          "openai:residue": {
            type: "api_key",
            provider: "openai",
            key: "synthetic-residue-value",
            keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
          "openai:reference": {
            type: "api_key",
            provider: "openai",
            key: "$OPENAI_API_KEY",
          },
        },
      };
      noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, state.env);
      if (storePresent) {
        const { db } = openOpenClawStateDatabase({ env: state.env });
        try {
          db.prepare(
            "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, 1)",
          ).run("authProfiles.store", JSON.stringify(sharedStore));
        } finally {
          closeOpenClawStateDatabaseForTest();
        }
      }
      const configBefore = await fs.readFile(state.configPath, "utf8");
      const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
      let stdout = "";
      let stderr = "";
      const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        stdout += String(chunk);
        return true;
      });
      const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        stderr += String(chunk);
        return true;
      });
      try {
        Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
        await expect(
          runSecretsCommand(
            true,
            () => runSecretsConfigureInteractive({ env: state.env, skipProviderSetup: true }),
            () => {
              throw new Error("JSON failures must not use the human renderer.");
            },
            1,
          ),
        ).rejects.toMatchObject({ code: 1 });
      } finally {
        stdoutWrite.mockRestore();
        stderrWrite.mockRestore();
        if (stdinTTY) {
          Object.defineProperty(process.stdin, "isTTY", stdinTTY);
        } else {
          Reflect.deleteProperty(process.stdin, "isTTY");
        }
      }

      expect(JSON.parse(stdout)).toEqual({
        ok: false,
        error: {
          type: "cli_error",
          message: "No configurable secret-bearing fields found for this agent scope.",
        },
      });
      if (storePresent) {
        expect(stderr).toContain("2 plaintext credential(s)");
        expect(stderr).toContain("cannot migrate shared credentials");
        expect(readPersistedSharedAuthProfileStoreRaw(state.env)).toEqual(sharedStore);
      } else {
        expect(stderr).not.toContain("Shared auth-profile store");
        expect(readPersistedSharedAuthProfileStoreRaw(state.env)).toBeNull();
      }
      expect(`${stdout}${stderr}`).not.toContain("synthetic-plaintext-value");
      expect(`${stdout}${stderr}`).not.toContain("synthetic-residue-value");
      expect(await fs.readFile(state.configPath, "utf8")).toBe(configBefore);
    });
  },
);
