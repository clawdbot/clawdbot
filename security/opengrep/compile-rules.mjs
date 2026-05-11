#!/usr/bin/env node
/**
 * compile-rules.mjs
 *
 * Compiles source OpenGrep rule YAML files from a folder into OpenClaw's shipped
 * precise super-config. The input folder is intentionally generic: any nested
 * .yml/.yaml file containing a top-level `rules` array can be compiled as long
 * as each rule carries metadata.ghsa or metadata.advisory-id.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument, stringify } from "yaml";

const REPO_BASENAME = "openclaw/openclaw";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const DEFAULT_OUT_DIR = path.resolve(REPO_ROOT, "security", "opengrep");
const GHSA_RE = /^GHSA-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/;

function printHelp() {
  console.log(`Usage: node security/opengrep/compile-rules.mjs --rules-dir <path> [options]

Options:
  --rules-dir <path>     Required. Directory containing source OpenGrep YAML files.
  --out-dir <path>       Output directory for precise.yml (default: <repo>/security/opengrep).
  --advisory-repo <r>    GitHub owner/repo used in advisory-url metadata.
                         Default: ${REPO_BASENAME}
  --replace-precise      Replace precise.yml instead of appending new rule ids.
  --help                 Show this help.
`);
}

function parseArgs(argv) {
  const opts = {
    rulesDir: "",
    outDir: "",
    advisoryRepo: REPO_BASENAME,
    replacePrecise: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--rules-dir":
        opts.rulesDir = path.resolve(argv[i + 1] ?? "");
        i += 1;
        break;
      case "--run-dir":
        throw new Error(
          "--run-dir was replaced by --rules-dir; pass a folder of source rule YAML files",
        );
      case "--out-dir":
        opts.outDir = path.resolve(argv[i + 1] ?? "");
        i += 1;
        break;
      case "--advisory-repo":
        opts.advisoryRepo = argv[i + 1] ?? REPO_BASENAME;
        i += 1;
        break;
      case "--replace-precise":
        opts.replacePrecise = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!opts.rulesDir) {
    printHelp();
    throw new Error("--rules-dir is required");
  }
  return opts;
}

function sanitizeIdComponent(value) {
  return (
    String(value || "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "rule"
  );
}

function normalizeSourceId(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function sanitizeSourceIdComponent(value) {
  return sanitizeIdComponent(value).replace(/[.]+/g, "-");
}

function sourceIdFromMetadata(metadata) {
  return normalizeSourceId(metadata?.["advisory-id"] || metadata?.ghsa);
}

function buildGhsaAdvisoryUrl(advisoryRepo, ghsa) {
  return `https://github.com/${advisoryRepo}/security/advisories/${ghsa}`;
}

function toPortablePath(filePath, repoRoot = REPO_ROOT) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(repoRoot, resolved);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  return path.basename(resolved);
}

function rewriteRule(rule, params) {
  const originalId = String(rule.id ?? "rule");
  const metadata = { ...rule.metadata };
  const sourceId = sourceIdFromMetadata(metadata);
  if (!sourceId) {
    throw new Error(
      `${params.sourceFile}: rule ${originalId} must set metadata.advisory-id or metadata.ghsa`,
    );
  }

  if (GHSA_RE.test(sourceId)) {
    metadata.ghsa = sourceId;
    metadata["advisory-url"] =
      metadata["advisory-url"] || buildGhsaAdvisoryUrl(params.advisoryRepo, sourceId);
  } else if (!metadata["advisory-url"]) {
    throw new Error(
      `${params.sourceFile}: rule ${originalId} must set metadata.advisory-url for non-GHSA source ${sourceId}`,
    );
  }

  metadata["advisory-id"] = sourceId;
  metadata["detector-bucket"] = "precise";
  metadata["source-rule-id"] = originalId;
  metadata["source-file"] = toPortablePath(params.sourceFile);
  const newId = `${sanitizeSourceIdComponent(sourceId)}.${sanitizeIdComponent(originalId)}`;
  return { ...rule, id: newId, metadata };
}

async function readRuleFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  if (!raw.trim()) {
    return { rules: [], error: null };
  }
  let doc;
  try {
    doc = parseDocument(raw, { keepSourceTokens: false });
  } catch (error) {
    return { rules: [], error: `parse-error: ${error.message}` };
  }
  if (doc.errors && doc.errors.length > 0) {
    return { rules: [], error: `yaml-errors: ${doc.errors.map((e) => e.message).join("; ")}` };
  }
  const data = doc.toJSON();
  if (!data || !Array.isArray(data.rules)) {
    return { rules: [], error: "no-rules-array" };
  }
  return { rules: data.rules, error: null };
}

async function listYamlFiles(dir) {
  const out = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") {
          continue;
        }
        await walk(fullPath);
      } else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
        if (entry.name === "precise.yml") {
          continue;
        }
        out.push(fullPath);
      }
    }
  }
  await walk(dir);
  return out.toSorted((a, b) => a.localeCompare(b));
}

async function compile(opts) {
  const sourceFiles = await listYamlFiles(opts.rulesDir);
  const buckets = {
    precise: { rules: [], skipped: [] },
  };
  const manifest = {
    rulesDir: toPortablePath(opts.rulesDir),
    advisoryRepo: opts.advisoryRepo,
    generatedAt: new Date().toISOString(),
    totals: {},
    files: {},
  };

  for (const filePath of sourceFiles) {
    const fileKey = toPortablePath(filePath);
    const fileEntry = { precise: [], errors: {} };
    const { rules, error } = await readRuleFile(filePath);
    if (error) {
      buckets.precise.skipped.push({ file: fileKey, error });
      fileEntry.errors.precise = error;
    } else {
      for (const rule of rules) {
        try {
          const rewritten = rewriteRule(rule, {
            advisoryRepo: opts.advisoryRepo,
            sourceFile: filePath,
          });
          buckets.precise.rules.push(rewritten);
          fileEntry.precise.push(rewritten.id);
        } catch (error_) {
          const errorMessage = error_ instanceof Error ? error_.message : String(error_);
          buckets.precise.skipped.push({ file: fileKey, error: errorMessage });
          fileEntry.errors.precise = errorMessage;
        }
      }
    }
    if (fileEntry.precise.length || Object.keys(fileEntry.errors).length) {
      manifest.files[fileKey] = fileEntry;
    }
  }

  manifest.totals = {
    filesScanned: sourceFiles.length,
    filesWithAnyRule: Object.keys(manifest.files).length,
    preciseRulesGenerated: buckets.precise.rules.length,
    preciseSkipped: buckets.precise.skipped.length,
  };

  return { buckets, manifest };
}

function buildBucketHeader(bucket, manifest, ruleCount) {
  const count = ruleCount ?? manifest.totals.preciseRules;
  return [
    `# OpenGrep super-config: ${bucket}`,
    `#`,
    `# Auto-generated by security/opengrep/compile-rules.mjs.`,
    `# DO NOT EDIT BY HAND. Re-run the compile script after editing source rules.`,
    `#`,
    `# Source rules dir: ${manifest.rulesDir}`,
    `# Generated at    : ${manifest.generatedAt}`,
    `# Rule count      : ${count}`,
    "",
  ].join("\n");
}

async function readExistingRules(filePath) {
  const { rules, error } = await readRuleFile(filePath);
  if (error) {
    throw new Error(`Could not read existing precise rules from ${filePath}: ${error}`);
  }
  return rules;
}

function appendNewRules(existingRules, generatedRules) {
  const existingIds = new Set(existingRules.map((rule) => String(rule.id ?? "")));
  const appendedRules = [];
  const skippedDuplicateIds = [];
  for (const rule of generatedRules) {
    const id = String(rule.id ?? "");
    if (existingIds.has(id)) {
      skippedDuplicateIds.push(id);
      continue;
    }
    existingIds.add(id);
    appendedRules.push(rule);
  }
  return {
    rules: [...existingRules, ...appendedRules],
    appendedRules,
    skippedDuplicateIds,
  };
}

function detectIdCollisions(rules) {
  const seen = new Map();
  const dupes = [];
  for (const r of rules) {
    if (seen.has(r.id)) {
      dupes.push({ id: r.id, ghsas: [seen.get(r.id), r.metadata?.ghsa] });
    } else {
      seen.set(r.id, r.metadata?.ghsa || "");
    }
  }
  return dupes;
}

function disambiguateCollisions(rules) {
  const seen = new Map();
  const out = [];
  for (const r of rules) {
    let id = r.id;
    if (seen.has(id)) {
      const next = (seen.get(id) ?? 1) + 1;
      seen.set(id, next);
      id = `${id}-${next}`;
    } else {
      seen.set(id, 1);
    }
    out.push({ ...r, id });
  }
  return out;
}

function runCommand(argv, options = {}) {
  return new Promise((resolve) => {
    const { timeoutMs, ...spawnOptions } = options;
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      ...spawnOptions,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve(result);
    };
    const timer =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            child.kill("SIGKILL");
            finish({ code: null, stdout, stderr, timedOut: true });
          }, timeoutMs)
        : null;
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut: false }));
    child.on("error", (err) => finish({ code: -1, stdout, stderr: String(err), timedOut: false }));
  });
}

async function findInvalidRuleSpans(superConfigPath) {
  const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "opengrep-empty-"));
  try {
    const result = await runCommand(
      [
        "opengrep",
        "scan",
        "--no-strict",
        "--config",
        superConfigPath,
        "--json",
        "--no-git-ignore",
        emptyDir,
      ],
      { timeoutMs: 120_000 },
    );
    if (!result.stdout || result.stdout.trim() === "") {
      const tail = (result.stderr || "").trim().slice(-500);
      return {
        invalidLines: new Set(),
        errorCount: 0,
        validatorOk: false,
        validatorError: `opengrep produced no JSON output (exit code ${result.code}). stderr tail: ${tail || "(empty)"}`,
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (parseErr) {
      return {
        invalidLines: new Set(),
        errorCount: 0,
        validatorOk: false,
        validatorError: `opengrep stdout was not valid JSON (exit code ${result.code}): ${String(parseErr).slice(0, 200)}`,
      };
    }
    const invalidLines = new Set();
    const invalidRuleIds = new Set();
    const unmappedErrors = [];
    let errorCount = 0;
    for (const err of parsed.errors || []) {
      const ruleId = typeof err.rule_id === "string" ? err.rule_id : "";
      if (ruleId) {
        invalidRuleIds.add(ruleId);
        errorCount += 1;
        continue;
      }
      if (err.type === "InvalidRuleSchemaError") {
        errorCount += 1;
        for (const span of err.spans || []) {
          const start = span.start?.line;
          const end = span.end?.line ?? start;
          if (typeof start === "number" && typeof end === "number") {
            for (let line = start; line <= end; line += 1) {
              invalidLines.add(line);
            }
          }
        }
        if (!err.spans || err.spans.length === 0) {
          unmappedErrors.push(err.type);
        }
        continue;
      }
      unmappedErrors.push(err.type || "unknown");
    }
    if (result.code !== 0 && unmappedErrors.length > 0) {
      return {
        invalidLines,
        invalidRuleIds,
        errorCount,
        validatorOk: false,
        validatorError: `opengrep exited ${result.code} with unmapped errors: ${unmappedErrors.join(", ")}`,
      };
    }
    if (result.code !== 0 && invalidLines.size === 0 && invalidRuleIds.size === 0) {
      return {
        invalidLines,
        invalidRuleIds,
        errorCount,
        validatorOk: false,
        validatorError: `opengrep exited ${result.code} with no mappable rule errors`,
      };
    }
    return { invalidLines, invalidRuleIds, errorCount, validatorOk: true };
  } finally {
    await fs.rm(emptyDir, { recursive: true, force: true }).catch(() => {});
  }
}

function rulesOverlappingLines(superConfigText, invalidLines) {
  const lines = superConfigText.split("\n");
  const ruleStarts = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s{2}-\s+id:\s*/.test(lines[i])) {
      ruleStarts.push(i + 1);
    }
  }
  const bad = new Set();
  for (const ln of invalidLines) {
    let lo = 0;
    let hi = ruleStarts.length - 1;
    let pick = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ruleStarts[mid] <= ln) {
        pick = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (pick >= 0) {
      bad.add(pick);
    }
  }
  return bad;
}

async function pruneInvalidRulesForBucket(rules, manifest, bucket, outDir, maxIterations = 4) {
  let working = rules.slice();
  const droppedDetails = [];
  for (let iter = 0; iter < maxIterations; iter += 1) {
    const yamlText =
      buildBucketHeader(bucket, manifest, working.length) +
      stringify({ rules: working }, { lineWidth: 0 });
    const tmpPath = path.join(outDir, `.tmp-${bucket}.yml`);
    await fs.writeFile(tmpPath, yamlText);
    const { invalidLines, invalidRuleIds, errorCount, validatorOk, validatorError } =
      await findInvalidRuleSpans(tmpPath);
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    if (!validatorOk) {
      throw new Error(
        `opengrep schema validation failed for bucket '${bucket}'. Install opengrep ` +
          `(https://opengrep.dev) and retry. Validator error: ${validatorError}`,
      );
    }
    if (
      errorCount === 0 ||
      (invalidLines.size === 0 && (!invalidRuleIds || invalidRuleIds.size === 0))
    ) {
      return { rules: working, droppedDetails };
    }
    const badIndices = rulesOverlappingLines(yamlText, invalidLines);
    if (invalidRuleIds && invalidRuleIds.size > 0) {
      for (let i = 0; i < working.length; i += 1) {
        const ruleId = String(working[i].id ?? "");
        for (const invalidRuleId of invalidRuleIds) {
          if (invalidRuleId === ruleId || invalidRuleId.endsWith(`.${ruleId}`)) {
            badIndices.add(i);
            break;
          }
        }
      }
    }
    if (badIndices.size === 0) {
      throw new Error(
        `opengrep reported ${errorCount} invalid ${bucket} rule(s), but the compiler could not map them to generated rules`,
      );
    }
    const next = [];
    for (let i = 0; i < working.length; i += 1) {
      if (badIndices.has(i)) {
        droppedDetails.push({
          id: working[i].id,
          ghsa: working[i].metadata?.ghsa,
        });
      } else {
        next.push(working[i]);
      }
    }
    working = next;
  }
  return { rules: working, droppedDetails };
}

async function writeOutputs(buckets, manifest, outDir, opts) {
  await fs.mkdir(outDir, { recursive: true });

  const precisePath = path.join(outDir, "precise.yml");
  const existingRules = opts.replacePrecise ? [] : await readExistingRules(precisePath);
  const collisions = detectIdCollisions(buckets.precise.rules);
  if (collisions.length > 0) {
    console.error(
      `[warn] precise: ${collisions.length} duplicate generated rule ids will be auto-suffixed (-2, -3, ...).`,
    );
  }
  const disambiguated = disambiguateCollisions(buckets.precise.rules);
  const appendResult = opts.replacePrecise
    ? { rules: disambiguated, appendedRules: disambiguated, skippedDuplicateIds: [] }
    : appendNewRules(existingRules, disambiguated);

  let validRules = appendResult.rules;
  let droppedDetails = [];
  if (appendResult.rules.length > 0) {
    console.error(`[info] precise: validating ${appendResult.rules.length} rules with opengrep...`);
    ({ rules: validRules, droppedDetails } = await pruneInvalidRulesForBucket(
      appendResult.rules,
      manifest,
      "precise",
      outDir,
    ));
  } else {
    console.error("[info] precise: no rules to validate with opengrep.");
  }
  buckets.precise.invalid = droppedDetails;
  if (droppedDetails.length > 0) {
    console.error(`[warn] precise: dropped ${droppedDetails.length} rules with invalid schema.`);
  }

  const yaml = stringify({ rules: validRules }, { lineWidth: 0 });
  await fs.writeFile(precisePath, buildBucketHeader("precise", manifest, validRules.length) + yaml);

  manifest.totals.preciseRulesExisting = existingRules.length;
  manifest.totals.preciseRulesAppended = appendResult.appendedRules.length;
  manifest.totals.preciseRulesDuplicateSkipped = appendResult.skippedDuplicateIds.length;
  manifest.totals.preciseRules = validRules.length;
  manifest.totals.preciseInvalid = droppedDetails.length;
  manifest.preciseInvalid = droppedDetails;
  manifest.preciseDuplicateSkipped = appendResult.skippedDuplicateIds;
}

function printSummary(buckets, manifest, outDir) {
  console.log(`compile-rules: done`);
  console.log(`  out-dir          : ${outDir}`);
  console.log(`  files scanned    : ${manifest.totals.filesScanned}`);
  console.log(`  files with rules : ${manifest.totals.filesWithAnyRule}`);
  console.log(
    `  precise rules    : ${manifest.totals.preciseRules} total (${manifest.totals.preciseRulesExisting ?? 0} existing, ${manifest.totals.preciseRulesAppended ?? 0} appended, ${manifest.totals.preciseRulesDuplicateSkipped ?? 0} duplicate skipped, yaml-skipped: ${manifest.totals.preciseSkipped}, schema-invalid: ${manifest.totals.preciseInvalid ?? 0})`,
  );
  const totalDropped =
    (manifest.totals.preciseSkipped ?? 0) + (manifest.totals.preciseInvalid ?? 0);
  if (totalDropped > 0) {
    console.log("\nFirst few skipped/invalid rules:");
    for (const s of (buckets.precise.skipped ?? []).slice(0, 3)) {
      console.log(`  [precise] ${s.file}: yaml: ${s.error.split("\n")[0]}`);
    }
    for (const s of (buckets.precise.invalid ?? []).slice(0, 3)) {
      console.log(`  [precise] ${s.id}: schema-invalid`);
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.outDir) {
    opts.outDir = DEFAULT_OUT_DIR;
  }
  const { buckets, manifest } = await compile(opts);
  await writeOutputs(buckets, manifest, opts.outDir, opts);
  printSummary(buckets, manifest, opts.outDir);
}

main().catch((err) => {
  console.error(`compile-rules: error: ${err.message ?? err}`);
  process.exit(1);
});
