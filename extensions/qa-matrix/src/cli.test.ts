import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { matrixQaCliRegistration } from "./cli.js";

describe("matrix qa cli registration", () => {
  it("keeps disposable Matrix lane flags focused", () => {
    const qa = new Command();

    matrixQaCliRegistration.register(qa);

    const matrix = qa.commands.find((command) => command.name() === "matrix");
    const optionNames = matrix?.options.map((option) => option.long) ?? [];

    expect(optionNames).toEqual(
      expect.arrayContaining([
        "--repo-root",
        "--output-dir",
        "--provider-mode",
        "--model",
        "--alt-model",
        "--scenario",
        "--fast",
        "--sut-account",
      ]),
    );
    expect(optionNames).not.toContain("--credential-source");
    expect(optionNames).not.toContain("--credential-role");
  });
});
