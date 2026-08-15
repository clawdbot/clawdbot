import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import pLimit from "p-limit";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const PLIST_READ_CONCURRENCY = 8;
const PLIST_READ_TIMEOUT_MS = 2_000;

const SYSTEM_APP_NAMES = new Set([
  "Calendar",
  "Contacts",
  "FaceTime",
  "Home",
  "Mail",
  "Maps",
  "Messages",
  "Music",
  "Notes",
  "Photos",
  "Podcasts",
  "Reminders",
  "Shortcuts",
]);

const InfoPlistSchema = z
  .object({
    CFBundleIdentifier: z.string().trim().min(1).optional(),
  })
  .passthrough();

export type InstalledApp = {
  label: string;
  bundleId?: string;
  path: string;
  system: boolean;
};

export type InstalledAppsResult =
  | { status: "ok"; apps: InstalledApp[] }
  | { status: "unsupported"; platform: NodeJS.Platform; apps: [] };

type InstalledAppRoots = {
  applications: string;
  userApplications: string;
  systemApplications: string;
};

type ScanInstalledAppsOptions = {
  platform?: NodeJS.Platform;
  roots?: InstalledAppRoots;
  readBundleId?: (appPath: string) => Promise<string | undefined>;
};

function defaultRoots(): InstalledAppRoots {
  return {
    applications: "/Applications",
    userApplications: path.join(os.homedir(), "Applications"),
    systemApplications: "/System/Applications",
  };
}

function isBackupishBundle(label: string): boolean {
  return (
    /(?:^|[\s._-])(?:backup|previous|rollback)(?:[\s._-]|$)/i.test(label) ||
    /(?:^|[\s._-])pre-[\p{L}\p{N}._-]+$/iu.test(label)
  );
}

async function listAppPaths(
  root: string,
  system: boolean,
): Promise<Array<{ path: string; system: boolean }>> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const results = await Promise.all(
    entries.map(async (entry) => {
      if (!entry.name.toLowerCase().endsWith(".app")) {
        return [];
      }
      // Dirent.isDirectory() is false for symlinked bundles; /Applications
      // commonly holds symlinks (brew cask, hand-linked apps) — stat through.
      let isDirectory = entry.isDirectory();
      if (!isDirectory && entry.isSymbolicLink()) {
        isDirectory = await fs
          .stat(path.join(root, entry.name))
          .then((stats) => stats.isDirectory())
          .catch(() => false);
      }
      if (!isDirectory) {
        return [];
      }
      const label = entry.name.slice(0, -4);
      if (isBackupishBundle(label) || (system && !SYSTEM_APP_NAMES.has(label))) {
        return [];
      }
      return [{ path: path.join(root, entry.name), system }];
    }),
  );
  return results.flat();
}

async function readBundleIdWithPlutil(appPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", path.join(appPath, "Contents", "Info.plist")],
      { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: PLIST_READ_TIMEOUT_MS },
    );
    return InfoPlistSchema.parse(JSON.parse(stdout)).CFBundleIdentifier;
  } catch {
    return undefined;
  }
}

export async function scanInstalledApps(
  options: ScanInstalledAppsOptions = {},
): Promise<InstalledAppsResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return { status: "unsupported", platform, apps: [] };
  }

  const roots = options.roots ?? defaultRoots();
  const appPaths = (
    await Promise.all([
      listAppPaths(roots.applications, false),
      listAppPaths(roots.userApplications, false),
      listAppPaths(roots.systemApplications, true),
    ])
  ).flat();
  const readBundleId = options.readBundleId ?? readBundleIdWithPlutil;
  const limit = pLimit(PLIST_READ_CONCURRENCY);
  const apps = await Promise.all(
    appPaths.map((entry) =>
      limit(async (): Promise<InstalledApp> => {
        const bundleId = await readBundleId(entry.path);
        return {
          label: path.basename(entry.path, ".app"),
          ...(bundleId ? { bundleId } : {}),
          path: entry.path,
          system: entry.system,
        };
      }),
    ),
  );
  return {
    status: "ok",
    apps: apps.toSorted(
      (left, right) =>
        left.label.localeCompare(right.label, "en", { sensitivity: "base" }) ||
        left.path.localeCompare(right.path),
    ),
  };
}
