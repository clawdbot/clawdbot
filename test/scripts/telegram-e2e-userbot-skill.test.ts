import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const scriptsDir = path.resolve(".agents/skills/telegram-e2e-userbot/scripts");

function requireSuccess(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(result.error).toBeUndefined();
  expect(`${result.stdout}${result.stderr}`).not.toContain("not ok");
  expect(result.status, `${command} ${args.join(" ")}\n${result.stdout}${result.stderr}`).toBe(0);
}

describe("repository Telegram E2E skill", () => {
  it("replaces the obsolete Telegram Crabbox recorder skill", () => {
    expect(fs.existsSync(".agents/skills/telegram-crabbox-e2e-proof")).toBe(false);
  });

  it("registers its UI metadata through the skill interface", () => {
    const descriptor = parse(
      fs.readFileSync(".agents/skills/telegram-e2e-userbot/agents/openai.yaml", "utf8"),
    );
    expect(Object.keys(descriptor)).toEqual(["interface"]);
    expect(descriptor.interface).toMatchObject({
      display_name: "Telegram E2E (Userbot)",
      short_description: "Drive leased Telegram Test Server bots as a real QA user.",
    });
    expect(descriptor.interface.default_prompt).toContain("$telegram-e2e-userbot");
    expect(descriptor.interface.default_prompt).toContain("exact changed Telegram behavior");
    expect(descriptor.interface.default_prompt).toContain("extend the harness freely");
  });

  it("passes its Node test suite", () => {
    const tests = fs
      .readdirSync(scriptsDir)
      .filter((entry) => entry.endsWith(".test.mjs"))
      .toSorted()
      .map((entry) => path.join(scriptsDir, entry));
    expect(tests.length).toBeGreaterThan(0);
    requireSuccess(process.execPath, ["--test", ...tests]);
  });

  it("passes its Python test suite", () => {
    const tests = fs
      .readdirSync(scriptsDir)
      .filter((entry) => entry.endsWith(".test.py"))
      .toSorted();
    expect(tests.length).toBeGreaterThan(0);
    for (const test of tests) {
      requireSuccess("python3", [path.join(scriptsDir, test)]);
    }
  });
});
