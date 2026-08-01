#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// Enforces release-train metadata on core gateway methods.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const descriptorPath = "src/gateway/methods/core-descriptors.ts";

function runGit(args) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `git exited ${result.status}`;
    throw new Error(
      `${detail}\nRun git fetch origin main so origin/main and its merge-base are available.`,
    );
  }
  return result.stdout.trim();
}

function tryRunGit(args) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function resolveBaseCommit() {
  const explicitBase = process.env.PROTOCOL_SINCE_BASE_SHA?.trim();
  if (explicitBase) {
    if (!/^[0-9a-f]{40}$/u.test(explicitBase)) {
      throw new Error("PROTOCOL_SINCE_BASE_SHA must be a full commit SHA.");
    }
    if (tryRunGit(["cat-file", "-e", `${explicitBase}:${descriptorPath}`]) === undefined) {
      throw new Error(`PROTOCOL_SINCE_BASE_SHA ${explicitBase} is unavailable in this checkout.`);
    }
    return explicitBase;
  }
  const mainMergeBase = tryRunGit(["merge-base", "HEAD", "origin/main"]);
  if (mainMergeBase) {
    return mainMergeBase;
  }
  // Pull-request CI checks out a synthetic merge commit without creating origin/main.
  // Its first parent is the exact base used to build the merge result.
  const parents = (tryRunGit(["show", "-s", "--format=%P", "HEAD"]) ?? "").split(/\s+/u);
  if (parents.length === 2 && parents[0]) {
    return parents[0];
  }
  throw new Error(
    "Could not resolve PROTOCOL_SINCE_BASE_SHA, origin/main, or a two-parent pull-request merge checkout.",
  );
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function stringProperty(object, key) {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const propertyName = property.name;
    const name =
      ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName)
        ? propertyName.text
        : undefined;
    if (name === key && ts.isStringLiteralLike(property.initializer)) {
      return property.initializer.text;
    }
  }
  return undefined;
}

function collectMethodSpecs(sourceText, fileName) {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  let specs;

  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "CORE_GATEWAY_METHOD_SPECS" &&
      node.initializer
    ) {
      const initializer = unwrapExpression(node.initializer);
      if (ts.isArrayLiteralExpression(initializer)) {
        specs = initializer.elements.map((element) => {
          const line =
            sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile)).line + 1;
          if (!ts.isObjectLiteralExpression(element)) {
            throw new Error(
              `${fileName}:${line} core method specs must be inline object literals so vintage metadata can be enforced.`,
            );
          }
          const name = stringProperty(element, "name");
          if (!name) {
            throw new Error(
              `${fileName}:${line} core method spec names must be string literals so additions can be compared with origin/main.`,
            );
          }
          return {
            name,
            since: stringProperty(element, "since"),
            line,
          };
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  if (!specs) {
    throw new Error(`Could not find CORE_GATEWAY_METHOD_SPECS in ${fileName}.`);
  }
  return specs;
}

function currentTrain() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const match = /^(\d{4})\.(\d{1,2})(?:\.|$)/.exec(packageJson.version);
  if (!match) {
    throw new Error(`Root package version ${JSON.stringify(packageJson.version)} is not calver.`);
  }
  return `${match[1]}.${match[2]}`;
}

try {
  const train = currentTrain();
  const mergeBase = resolveBaseCommit();
  const currentSource = fs.readFileSync(path.join(repoRoot, descriptorPath), "utf8");
  const currentSpecs = collectMethodSpecs(currentSource, descriptorPath);
  const baseSource = runGit(["show", `${mergeBase}:${descriptorPath}`]);
  const baseNames = new Set(
    collectMethodSpecs(baseSource, `${descriptorPath}@${mergeBase}`).map((s) => s.name),
  );
  const added = currentSpecs.filter((spec) => !baseNames.has(spec.name));
  const violations = added.filter((spec) => spec.since !== train);

  if (violations.length > 0) {
    console.error(`Protocol since guard failed for current train ${train}:`);
    for (const spec of violations) {
      const problem = spec.since
        ? `has since ${JSON.stringify(spec.since)}`
        : "is missing since metadata";
      console.error(
        `- ${descriptorPath}:${spec.line} ${spec.name} ${problem}; add since: ${JSON.stringify(train)}.`,
      );
    }
    process.exitCode = 1;
  } else {
    console.log(
      `protocol since guard passed: ${added.length} new core method${added.length === 1 ? "" : "s"} use train ${train}`,
    );
  }
} catch (error) {
  console.error(
    `Protocol since guard failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
