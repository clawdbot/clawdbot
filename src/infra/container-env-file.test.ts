// Container environment transport keeps values private while preserving engine env-file semantics.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createContainerEnvFile, withContainerEnvFile } from "./container-env-file.js";

describe("container environment transport", () => {
  it("preserves UTF-8, spaces, equals, empty values, and surrounding whitespace in a private env file", async () => {
    const environment = {
      PLAIN: "synthetic-container-value",
      SPACES: "two synthetic words",
      EQUALS: "synthetic=left=right",
      EMPTY: "",
      WHITESPACE: "  synthetic padded value  ",
      UTF8: "synthetic-🦞-環境",
    };
    const staged = await createContainerEnvFile(environment);

    try {
      expect(await fs.readFile(staged.path, "utf8")).toBe(
        Object.entries(environment)
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => `${key}=${value}\n`)
          .join(""),
      );
      expect((await fs.stat(path.dirname(staged.path))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(staged.path)).mode & 0o777).toBe(0o600);
    } finally {
      await staged.cleanup();
    }

    await expect(fs.access(staged.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.dirname(staged.path))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(staged.cleanup()).resolves.toBeUndefined();
  });

  it.each([
    "",
    "1INVALID",
    "BAD-NAME",
    "BAD NAME",
    "BAD=NAME",
    "BAD\nNAME",
    " LEADING_SPACE",
    "TRAILING_SPACE ",
  ])("rejects unrepresentable environment name %j without exposing its value", async (key) => {
    const syntheticValue = "synthetic-invalid-name-sentinel";
    const error = await createContainerEnvFile({ [key]: syntheticValue }).catch(
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("environment variable name");
    expect((error as Error).message).not.toContain(syntheticValue);
  });

  it.each([
    ["line feed", "synthetic-before\nsynthetic-after"],
    ["carriage return", "synthetic-before\rsynthetic-after"],
    ["CRLF", "synthetic-before\r\nsynthetic-after"],
  ])("rejects %s values with an actionable key-only error", async (_kind, value) => {
    const error = await createContainerEnvFile({ SYNTHETIC_MULTILINE: value }).catch(
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("SYNTHETIC_MULTILINE");
    expect((error as Error).message).toContain("single-line");
    expect((error as Error).message).toContain("--env-file");
    expect((error as Error).message).not.toContain("synthetic-before");
    expect((error as Error).message).not.toContain("synthetic-after");
  });

  it("rejects NUL values without exposing the rejected value", async () => {
    const error = await createContainerEnvFile({ SYNTHETIC_NUL: "synthetic-before\0after" }).catch(
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("SYNTHETIC_NUL");
    expect((error as Error).message).not.toContain("synthetic-before");
  });

  it.each(["completed", "failed"] as const)(
    "keeps the callback env file alive until its %s operation settles",
    async (outcome) => {
      let stagedPath = "";
      const operationError = new Error("synthetic callback failure");
      const operation = withContainerEnvFile(
        { SYNTHETIC_CALLBACK: "synthetic-callback-value" },
        async (envFilePath) => {
          stagedPath = envFilePath;
          expect(await fs.readFile(envFilePath, "utf8")).toBe(
            "SYNTHETIC_CALLBACK=synthetic-callback-value\n",
          );
          if (outcome === "failed") {
            throw operationError;
          }
          return "synthetic callback result";
        },
      );

      if (outcome === "failed") {
        await expect(operation).rejects.toBe(operationError);
      } else {
        await expect(operation).resolves.toBe("synthetic callback result");
      }
      await expect(fs.access(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(path.dirname(stagedPath))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
