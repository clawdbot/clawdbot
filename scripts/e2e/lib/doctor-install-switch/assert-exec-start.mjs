#!/usr/bin/env node
import fs from "node:fs";
import { parseSystemdExecStart } from "./shims/systemd-exec-start.mjs";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readProgramArguments(unitPath) {
  const execLines = fs
    .readFileSync(unitPath, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("ExecStart="));
  if (execLines.length !== 1) {
    fail(`Expected one ExecStart in ${unitPath}, found ${execLines.length}.`);
  }
  try {
    return parseSystemdExecStart(execLines[0].slice("ExecStart=".length));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return [];
  }
}

function resolveGatewayEntrypoint(programArguments) {
  const commandIndex = programArguments.findIndex(
    (arg, index, args) =>
      index > 0 &&
      !args[index - 1]?.startsWith("-") &&
      (arg === "gateway" || (arg === "node" && args[index + 1] === "run")),
  );
  if (commandIndex <= 0) {
    fail(`Could not resolve the gateway entrypoint from ${JSON.stringify(programArguments)}.`);
  }
  return programArguments[commandIndex - 1];
}

function assertEqual(label, actual, expected, argv) {
  if (actual !== expected) {
    fail(
      `Expected ${label} ${expected}, got ${actual ?? "<missing>"}.\nExecStart argv: ${JSON.stringify(argv)}`,
    );
  }
}

const [mode, unitPath, expected, positionRaw] = process.argv.slice(2);
if (!mode || !unitPath || expected === undefined) {
  fail(
    "usage: assert-exec-start.mjs entrypoint <unit-path> <expected> | argument <unit-path> <expected> <one-based-position>",
  );
}

const programArguments = readProgramArguments(unitPath);
if (mode === "entrypoint") {
  assertEqual("entrypoint", resolveGatewayEntrypoint(programArguments), expected, programArguments);
} else if (mode === "argument") {
  const position = Number.parseInt(positionRaw ?? "", 10);
  if (!Number.isSafeInteger(position) || position < 1) {
    fail(`Invalid one-based argument position: ${positionRaw ?? "<missing>"}.`);
  }
  assertEqual(
    `ExecStart argument ${position}`,
    programArguments[position - 1],
    expected,
    programArguments,
  );
} else {
  fail(`Unknown mode: ${mode}.`);
}
