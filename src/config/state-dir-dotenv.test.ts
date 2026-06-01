import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readStateDirDotEnvVarsFromStateDir } from "./state-dir-dotenv.js";

describe("readStateDirDotEnvVarsFromStateDir", () => {
  async function withDotEnv<T>(content: string, run: (dir: string) => T | Promise<T>): Promise<T> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dotenv-test-"));
    await fs.writeFile(path.join(dir, ".env"), content, "utf8");
    try {
      return await run(dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  it("returns real credential values from the state-dir dotenv", async () => {
    await withDotEnv("SUPERMEMORY_API_KEY=sm_real_credential_value\n", async (dir) => {
      const result = readStateDirDotEnvVarsFromStateDir(dir);
      expect(result["SUPERMEMORY_API_KEY"]).toBe("sm_real_credential_value");
    });
  });

  it("skips values that are unresolved shell variable references", async () => {
    const content = [
      'SUPERMEMORY_OPENCLAW_API_KEY="${SUPERMEMORY_OPENCLAW_KEY}"',
      "QUOTED_SUPERMEMORY_OPENCLAW_API_KEY='\"$SUPERMEMORY_OPENCLAW_KEY\"'",
      "QUOTED_CURLY_KEY=\"'${ANOTHER_VAR}'\"",
      "BRACE_DEFAULT_KEY=${ANOTHER_VAR:-fallback}",
      "QUOTED_BRACE_DEFAULT_KEY='\"${ANOTHER_VAR:-fallback}\"'",
      'BRACE_TRIM_KEY="${ANOTHER_VAR#prefix}"',
      "BRACE_REPLACE_KEY=${ANOTHER_VAR/pattern/replacement}",
      "BRACE_CASE_KEY=${ANOTHER_VAR^^}",
      'COMMAND_KEY="$(hostname)"',
      "OTHER_KEY=$SOME_SHELL_VAR",
      "CURLY_KEY=${ANOTHER_VAR}",
      "REAL_KEY=actual_value_here",
    ].join("\n");

    await withDotEnv(content, async (dir) => {
      const result = readStateDirDotEnvVarsFromStateDir(dir);
      expect(Object.keys(result)).not.toContain("SUPERMEMORY_OPENCLAW_API_KEY");
      expect(Object.keys(result)).not.toContain("QUOTED_SUPERMEMORY_OPENCLAW_API_KEY");
      expect(Object.keys(result)).not.toContain("QUOTED_CURLY_KEY");
      expect(Object.keys(result)).not.toContain("BRACE_DEFAULT_KEY");
      expect(Object.keys(result)).not.toContain("QUOTED_BRACE_DEFAULT_KEY");
      expect(Object.keys(result)).not.toContain("BRACE_TRIM_KEY");
      expect(Object.keys(result)).not.toContain("BRACE_REPLACE_KEY");
      expect(Object.keys(result)).not.toContain("BRACE_CASE_KEY");
      expect(Object.keys(result)).not.toContain("COMMAND_KEY");
      expect(Object.keys(result)).not.toContain("OTHER_KEY");
      expect(Object.keys(result)).not.toContain("CURLY_KEY");
      expect(result["REAL_KEY"]).toBe("actual_value_here");
    });
  });

  it("preserves credential values that merely contain a dollar sign", async () => {
    const content = [
      "PASSWORD=abc$2!xyz",
      "TOKEN=tok_$prod_v2",
      "PRICE=\\$100",
      "QUOTED_PASSWORD='\"abc$2!xyz\"'",
      "QUOTED_PRICE='\"$100\"'",
      "LEADING_DOLLAR_PASSWORD=$ecret123",
      "LEADING_DOLLAR_TOKEN=$token_1",
      "LOWERCASE_BRACE=${lowercase_literal}",
      "PURE_REF=$SOME_VAR",
    ].join("\n");

    await withDotEnv(content, async (dir) => {
      const result = readStateDirDotEnvVarsFromStateDir(dir);
      expect(result["PASSWORD"]).toBe("abc$2!xyz");
      expect(result["TOKEN"]).toBe("tok_$prod_v2");
      expect(result["PRICE"]).toBe("\\$100");
      expect(result["QUOTED_PASSWORD"]).toBe('"abc$2!xyz"');
      expect(result["QUOTED_PRICE"]).toBe('"$100"');
      expect(result["LEADING_DOLLAR_PASSWORD"]).toBe("$ecret123");
      expect(result["LEADING_DOLLAR_TOKEN"]).toBe("$token_1");
      expect(result["LOWERCASE_BRACE"]).toBe("${lowercase_literal}");
      expect(Object.keys(result)).not.toContain("PURE_REF");
    });
  });

  it("returns empty object when .env is missing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dotenv-missing-"));
    try {
      expect(readStateDirDotEnvVarsFromStateDir(dir)).toEqual({});
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
