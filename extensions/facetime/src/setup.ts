import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { asRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { FaceTimeConfig } from "./config.js";
import { inspectFaceTimeDriver, type FaceTimeDriverStatus } from "./driver-setup.js";
import type { FaceTimePreflightCheck, FaceTimePreflightResult } from "./preflight.js";
import type { FaceTimeRuntimeStatus } from "./runtime.js";

type RunCommandWithTimeout = PluginRuntime["system"]["runCommandWithTimeout"];

type FaceTimeSetupCheckStatus =
  | "ready"
  | "repairing"
  | "action-required"
  | "verify-on-call"
  | "recommended";

type FaceTimeSetupAction = {
  id: string;
  kind: "automatic" | "command" | "gateway" | "recovery" | "system-settings" | "manual-test";
  label: string;
  command?: string;
  gatewayMethod?: string;
  settingsPath?: string;
};

type FaceTimeSetupCheck = {
  id: string;
  label: string;
  status: FaceTimeSetupCheckStatus;
  required: boolean;
  message: string;
  actionId?: string;
};

export type FaceTimeSetupReport = {
  ok: boolean;
  readyForTest: boolean;
  liveCallProofRequired: boolean;
  checks: FaceTimeSetupCheck[];
  actions: FaceTimeSetupAction[];
};

type SetupParams = {
  config: FaceTimeConfig;
  pluginRoot: string;
  runCommandWithTimeout: RunCommandWithTimeout;
  runtimeStatus?: FaceTimeRuntimeStatus | Promise<FaceTimeRuntimeStatus>;
  runtimeError?: string;
  preflight?: FaceTimePreflightResult | Promise<FaceTimePreflightResult>;
  readAssertionsFile?: () => Promise<string>;
};

const XCODE_APP = "/Applications/Xcode.app";
const XCODE_CLANG = `${XCODE_APP}/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang`;
const XCODE_MACOS_SDK = `${XCODE_APP}/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk`;

const PRECHECK_ACTIONS: Record<
  string,
  Pick<FaceTimeSetupAction, "id" | "kind" | "label" | "command" | "gatewayMethod" | "settingsPath">
> = {
  "capture-binary": {
    id: "repair-plugin-artifacts",
    kind: "command",
    label: "Rebuild the FaceTime plugin artifacts",
    command: "openclaw gateway restart",
  },
  "paired-driver-mic": {
    id: "install-driver",
    kind: "gateway",
    label: "Install or update the paired FaceTime audio driver",
    gatewayMethod: "facetime.installDriver",
  },
  "paired-driver-feed": {
    id: "install-driver",
    kind: "gateway",
    label: "Install or update the paired FaceTime audio driver",
    gatewayMethod: "facetime.installDriver",
  },
  "physical-output": {
    id: "select-physical-output",
    kind: "system-settings",
    label: "Select MacBook Speakers or another physical output",
    settingsPath: "System Settings > Sound > Output",
  },
  "process-tap": {
    id: "grant-system-audio",
    kind: "system-settings",
    label: "Allow OpenClaw to capture FaceTime app audio",
    settingsPath: "System Settings > Privacy & Security > Screen & System Audio Recording",
  },
  "realtime-provider": {
    id: "configure-realtime-provider",
    kind: "command",
    label: "Configure authentication for a registered realtime voice provider",
    command: "openclaw configure",
  },
};

function firstLine(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().split(/\r?\n/u)[0] || undefined : undefined;
}

function addAction(actions: FaceTimeSetupAction[], action: FaceTimeSetupAction): void {
  if (!actions.some((candidate) => candidate.id === action.id)) {
    actions.push(action);
  }
}

function addPreflightCheck(
  checks: FaceTimeSetupCheck[],
  actions: FaceTimeSetupAction[],
  check: FaceTimePreflightCheck,
): void {
  if (check.id === "call-app-running") {
    return;
  }
  const action = PRECHECK_ACTIONS[check.id];
  if (!check.ok && action) {
    addAction(actions, action);
  }
  checks.push({
    id: check.id,
    label: check.label,
    status: check.ok ? "ready" : check.required ? "action-required" : "recommended",
    required: check.required,
    message: check.message ?? (check.ok ? "ready" : "not ready"),
    ...(!check.ok && action ? { actionId: action.id } : {}),
  });
}

function hasActiveFocusAssertion(raw: string): boolean {
  const parsed: unknown = JSON.parse(raw);
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) {
      return value.some(visit);
    }
    if (!value || typeof value !== "object") {
      return false;
    }
    const record = asRecord(value);
    if (Array.isArray(record.storeAssertionRecords) && record.storeAssertionRecords.length > 0) {
      return true;
    }
    return Object.values(record).some(visit);
  };
  return visit(parsed);
}

async function checkFocusMode(params: SetupParams): Promise<FaceTimeSetupCheck> {
  const readAssertions =
    params.readAssertionsFile ??
    (() => readFile(resolve(homedir(), "Library/DoNotDisturb/DB/Assertions.json"), "utf8"));
  try {
    const active = hasActiveFocusAssertion(await readAssertions());
    return {
      id: "focus-mode",
      label: "Focus mode",
      status: active ? "verify-on-call" : "ready",
      required: !active,
      message: active
        ? "An active Focus is allowed only when it permits the expected caller"
        : "No active Focus assertion",
      ...(active ? { actionId: "verify-focus" } : {}),
    };
  } catch (error) {
    return {
      id: "focus-mode",
      label: "Focus mode",
      status: "verify-on-call",
      required: false,
      message: `Could not verify Focus state: ${formatErrorMessage(error)}`,
      actionId: "verify-focus",
    };
  }
}

async function checkNotificationsDuringSharing(
  runCommandWithTimeout: RunCommandWithTimeout,
): Promise<FaceTimeSetupCheck> {
  // macOS stores this System Settings choice as a nested plist data value.
  // On macOS 26.4, the UI's selected "Allow Notifications" value serializes
  // as dndMirrored=true despite the legacy key name. This mapping was verified
  // against the UI and the successful headless incoming-call route.
  const script =
    "/usr/bin/defaults export com.apple.ncprefs - 2>/dev/null | " +
    "/usr/bin/plutil -extract dnd_prefs raw -o - - | " +
    "/usr/bin/base64 --decode | " +
    "/usr/bin/plutil -extract dndMirrored raw -o - -";
  try {
    const result = await runCommandWithTimeout(["/bin/bash", "-c", script], {
      timeoutMs: 5_000,
    });
    const value = firstLine(result.stdout)?.toLowerCase();
    if (result.code === 0 && value === "true") {
      return {
        id: "notifications-while-sharing",
        label: "Notifications while sharing the display",
        status: "ready",
        required: true,
        message: "Notifications are allowed while mirroring or sharing the display",
      };
    }
    return {
      id: "notifications-while-sharing",
      label: "Notifications while sharing the display",
      status: "action-required",
      required: true,
      message:
        value === "false"
          ? "Incoming call notifications are suppressed while mirroring or sharing the display"
          : "Could not verify the notification setting used during display sharing",
      actionId: "allow-sharing-notifications",
    };
  } catch (error) {
    return {
      id: "notifications-while-sharing",
      label: "Notifications while sharing the display",
      status: "action-required",
      required: true,
      message: `Could not verify notification behavior: ${formatErrorMessage(error)}`,
      actionId: "allow-sharing-notifications",
    };
  }
}

async function checkCommand(
  runCommandWithTimeout: RunCommandWithTimeout,
  argv: string[],
  readyMessage: (stdout: string) => string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const result = await runCommandWithTimeout(argv, { timeoutMs: 5_000 });
    return result.code === 0
      ? { ok: true, message: readyMessage(result.stdout ?? "") }
      : {
          ok: false,
          message:
            firstLine(result.stderr) ??
            firstLine(result.stdout) ??
            `${argv[0]} exited ${result.code}`,
        };
  } catch (error) {
    return { ok: false, message: formatErrorMessage(error) };
  }
}

async function inspectDriver(params: SetupParams): Promise<{
  status?: FaceTimeDriverStatus;
  error?: string;
}> {
  try {
    return {
      status: await inspectFaceTimeDriver({
        pluginRoot: params.pluginRoot,
        runCommandWithTimeout: params.runCommandWithTimeout,
      }),
    };
  } catch (error) {
    return { error: formatErrorMessage(error) };
  }
}

export async function runFaceTimeSetup(params: SetupParams): Promise<FaceTimeSetupReport> {
  const checks: FaceTimeSetupCheck[] = [];
  const actions: FaceTimeSetupAction[] = [];

  const [xcodeCompiler, xcodeSdk] = await Promise.all([
    checkCommand(params.runCommandWithTimeout, ["/bin/test", "-x", XCODE_CLANG], () => XCODE_CLANG),
    checkCommand(params.runCommandWithTimeout, ["/bin/test", "-d", XCODE_MACOS_SDK], () => {
      return XCODE_MACOS_SDK;
    }),
  ]);
  const xcodeReady = xcodeCompiler.ok && xcodeSdk.ok;
  checks.push({
    id: "xcode-tools",
    label: "Full Xcode installation",
    status: xcodeReady ? "ready" : "action-required",
    required: true,
    message: xcodeReady
      ? `Full Xcode compiler and macOS SDK are available at ${XCODE_APP}`
      : `Full Xcode is required at ${XCODE_APP}; Command Line Tools alone cannot perform protected-app injection or build the local audio driver`,
    ...(!xcodeReady ? { actionId: "install-xcode-tools" } : {}),
  });
  if (!xcodeReady) {
    // Keep the established action id stable for setup-report consumers while
    // directing operators to the full Xcode app required by the native setup boundary.
    addAction(actions, {
      id: "install-xcode-tools",
      kind: "command",
      label: "Install full Xcode in /Applications",
      command: "open 'https://apps.apple.com/us/app/xcode/id497799835'",
    });
  }

  const developerSecurity = await checkCommand(
    params.runCommandWithTimeout,
    ["/usr/sbin/DevToolsSecurity", "-status"],
    (stdout) => firstLine(stdout) ?? "Developer tools access enabled",
  );
  const developerSecurityEnabled =
    developerSecurity.ok && /enabled/iu.test(developerSecurity.message);
  checks.push({
    id: "developer-tools-access",
    label: "Developer tools access",
    status: developerSecurityEnabled ? "ready" : "action-required",
    required: true,
    message: developerSecurityEnabled
      ? developerSecurity.message
      : "Developer tools access is disabled; helper injection cannot attach to FaceTime or Phone",
    ...(!developerSecurityEnabled ? { actionId: "enable-developer-tools" } : {}),
  });
  if (!developerSecurityEnabled) {
    addAction(actions, {
      id: "enable-developer-tools",
      kind: "command",
      label: "Enable developer tools access",
      command: "sudo /usr/sbin/DevToolsSecurity -enable",
    });
  }

  const sip = await checkCommand(
    params.runCommandWithTimeout,
    ["/usr/bin/csrutil", "status"],
    (stdout) => stdout.trim(),
  );
  const debuggingRestrictionsDisabled =
    sip.ok &&
    (/System Integrity Protection status:\s*disabled/iu.test(sip.message) ||
      /Debugging Restrictions:\s*disabled/iu.test(sip.message));
  checks.push({
    id: "system-integrity-protection",
    label: "System Integrity Protection debugging restrictions",
    status: debuggingRestrictionsDisabled ? "ready" : "action-required",
    required: true,
    message: debuggingRestrictionsDisabled
      ? "Debugging restrictions are disabled, so LLDB can attach to FaceTime and Phone"
      : "SIP debugging restrictions block LLDB helper injection into protected Apple apps",
    ...(!debuggingRestrictionsDisabled ? { actionId: "disable-sip-debugging" } : {}),
  });
  if (!debuggingRestrictionsDisabled) {
    addAction(actions, {
      id: "disable-sip-debugging",
      kind: "recovery",
      label: "Disable SIP debugging restrictions from macOS Recovery, then reboot and rerun setup",
      command: "csrutil enable --without debug",
      settingsPath: "macOS Recovery > Utilities > Terminal",
    });
  }

  checks.push({
    id: "owner-handles",
    label: "Owner FaceTime handles",
    status: params.config.ownerHandles.length > 0 ? "ready" : "action-required",
    required: true,
    message:
      params.config.ownerHandles.length > 0
        ? `${params.config.ownerHandles.length} owner handle${params.config.ownerHandles.length === 1 ? "" : "s"} configured`
        : "Configure at least one owner email address or phone number",
    ...(params.config.ownerHandles.length === 0 ? { actionId: "configure-owner-handles" } : {}),
  });
  if (params.config.ownerHandles.length === 0) {
    addAction(actions, {
      id: "configure-owner-handles",
      kind: "command",
      label: "Configure ownerHandles",
      command: "openclaw configure",
    });
  }

  // The runtime can finish asynchronous helper injection while the static
  // checks above run. Resolve its status only when composing the live checks
  // so the final report does not preserve a stale "repairing" snapshot.
  const runtimeStatus = params.runtimeStatus ? await params.runtimeStatus : undefined;
  checks.push({
    id: "runtime",
    label: "FaceTime plugin runtime",
    status: runtimeStatus ? "ready" : "action-required",
    required: true,
    message: runtimeStatus
      ? "Runtime activated on the local UID-derived helper endpoint"
      : (params.runtimeError ?? "FaceTime runtime is not running"),
    ...(!runtimeStatus ? { actionId: "restart-gateway" } : {}),
  });
  if (!runtimeStatus) {
    addAction(actions, {
      id: "restart-gateway",
      kind: "command",
      label: "Stop the stale gateway process, then restart OpenClaw",
      command: "openclaw gateway restart",
    });
  }

  if (runtimeStatus) {
    for (const target of runtimeStatus.helperTargets) {
      const status: FaceTimeSetupCheckStatus = target.connected
        ? "ready"
        : target.stale
          ? "action-required"
          : target.injecting || target.queued || target.retryScheduled
            ? "repairing"
            : "action-required";
      checks.push({
        id: `helper-${target.target.toLowerCase()}`,
        label: `${target.target} helper`,
        status,
        required: target.target === "FaceTime" || target.target === "Phone",
        message: target.connected
          ? "Authenticated helper connected"
          : target.stale
            ? `Restart ${target.target} so it can load the current helper`
            : status === "repairing" && target.lastError
              ? `Automatic retry scheduled after: ${target.lastError}`
              : target.lastError
                ? target.lastError
                : "OpenClaw is launching the app and injecting the helper",
        ...(status === "repairing"
          ? { actionId: "wait-for-helper" }
          : status === "action-required"
            ? { actionId: "restart-call-apps" }
            : {}),
      });
      if (status === "repairing") {
        addAction(actions, {
          id: "wait-for-helper",
          kind: "automatic",
          label: "Wait for automatic helper injection to finish",
        });
      } else if (status === "action-required") {
        addAction(actions, {
          id: "restart-call-apps",
          kind: "manual-test",
          label: "Quit and reopen FaceTime and Phone, then let OpenClaw reinject the helper",
        });
      }
    }
  }

  const driver = await inspectDriver(params);
  const driverReady = driver.status === "current";
  checks.push({
    id: "audio-driver",
    label: "Paired FaceTime audio driver",
    status: driverReady ? "ready" : "action-required",
    required: true,
    message: driverReady
      ? "OpenClaw-Mic and OpenClaw-Feed driver is current"
      : driver.error
        ? `Could not inspect driver: ${driver.error}`
        : `Driver status: ${driver.status ?? "unknown"}`,
    ...(!driverReady ? { actionId: "install-driver" } : {}),
  });
  if (!driverReady) {
    addAction(actions, {
      id: "install-driver",
      kind: "gateway",
      label: "Install or update the paired FaceTime audio driver",
      gatewayMethod: "facetime.installDriver",
    });
  }

  if (params.preflight) {
    const preflight = await params.preflight;
    for (const check of preflight.checks) {
      if (check.id === "helper-connected" && runtimeStatus?.helperTargets.length) {
        continue;
      }
      addPreflightCheck(checks, actions, check);
    }
  }

  const focus = await checkFocusMode(params);
  checks.push(focus);
  if (focus.status === "verify-on-call") {
    addAction(actions, {
      id: "verify-focus",
      kind: "system-settings",
      label: "Verify Focus is off or allows the expected caller",
      settingsPath: "Control Center > Focus",
    });
  }

  const sharingNotifications = await checkNotificationsDuringSharing(params.runCommandWithTimeout);
  checks.push(sharingNotifications);
  if (sharingNotifications.status === "action-required") {
    addAction(actions, {
      id: "allow-sharing-notifications",
      kind: "system-settings",
      label: "Allow notifications while mirroring or sharing the display",
      settingsPath: "System Settings > Notifications",
    });
  }

  checks.push({
    id: "facetime-sign-in",
    label: "FaceTime account",
    status: "verify-on-call",
    required: false,
    message:
      "macOS does not expose a supported sign-in readiness API; verify with one outbound call",
    actionId: "live-outbound-test",
  });
  addAction(actions, {
    id: "live-outbound-test",
    kind: "manual-test",
    label: "Place one outbound FaceTime audio call with facetime.dial",
    gatewayMethod: "facetime.dial",
  });

  const internalMediaStage = runtimeStatus?.calls.find(
    (call) =>
      call.audioReady &&
      call.realtimeActive &&
      call.audioTransport?.processInputVerified === true &&
      call.audioTransport.processOutputSuppressed,
  );
  checks.push({
    id: "internal-media-stage",
    label: "Internal call media stage",
    status: internalMediaStage ? "ready" : "verify-on-call",
    required: false,
    message: internalMediaStage
      ? "Process capture, model session, native playback, and local suppression reached their internal ready states; remote audibility is not proven"
      : "Internal media stages require an active call; remote audibility still needs a separate live check",
    ...(!internalMediaStage ? { actionId: "live-audio-test" } : {}),
  });
  if (!internalMediaStage) {
    addAction(actions, {
      id: "live-audio-test",
      kind: "manual-test",
      label: "Run one inbound and one outbound FaceTime audio call",
    });
  }

  checks.push({
    id: "live-voicemail",
    label: "Live Voicemail call screening",
    status: "recommended",
    required: false,
    message:
      "If incoming FaceTime Audio rings are intercepted, turn off Live Voicemail on this unattended Mac",
    actionId: "review-live-voicemail",
  });
  addAction(actions, {
    id: "review-live-voicemail",
    kind: "system-settings",
    label: "Review Live Voicemail if inbound audio calls are screened",
    settingsPath: "Phone > Settings > Live Voicemail",
  });

  const requiredReady = checks.every(
    (check) => !check.required || check.status === "ready" || check.status === "repairing",
  );
  const repairsPending = checks.some((check) => check.required && check.status === "repairing");
  return {
    ok: requiredReady && !repairsPending,
    readyForTest: requiredReady && !repairsPending,
    liveCallProofRequired: true,
    checks,
    actions,
  };
}
