// Windows command shim helpers create test shims for Windows command execution.
import fs from "node:fs/promises";
import path from "node:path";

// Creates a tiny Windows .cmd shim plus target script for command-resolution
// tests that need to verify shim parsing without invoking npm-installed bins.
export async function createWindowsCmdShimFixture(params: {
  shimPath: string;
  scriptPath: string;
  shimLine: string;
}): Promise<void> {
  await fs.mkdir(path.dirname(params.scriptPath), { recursive: true });
  await fs.mkdir(path.dirname(params.shimPath), { recursive: true });
  await fs.writeFile(params.scriptPath, "module.exports = {};\n", "utf8");
  await fs.writeFile(params.shimPath, `@echo off\r\n${params.shimLine}\r\n`, "utf8");
}
