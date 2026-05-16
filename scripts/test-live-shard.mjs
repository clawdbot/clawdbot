#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPnpmRunner } from "./pnpm-runner.mjs";

const LIVE_TEST_SUFFIX = ".live.test.ts";

export const RELEASE_LIVE_TEST_SHARDS = Object.freeze([
  "native-live-src-agents",
  "native-live-src-gateway-core",
  "native-live-src-gateway-profiles",
  "native-live-src-gateway-backends",
  "native-live-src-infra",
  "native-live-test",
  "native-live-extensions-a-k",
  "native-live-extensions-l-n",
  "native-live-extensions-moonshot",
  "native-live-extensions-openai",
  "native-live-extensions-o-z-other",
  "native-live-extensions-xai",
  "native-live-extensions-media-audio",
  "native-live-extensions-media-music-google",
  "native-live-extensions-media-music-minimax",
  "native-live-extensions-media-video",
]);

export const LIVE_TEST_SHARDS = Object.freeze([
  ...RELEASE_LIVE_TEST_SHARDS,
  "native-live-extensions-o-z",
  "native-live-extensions-media",
  "native-live-extensions-media-music",
]);

function walkFiles(rootDir) {
  const files = [];
  if (!fs.existsSync(rootDir)) {
    return files;
  }
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === "node_modules" ||
          entry.name === "dist" ||
          entry.name === "vendor" ||
          entry.name === "fixtures"
        ) {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

export function collectAllLiveTestFiles(repoRoot = process.cwd()) {
  const externalFiles = listExternalLiveTestFiles(repoRoot);
  if (externalFiles) {
    return externalFiles;
  }
  return ["src", "test", "extensions"]
    .flatMap((dir) => walkFiles(path.join(repoRoot, dir)))
    .map((file) => path.relative(repoRoot, file).split(path.sep).join("/"))
    .filter((file) => file.endsWith(LIVE_TEST_SUFFIX))
    .toSorted((a, b) => a.localeCompare(b));
}

function listExternalLiveTestFiles(repoRoot) {
  return listGitLiveTestFiles(repoRoot) ?? listFindLiveTestFiles(repoRoot);
}

function listGitLiveTestFiles(repoRoot) {
  const result = spawnSync("git", ["ls-files", "--", "src", "test", "extensions"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 4,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((file) => file.endsWith(LIVE_TEST_SUFFIX))
    .toSorted((a, b) => a.localeCompare(b));
}

function listFindLiveTestFiles(repoRoot) {
  const roots = ["src", "test", "extensions"].map((dir) => path.join(repoRoot, dir));
  const result = spawnSync(
    "find",
    [
      ...roots,
      "(",
      "-name",
      "node_modules",
      "-o",
      "-name",
      "dist",
      "-o",
      "-name",
      "vendor",
      "-o",
      "-name",
      "fixtures",
      ")",
      "-prune",
      "-o",
      "-type",
      "f",
      "-name",
      `*${LIVE_TEST_SUFFIX}`,
      "-print",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 4,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((file) => file.length > 0)
    .map((file) => path.relative(repoRoot, file).split(path.sep).join("/"))
    .toSorted((a, b) => a.localeCompare(b));
}

function extensionKey(file) {
  const relative = file.slice("extensions/".length);
  return relative.split("/", 1)[0]?.toLowerCase() ?? "";
}

function isExtensionInRange(file, start, end) {
  if (!file.startsWith("extensions/")) {
    return false;
  }
  const key = extensionKey(file);
  if (!key) {
    return false;
  }
  const first = key[0];
  return first >= start && first <= end;
}

function isGatewayBackendLiveTest(file) {
  return (
    file === "src/gateway/gateway-acp-bind.live.test.ts" ||
    file === "src/gateway/gateway-cli-backend.live.test.ts" ||
    file === "src/gateway/gateway-codex-bind.live.test.ts" ||
    file === "src/gateway/gateway-codex-harness.live.test.ts"
  );
}

function isGatewayProfilesLiveTest(file) {
  return file === "src/gateway/gateway-models.profiles.live.test.ts";
}

function isExtensionMediaLiveTest(file) {
  return (
    file === "extensions/music-generation-providers.live.test.ts" ||
    file === "extensions/minimax/minimax.live.test.ts" ||
    file === "extensions/openai/openai-tts.live.test.ts" ||
    file === "extensions/video-generation-providers.live.test.ts" ||
    file === "extensions/volcengine/tts.live.test.ts" ||
    file === "extensions/vydra/vydra.live.test.ts"
  );
}

function isExtensionMediaMusicLiveTest(file) {
  return file === "extensions/music-generation-providers.live.test.ts";
}

function isExtensionMediaVideoLiveTest(file) {
  return file === "extensions/video-generation-providers.live.test.ts";
}

function isExtensionMediaAudioLiveTest(file) {
  return (
    isExtensionMediaLiveTest(file) &&
    !isExtensionMediaMusicLiveTest(file) &&
    !isExtensionMediaVideoLiveTest(file)
  );
}

function isXaiLiveTest(file) {
  return file.startsWith("extensions/xai/");
}

function isMoonshotLiveTest(file) {
  return file.startsWith("extensions/moonshot/");
}

export function selectLiveShardFiles(shard, files = collectAllLiveTestFiles()) {
  switch (shard) {
    case "native-live-src-agents":
      return files.filter((file) => file.startsWith("src/agents/"));
    case "native-live-src-gateway":
      return files.filter(
        (file) => file.startsWith("src/gateway/") || file.startsWith("src/crestodian/"),
      );
    case "native-live-src-gateway-core":
      return files.filter(
        (file) =>
          (file.startsWith("src/gateway/") || file.startsWith("src/crestodian/")) &&
          !isGatewayBackendLiveTest(file) &&
          !isGatewayProfilesLiveTest(file),
      );
    case "native-live-src-gateway-profiles":
      return files.filter(isGatewayProfilesLiveTest);
    case "native-live-src-gateway-backends":
      return files.filter(isGatewayBackendLiveTest);
    case "native-live-src-infra":
      return files.filter((file) => file.startsWith("src/infra/"));
    case "native-live-test":
      return files.filter((file) => file.startsWith("test/"));
    case "native-live-extensions-a-k":
      return files.filter((file) => isExtensionInRange(file, "a", "k"));
    case "native-live-extensions-l-n":
      return files.filter(
        (file) =>
          isExtensionInRange(file, "l", "n") &&
          !file.startsWith("extensions/openai/") &&
          !isMoonshotLiveTest(file) &&
          !isExtensionMediaLiveTest(file),
      );
    case "native-live-extensions-moonshot":
      return files.filter(isMoonshotLiveTest);
    case "native-live-extensions-openai":
      return files.filter(
        (file) => file.startsWith("extensions/openai/") && !isExtensionMediaLiveTest(file),
      );
    case "native-live-extensions-o-z":
      return files.filter(
        (file) =>
          isExtensionInRange(file, "o", "z") &&
          !file.startsWith("extensions/openai/") &&
          !isExtensionMediaLiveTest(file),
      );
    case "native-live-extensions-o-z-other":
      return files.filter(
        (file) =>
          isExtensionInRange(file, "o", "z") &&
          !file.startsWith("extensions/openai/") &&
          !isExtensionMediaLiveTest(file) &&
          !isXaiLiveTest(file),
      );
    case "native-live-extensions-xai":
      return files.filter(isXaiLiveTest);
    case "native-live-extensions-media":
      return files.filter(isExtensionMediaLiveTest);
    case "native-live-extensions-media-audio":
      return files.filter(isExtensionMediaAudioLiveTest);
    case "native-live-extensions-media-music":
    case "native-live-extensions-media-music-google":
    case "native-live-extensions-media-music-minimax":
      return files.filter(isExtensionMediaMusicLiveTest);
    case "native-live-extensions-media-video":
      return files.filter(isExtensionMediaVideoLiveTest);
    case "native-live-extensions-l-z":
      return files.filter((file) => isExtensionInRange(file, "l", "z"));
    default:
      throw new Error(
        `Unknown live test shard '${shard}'. Expected one of: ${LIVE_TEST_SHARDS.join(", ")}`,
      );
  }
}

function usage() {
  console.error(`Usage: node scripts/test-live-shard.mjs <${LIVE_TEST_SHARDS.join("|")}> [--list]`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const shard = args.find((arg) => !arg.startsWith("-"));
  const listOnly = args.includes("--list");
  if (!shard) {
    usage();
    process.exit(2);
  }

  let files;
  try {
    files = selectLiveShardFiles(shard);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage();
    process.exit(2);
  }
  if (files.length === 0) {
    console.error(`Live test shard '${shard}' selected no files.`);
    process.exit(2);
  }

  if (listOnly) {
    for (const file of files) {
      console.log(file);
    }
    process.exit(0);
  }

  console.log(`[test:live:shard] ${shard}: ${files.length} file(s)`);
  const child = spawnPnpmRunner({
    stdio: "inherit",
    pnpmArgs: ["test:live", "--", ...files],
    env: process.env,
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
  child.on("error", (error) => {
    console.error(error);
    process.exit(1);
  });
}
