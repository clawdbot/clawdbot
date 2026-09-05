// Daemon inspect tests cover service inspection and diagnostic output.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  detectMarkerLineWithGateway,
  findExtraGatewayServices,
  renderGatewayServiceCleanupHints,
} from "./inspect.js";

const { execSchtasksMock } = vi.hoisted(() => ({
  execSchtasksMock: vi.fn(),
}));

vi.mock("./schtasks-exec.js", () => ({
  execSchtasks: (...args: unknown[]) => execSchtasksMock(...args),
}));

// File-scope cleanup cannot prevent the nested platform-restoration hooks from running.
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Real content from the openclaw-gateway.service unit file (the canonical gateway unit).
const GATEWAY_SERVICE_CONTENTS = `\
[Unit]
Description=OpenClaw Gateway
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/node /home/openclaw/.npm-global/lib/node_modules/openclaw/dist/entry.js gateway --port 18789
Restart=always
Environment=OPENCLAW_SERVICE_MARKER=openclaw
Environment=OPENCLAW_SERVICE_KIND=gateway

[Install]
WantedBy=default.target
`;

// Real content from the openclaw-test.service unit file (a non-gateway openclaw service).
const TEST_SERVICE_CONTENTS = `\
[Unit]
Description=OpenClaw test service
After=default.target

[Service]
Type=simple
ExecStart=/bin/sh -c 'while true; do sleep 60; done'
Restart=on-failure

[Install]
WantedBy=default.target
`;

const CLAWDBOT_GATEWAY_CONTENTS = `\
[Unit]
Description=Clawdbot Gateway
[Service]
ExecStart=/usr/bin/node /opt/clawdbot/dist/entry.js gateway --port 18789
Environment=HOME=/home/clawdbot
`;

const COMPANION_SERVICE_CONTENTS = `\
[Unit]
Description=OpenClaw companion worker
After=openclaw-gateway.service
Requires=openclaw-gateway.service

[Service]
ExecStart=/usr/bin/node /opt/openclaw-worker/dist/index.js worker
`;

const CUSTOM_OPENCLAW_GATEWAY_CONTENTS = `\
[Unit]
Description=Custom OpenClaw gateway

[Service]
ExecStart=/usr/bin/node /opt/openclaw/dist/entry.js gateway --port 18888
`;

describe("detectMarkerLineWithGateway", () => {
  it("returns null for openclaw-test.service (openclaw only in description, no gateway on same line)", () => {
    expect(detectMarkerLineWithGateway(TEST_SERVICE_CONTENTS)).toBeNull();
  });

  it("returns openclaw for the canonical gateway unit (ExecStart has both openclaw and gateway)", () => {
    expect(detectMarkerLineWithGateway(GATEWAY_SERVICE_CONTENTS)).toBe("openclaw");
  });

  it("returns clawdbot for a clawdbot gateway unit", () => {
    expect(detectMarkerLineWithGateway(CLAWDBOT_GATEWAY_CONTENTS)).toBe("clawdbot");
  });

  it.each([
    "ExecStart=/usr/bin/openclaw \\\n  gateway",
    "# comment \\\nExecStart=/usr/bin/openclaw gateway",
    "; comment \\\nExecStart=/usr/bin/openclaw gateway",
    "ExecStart=/usr/bin/openclaw \\\n# comment\n  gateway",
  ])("detects commands through native comments and continuations: %s", (command) => {
    expect(detectMarkerLineWithGateway(`[Service]\n${command}\n`)).toBe("openclaw");
  });

  it.each(["After", "Requires", "Description", "Environment"])(
    "ignores gateway mentions in %s instead of an executable directive",
    (key) => {
      expect(detectMarkerLineWithGateway(`${key}=openclaw gateway\n`)).toBeNull();
    },
  );

  it("ignores dependency-only references to the gateway unit", () => {
    expect(detectMarkerLineWithGateway(COMPANION_SERVICE_CONTENTS)).toBeNull();
  });

  it("ignores non-gateway ExecStart commands that only pass gateway-named options", () => {
    const contents = `[Service]\nExecStart=/usr/bin/openclaw-helper --gateway-url http://127.0.0.1:18789 sync\n`;
    expect(detectMarkerLineWithGateway(contents)).toBeNull();
  });
});

describe("renderGatewayServiceCleanupHints", () => {
  it("does not suggest removing a gateway when no extra service was detected", () => {
    expect(renderGatewayServiceCleanupHints([])).toEqual([]);
  });

  it.each([
    {
      title: "targets the detected macOS LaunchAgent instead of the active gateway",
      platform: "darwin",
      serviceName: "com.example.openclaw-gateway",
      source: "plist: /Users/test/Library/LaunchAgents/com.example.openclaw-gateway.plist",
      scope: "user",
      stopCommand: "launchctl bootout gui/$UID/com.example.openclaw-gateway",
      removeCommand: "rm /Users/test/Library/LaunchAgents/com.example.openclaw-gateway.plist",
    },
    {
      title: "uses the system domain for a detected macOS LaunchDaemon",
      platform: "darwin",
      serviceName: "com.example.openclaw-gateway",
      source: "plist: /Library/LaunchDaemons/com.example.openclaw-gateway.plist",
      scope: "system",
      stopCommand: "sudo launchctl bootout system/com.example.openclaw-gateway",
      removeCommand: "sudo rm /Library/LaunchDaemons/com.example.openclaw-gateway.plist",
    },
    {
      title: "keeps global macOS LaunchAgents in the GUI domain",
      platform: "darwin",
      serviceName: "com.example.openclaw-gateway",
      source: "plist: /Library/LaunchAgents/com.example.openclaw-gateway.plist",
      scope: "system",
      stopCommand: "launchctl bootout gui/$UID/com.example.openclaw-gateway",
      removeCommand: "sudo rm /Library/LaunchAgents/com.example.openclaw-gateway.plist",
    },
    {
      title: "targets the detected user-level systemd unit",
      platform: "linux",
      serviceName: "custom-gateway.service",
      source: "unit: /home/test/.config/systemd/user/custom-gateway.service",
      scope: "user",
      stopCommand: "systemctl --user disable --now -- custom-gateway.service",
      removeCommand: "rm /home/test/.config/systemd/user/custom-gateway.service",
    },
    {
      title: "targets the detected system-level systemd unit",
      platform: "linux",
      serviceName: "custom-gateway.service",
      source: "unit: /etc/systemd/system/custom-gateway.service",
      scope: "system",
      stopCommand: "sudo systemctl disable --now -- custom-gateway.service",
      removeCommand: "sudo rm /etc/systemd/system/custom-gateway.service",
    },
    {
      title: "terminates systemctl options before a detected unit that begins with a dash",
      platform: "linux",
      serviceName: "-custom-gateway.service",
      source: "unit: /home/test/.config/systemd/user/-custom-gateway.service",
      scope: "user",
      stopCommand: "systemctl --user disable --now -- -custom-gateway.service",
      removeCommand: "rm /home/test/.config/systemd/user/-custom-gateway.service",
    },
    {
      title: "shell-quotes detected POSIX service labels and paths",
      platform: "darwin",
      serviceName: "com.example.gateway; touch injected",
      source: "plist: /Users/test/Launch Agents/example's gateway.plist",
      scope: "user",
      stopCommand: "launchctl bootout gui/$UID/'com.example.gateway; touch injected'",
      removeCommand: "rm '/Users/test/Launch Agents/example'\\''s gateway.plist'",
    },
  ] as const)("$title", ({ platform, serviceName, source, scope, stopCommand, removeCommand }) => {
    expect(
      renderGatewayServiceCleanupHints([
        {
          platform,
          label: serviceName,
          detail: source,
          scope,
        },
      ]),
    ).toEqual([stopCommand, removeCommand]);
  });

  it("targets the detected Windows scheduled task", () => {
    expect(
      renderGatewayServiceCleanupHints([
        {
          platform: "win32",
          label: "\\OpenClaw Gateway Backup",
          detail: "task: \\OpenClaw Gateway Backup",
          scope: "system",
        },
      ]),
    ).toEqual(['schtasks /Delete /TN "\\OpenClaw Gateway Backup" /F']);
  });

  it.each(["$(Start-Process calc)", "%OPENCLAW_GATEWAY_TASK%", "unsafe&task", "task`name"])(
    "does not render a Windows task name expandable by cmd.exe or PowerShell: %s",
    (label) => {
      expect(
        renderGatewayServiceCleanupHints([
          {
            platform: "win32",
            label,
            detail: `task: ${label}`,
            scope: "system",
          },
        ]),
      ).toEqual([]);
    },
  );

  it("does not invent a removal path when service metadata omits it", () => {
    expect(
      renderGatewayServiceCleanupHints([
        {
          platform: "darwin",
          label: "com.example.openclaw-gateway",
          detail: "loaded",
          scope: "user",
        },
      ]),
    ).toEqual(["launchctl bootout gui/$UID/com.example.openclaw-gateway"]);
  });
});

describe("findExtraGatewayServices (linux / scanSystemdDir) — real filesystem", () => {
  // These tests write real .service files to a temp dir and call findExtraGatewayServices
  // with that dir as HOME. No platform mocking or fs mocking needed.
  const isLinux = process.platform === "linux";

  it.skipIf(!isLinux)("does not report openclaw-test.service as a gateway service", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
    await fs.mkdir(systemdDir, { recursive: true });
    await fs.writeFile(path.join(systemdDir, "openclaw-test.service"), TEST_SERVICE_CONTENTS);
    const result = await findExtraGatewayServices({ HOME: tmpHome });
    expect(result).toStrictEqual([]);
  });

  it.skipIf(!isLinux)(
    "does not report the canonical openclaw-gateway.service as an extra service",
    async () => {
      const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
      const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
      await fs.mkdir(systemdDir, { recursive: true });
      await fs.writeFile(
        path.join(systemdDir, "openclaw-gateway.service"),
        GATEWAY_SERVICE_CONTENTS,
      );
      const result = await findExtraGatewayServices({ HOME: tmpHome });
      expect(result).toStrictEqual([]);
    },
  );

  it.skipIf(!isLinux)(
    "reports a legacy clawdbot-gateway service as an extra gateway service",
    async () => {
      const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
      const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
      const unitPath = path.join(systemdDir, "clawdbot-gateway.service");
      await fs.mkdir(systemdDir, { recursive: true });
      await fs.writeFile(unitPath, CLAWDBOT_GATEWAY_CONTENTS);
      const result = await findExtraGatewayServices({ HOME: tmpHome });
      expect(result).toEqual([
        {
          platform: "linux",
          label: "clawdbot-gateway.service",
          detail: `unit: ${unitPath}`,
          scope: "user",
          marker: "clawdbot",
          legacy: true,
        },
      ]);
    },
  );

  it.skipIf(!isLinux)("reports an orphaned legacy systemd backup", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
    const backupPath = path.join(systemdDir, "clawdbot-gateway.service.bak");
    await fs.mkdir(systemdDir, { recursive: true });
    await fs.writeFile(backupPath, CLAWDBOT_GATEWAY_CONTENTS);

    const result = await findExtraGatewayServices({ HOME: tmpHome });

    expect(result).toEqual([
      {
        platform: "linux",
        label: "clawdbot-gateway.service",
        detail: `unit backup: ${backupPath}`,
        scope: "user",
        marker: "clawdbot",
        legacy: true,
      },
    ]);
  });

  it.skipIf(!isLinux)("reports a legacy systemd unit and its backup once", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
    const unitPath = path.join(systemdDir, "clawdbot-gateway.service");
    await fs.mkdir(systemdDir, { recursive: true });
    await fs.writeFile(unitPath, CLAWDBOT_GATEWAY_CONTENTS);
    await fs.writeFile(`${unitPath}.bak`, CLAWDBOT_GATEWAY_CONTENTS);

    const result = await findExtraGatewayServices({ HOME: tmpHome });

    expect(result).toEqual([
      {
        platform: "linux",
        label: "clawdbot-gateway.service",
        detail: `unit: ${unitPath}`,
        scope: "user",
        marker: "clawdbot",
        legacy: true,
      },
    ]);
  });

  it.skipIf(!isLinux)(
    "does not report companion units that only depend on the gateway",
    async () => {
      const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
      const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
      await fs.mkdir(systemdDir, { recursive: true });
      await fs.writeFile(
        path.join(systemdDir, "openclaw-companion.service"),
        COMPANION_SERVICE_CONTENTS,
      );
      const result = await findExtraGatewayServices({ HOME: tmpHome });
      expect(result).toStrictEqual([]);
    },
  );

  it.skipIf(!isLinux).each(["", "# comment \\\n", "; comment \\\n"])(
    "reports custom-named gateway units after a physical comment: %j",
    async (comment) => {
      const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
      const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
      const unitPath = path.join(systemdDir, "custom-openclaw.service");
      await fs.mkdir(systemdDir, { recursive: true });
      await fs.writeFile(
        unitPath,
        CUSTOM_OPENCLAW_GATEWAY_CONTENTS.replace("ExecStart=", `${comment}ExecStart=`),
      );
      const result = await findExtraGatewayServices({ HOME: tmpHome });
      expect(result).toEqual([
        {
          platform: "linux",
          label: "custom-openclaw.service",
          detail: `unit: ${unitPath}`,
          scope: "user",
          marker: "openclaw",
          legacy: false,
        },
      ]);
    },
  );
});

describe("findExtraGatewayServices (darwin / scanLaunchdDir) — real filesystem", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  it("does not report LaunchAgent companions that only mention the gateway label", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const launchdDir = path.join(tmpHome, "Library", "LaunchAgents");
    await fs.mkdir(launchdDir, { recursive: true });
    await fs.writeFile(
      path.join(launchdDir, "com.example.companion.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.example.companion</string>
<key>KeepAlive</key><dict><key>OtherJobEnabled</key><dict><key>ai.openclaw.gateway</key><true/></dict></dict>
<key>ProgramArguments</key><array><string>/usr/local/bin/openclaw-helper</string><string>sync</string></array>
</dict></plist>`,
    );
    const result = await findExtraGatewayServices({ HOME: tmpHome });
    expect(result).toStrictEqual([]);
  });

  it("does not report LaunchAgent companions that only pass gateway-named options", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const launchdDir = path.join(tmpHome, "Library", "LaunchAgents");
    await fs.mkdir(launchdDir, { recursive: true });
    await fs.writeFile(
      path.join(launchdDir, "com.example.companion-options.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.example.companion-options</string>
<key>ProgramArguments</key><array><string>/usr/local/bin/openclaw-helper</string><string>--gateway-url</string><string>http://127.0.0.1:18789</string><string>sync</string></array>
</dict></plist>`,
    );
    const result = await findExtraGatewayServices({ HOME: tmpHome });
    expect(result).toStrictEqual([]);
  });

  it("does not report non-gateway LaunchAgents that mention clawdbot in environment values", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const launchdDir = path.join(tmpHome, "Library", "LaunchAgents");
    await fs.mkdir(launchdDir, { recursive: true });
    await fs.writeFile(
      path.join(launchdDir, "com.github.facebook.watchman.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.github.facebook.watchman</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/Users/test/Projects/clawdbot2/node_modules/.bin:/opt/homebrew/bin</string></dict>
<key>ProgramArguments</key><array><string>/opt/homebrew/bin/watchman</string><string>--foreground</string></array>
</dict></plist>`,
    );
    const result = await findExtraGatewayServices({ HOME: tmpHome });
    expect(result).toStrictEqual([]);
  });

  it("reports custom LaunchAgents that execute openclaw gateway", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const launchdDir = path.join(tmpHome, "Library", "LaunchAgents");
    const plistPath = path.join(launchdDir, "com.example.openclaw-gateway.plist");
    await fs.mkdir(launchdDir, { recursive: true });
    await fs.writeFile(
      plistPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.example.openclaw-gateway</string>
<key>ProgramArguments</key><array><string>/usr/local/bin/openclaw</string><string>gateway</string><string>--port</string><string>18888</string></array>
</dict></plist>`,
    );
    const result = await findExtraGatewayServices({ HOME: tmpHome });
    expect(result).toEqual([
      {
        platform: "darwin",
        label: "com.example.openclaw-gateway",
        detail: `plist: ${plistPath}`,
        scope: "user",
        marker: "openclaw",
        legacy: false,
      },
    ]);
    expect(renderGatewayServiceCleanupHints(result)).toEqual([
      "launchctl bootout gui/$UID/com.example.openclaw-gateway",
      `rm ${plistPath}`,
    ]);
  });
});

describe("findExtraGatewayServices (win32)", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
    execSchtasksMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  it("skips schtasks queries unless deep mode is enabled", async () => {
    const result = await findExtraGatewayServices({});
    expect(result).toStrictEqual([]);
    expect(execSchtasksMock).not.toHaveBeenCalled();
  });

  it("returns empty results when schtasks query fails", async () => {
    execSchtasksMock.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "error",
    });

    const result = await findExtraGatewayServices({}, { deep: true });
    expect(result).toStrictEqual([]);
  });

  it("collects only non-openclaw marker tasks from schtasks output", async () => {
    // Real schtasks /Query /FO LIST /V output prefixes root-folder task
    // names with a backslash (e.g. TaskName:\OpenClaw Gateway).
    execSchtasksMock.mockResolvedValueOnce({
      code: 0,
      stdout: [
        "TaskName:\\OpenClaw Gateway",
        "Task To Run: C:\\Program Files\\OpenClaw\\openclaw.exe gateway run",
        "",
        "TaskName: Clawdbot Legacy",
        "Task To Run: C:\\clawdbot\\clawdbot.exe run",
        "",
        "TaskName: Other Task",
        "Task To Run: C:\\tools\\helper.exe",
        "",
      ].join("\n"),
      stderr: "",
    });

    const result = await findExtraGatewayServices({}, { deep: true });
    // The \OpenClaw Gateway task is the live launcher — it must be skipped.
    // Only the unrelated clawdbot task should be flagged.
    expect(result).toEqual([
      {
        platform: "win32",
        label: "Clawdbot Legacy",
        detail: "task: Clawdbot Legacy, run: C:\\clawdbot\\clawdbot.exe run",
        scope: "system",
        marker: "clawdbot",
        legacy: true,
      },
    ]);
  });

  it("reports duplicate root tasks that only share the gateway task prefix", async () => {
    execSchtasksMock.mockResolvedValueOnce({
      code: 0,
      stdout: [
        "TaskName:\\OpenClaw Gateway",
        "Task To Run: C:\\Program Files\\OpenClaw\\openclaw.exe gateway run",
        "",
        "TaskName:\\OpenClaw Gateway (dev)",
        "Task To Run: C:\\Program Files\\OpenClaw\\openclaw.exe gateway run --profile dev",
        "",
        "TaskName:\\OpenClaw Gateway Backup",
        "Task To Run: C:\\Program Files\\OpenClaw\\openclaw.exe gateway run",
        "",
      ].join("\n"),
      stderr: "",
    });

    const result = await findExtraGatewayServices({}, { deep: true });
    expect(result).toEqual([
      {
        platform: "win32",
        label: "\\OpenClaw Gateway Backup",
        detail:
          "task: \\OpenClaw Gateway Backup, run: C:\\Program Files\\OpenClaw\\openclaw.exe gateway run",
        scope: "system",
        marker: "openclaw",
        legacy: false,
      },
    ]);
  });
});
