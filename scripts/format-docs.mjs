#!/usr/bin/env node

// Formats docs Markdown/MDX and repairs Mintlify accordion indentation.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveRepoToolBinPath } from "./lib/local-heavy-check-runtime.mjs";
import { repairMintlifyAccordionIndentation } from "./lib/mintlify-accordion.mjs";
import { outputTail } from "./lib/output-tail.mjs";
import { buildCmdExeCommandLine, resolveWindowsCmdExePath } from "./windows-cmd-helpers.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const CHECK = process.argv.includes("--check");
const DOCS_FORMAT_MAX_BUFFER_BYTES = 1024 * 1024 * 16;
const DOCS_FORMAT_MAX_COMMAND_LINE_BYTES = 24 * 1024;
const FAILURE_OUTPUT_TAIL_BYTES = 16 * 1024;

function outputText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return "";
}

function commandFailureMessage(label, result, invocation) {
  const details = [];
  if (invocation) {
    details.push(`command: ${invocation.command}`);
    if (invocation.args.length > 0) {
      const previewArgs = invocation.args.slice(0, 12).join(" ");
      const suffix = invocation.args.length > 12 ? ` ... (${invocation.args.length} args)` : "";
      details.push(`args: ${previewArgs}${suffix}`);
    }
  }
  if (result.error?.message) {
    details.push(result.error.message);
  }
  if (result.status !== null && result.status !== undefined && result.status !== 0) {
    details.push(`exit status: ${result.status}`);
  }
  if (result.signal) {
    details.push(`signal: ${result.signal}`);
  }
  const stderrTail = outputTail(result.stderr, FAILURE_OUTPUT_TAIL_BYTES);
  if (stderrTail) {
    details.push(`stderr tail:\n${stderrTail}`);
  }
  const stdoutTail = outputTail(result.stdout, FAILURE_OUTPUT_TAIL_BYTES);
  if (stdoutTail) {
    details.push(`stdout tail:\n${stdoutTail}`);
  }
  return `${label} failed${details.length > 0 ? `:\n${details.join("\n")}` : ""}`;
}

export function docsFiles(root = ROOT, deps = {}) {
  const spawnSyncImpl = deps.spawnSync ?? spawnSync;
  const result = spawnSyncImpl("git", ["ls-files", "docs/**/*.md", "docs/**/*.mdx", "README.md"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: DOCS_FORMAT_MAX_BUFFER_BYTES,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      commandFailureMessage("git ls-files", result, {
        command: "git",
        args: ["ls-files", "docs/**/*.md", "docs/**/*.mdx", "README.md"],
      }),
    );
  }
  return outputText(result.stdout)
    .split("\n")
    .filter(Boolean)
    .filter((relativePath) => (deps.existsSync ?? fs.existsSync)(path.join(root, relativePath)));
}

function commandLineBytes(args) {
  return args.reduce((total, arg) => total + Buffer.byteLength(arg, "utf8") + 3, 0);
}

export function chunkFilesForCommand(
  files,
  prefixArgs,
  maxBytes = DOCS_FORMAT_MAX_COMMAND_LINE_BYTES,
) {
  const chunks = [];
  let chunk = [];
  let chunkBytes = commandLineBytes(prefixArgs);

  for (const file of files) {
    const fileBytes = Buffer.byteLength(file, "utf8") + 3;
    if (chunk.length > 0 && chunkBytes + fileBytes > maxBytes) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = commandLineBytes(prefixArgs);
    }
    chunk.push(file);
    chunkBytes += fileBytes;
  }

  if (chunk.length > 0) {
    chunks.push(chunk);
  }

  return chunks;
}

export function resolveOxfmtInvocation(args, params = {}) {
  const repoRoot = params.repoRoot ?? ROOT;
  const platform = params.platform ?? process.platform;
  const existsSync = params.existsSync ?? fs.existsSync;
  const shimName = platform === "win32" ? "oxfmt.cmd" : "oxfmt";
  const shimPath = resolveRepoToolBinPath(shimName, { cwd: repoRoot, fileExists: existsSync });

  if (existsSync(shimPath)) {
    if (platform === "win32") {
      const comSpec = params.comSpec ?? resolveWindowsCmdExePath(params.env ?? process.env);
      return {
        command: comSpec,
        args: ["/d", "/s", "/c", buildCmdExeCommandLine(shimPath, args)],
        shell: false,
        windowsVerbatimArguments: true,
      };
    }
    return {
      command: shimPath,
      args,
      shell: false,
    };
  }

  return {
    command: params.nodeExecPath ?? process.execPath,
    args: [path.join(repoRoot, "node_modules", "oxfmt", "bin", "oxfmt"), ...args],
    shell: false,
  };
}

export function runOxfmt(files, params = {}, deps = {}) {
  if (files.length === 0) {
    return;
  }
  const repoRoot = params.repoRoot ?? ROOT;
  const spawnSyncImpl = deps.spawnSync ?? spawnSync;
  const prefixArgs = ["--write", "--threads=1", "--config", path.join(repoRoot, ".oxfmtrc.jsonc")];
  for (const chunk of chunkFilesForCommand(
    files,
    prefixArgs,
    params.maxCommandLineBytes ?? DOCS_FORMAT_MAX_COMMAND_LINE_BYTES,
  )) {
    const invocation = resolveOxfmtInvocation([...prefixArgs, ...chunk], {
      comSpec: params.comSpec,
      existsSync: deps.existsSync,
      nodeExecPath: params.nodeExecPath,
      platform: params.platform,
      repoRoot,
    });
    const result = spawnSyncImpl(invocation.command, invocation.args, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: DOCS_FORMAT_MAX_BUFFER_BYTES,
      shell: invocation.shell,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });

    if (result.error || result.status !== 0) {
      throw new Error(commandFailureMessage("oxfmt", result, invocation));
    }
  }
}

function repairFiles(root, files) {
  const changed = [];
  for (const relativePath of files) {
    const absolutePath = path.join(root, relativePath);
    const raw = fs.readFileSync(absolutePath, "utf8");
    const formatted = repairMintlifyAccordionIndentation(raw);
    if (formatted === raw) {
      continue;
    }
    fs.writeFileSync(absolutePath, formatted);
    changed.push(relativePath);
  }
  return changed;
}

function copyDocsToTemp(root, files) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-docs-format-"));
  for (const relativePath of files) {
    const source = path.join(root, relativePath);
    const target = path.join(tempRoot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  return tempRoot;
}

export function formatDocs(params = {}, deps = {}) {
  const root = params.root ?? ROOT;
  const check = params.check ?? false;
  const changed = [];
  const files = docsFiles(root, deps);

  if (check) {
    const tempRoot = copyDocsToTemp(root, files);
    try {
      runOxfmt(
        files.map((relativePath) => path.join(tempRoot, relativePath)),
        { ...params, repoRoot: root },
        deps,
      );
      repairFiles(tempRoot, files);
      for (const relativePath of files) {
        const raw = fs.readFileSync(path.join(root, relativePath), "utf8");
        const formatted = fs.readFileSync(path.join(tempRoot, relativePath), "utf8");
        if (formatted !== raw) {
          changed.push(relativePath);
        }
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  } else {
    runOxfmt(files, { ...params, repoRoot: root }, deps);
    changed.push(...repairFiles(root, files));
  }

  return {
    changed,
    fileCount: files.length,
  };
}

function main() {
  const { changed, fileCount } = formatDocs({ check: CHECK, root: ROOT });

  if (CHECK && changed.length > 0) {
    console.error(`Format issues found in ${changed.length} docs file(s):`);
    for (const relativePath of changed) {
      console.error(`- ${relativePath}`);
    }
    process.exit(1);
  }

  if (changed.length > 0) {
    console.log(`Formatted ${changed.length} docs file(s).`);
  } else {
    console.log(`Docs formatting clean (${fileCount} files).`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
