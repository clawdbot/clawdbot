import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanInstalledApps } from "./installed-apps.js";

const tempRoots: string[] = [];

async function makeFixtureRoot(): Promise<{
  root: string;
  applications: string;
  userApplications: string;
  systemApplications: string;
}> {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-installed-apps-"));
  const root = await fs.realpath(raw);
  tempRoots.push(root);
  const applications = path.join(root, "Applications");
  const userApplications = path.join(root, "UserApplications");
  const systemApplications = path.join(root, "SystemApplications");
  await Promise.all(
    [applications, userApplications, systemApplications].map((directory) =>
      fs.mkdir(directory, { recursive: true }),
    ),
  );
  return { root, applications, userApplications, systemApplications };
}

async function createApp(root: string, name: string, bundleId?: string): Promise<void> {
  const contents = path.join(root, `${name}.app`, "Contents");
  await fs.mkdir(contents, { recursive: true });
  if (!bundleId) {
    return;
  }
  await fs.writeFile(
    path.join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string></dict></plist>`,
  );
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("scanInstalledApps", () => {
  it("scans app roots, filters copies and system apps, and sorts deterministically", async () => {
    const roots = await makeFixtureRoot();
    await Promise.all([
      createApp(roots.applications, "Zulu", "com.example.zulu"),
      createApp(roots.applications, "Alpha", "com.example.alpha"),
      createApp(roots.applications, "Alpha previous", "com.example.previous"),
      createApp(roots.applications, "Zulu-pre-update", "com.example.pre"),
      createApp(roots.userApplications, "No Plist"),
      createApp(roots.systemApplications, "Mail", "com.apple.mail"),
      createApp(roots.systemApplications, "Calculator", "com.apple.calculator"),
      fs.mkdir(path.join(roots.applications, "Not An App")),
    ]);

    // The production reader shells out to macOS plutil; parse the XML fixture
    // directly so this test also runs on Linux CI.
    const readBundleId = async (appPath: string): Promise<string | undefined> => {
      try {
        const plist = await fs.readFile(path.join(appPath, "Contents", "Info.plist"), "utf8");
        return /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
      } catch {
        return undefined;
      }
    };
    const result = await scanInstalledApps({ platform: "darwin", roots, readBundleId });

    expect(result).toEqual({
      status: "ok",
      apps: [
        {
          label: "Alpha",
          bundleId: "com.example.alpha",
          path: path.join(roots.applications, "Alpha.app"),
          system: false,
        },
        {
          label: "Mail",
          bundleId: "com.apple.mail",
          path: path.join(roots.systemApplications, "Mail.app"),
          system: true,
        },
        {
          label: "No Plist",
          path: path.join(roots.userApplications, "No Plist.app"),
          system: false,
        },
        {
          label: "Zulu",
          bundleId: "com.example.zulu",
          path: path.join(roots.applications, "Zulu.app"),
          system: false,
        },
      ],
    });
  });

  it("includes symlinked app bundles", async () => {
    const roots = await makeFixtureRoot();
    await createApp(roots.applications, "RealTarget", "com.example.symlinked");
    await fs.symlink(
      path.join(roots.applications, "RealTarget.app"),
      path.join(roots.userApplications, "Linked.app"),
    );
    const readBundleId = async () => "com.example.symlinked";
    const result = await scanInstalledApps({ platform: "darwin", roots, readBundleId });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.apps.map((app) => app.label)).toContain("Linked");
    }
  });

  it("returns a typed unsupported result off macOS", async () => {
    await expect(scanInstalledApps({ platform: "linux" })).resolves.toEqual({
      status: "unsupported",
      platform: "linux",
      apps: [],
    });
  });
});
