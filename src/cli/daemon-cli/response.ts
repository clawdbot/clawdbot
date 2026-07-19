// JSON/text response helpers for Gateway service lifecycle commands.
import { Writable } from "node:stream";
import type { GatewayService } from "../../daemon/service.js";
import {
  isSystemdUnavailableDetail,
  renderSystemdUnavailableHints,
} from "../../daemon/systemd-hints.js";
import { classifySystemdUnavailableDetail } from "../../daemon/systemd-unavailable.js";
import { isWSL } from "../../infra/wsl.js";
import { defaultRuntime } from "../../runtime.js";

/** Gateway service action emitted by lifecycle commands. */
type DaemonAction = "install" | "uninstall" | "start" | "stop" | "restart";

/** Stable hint category for machine-readable daemon command output. */
type DaemonHintKind =
  | "install"
  | "container-restart"
  | "container-foreground"
  | "systemd-unavailable"
  | "systemd-headless"
  | "wsl-systemd"
  | "generic";

/** Classified daemon recovery hint item. */
type DaemonHintItem = {
  kind: DaemonHintKind;
  text: string;
};

/** Machine-readable response shape for service lifecycle commands. */
type DaemonActionResponse = {
  ok: boolean;
  action: DaemonAction;
  result?: string;
  message?: string;
  error?: string;
  hints?: string[];
  hintItems?: DaemonHintItem[];
  warnings?: string[];
  service?: {
    label: string;
    loaded: boolean;
    loadedText: string;
    notLoadedText: string;
  };
};

function emitDaemonActionJson(payload: DaemonActionResponse) {
  defaultRuntime.writeJson(payload);
}

function classifyDaemonHintText(text: string): DaemonHintKind {
  if (text.includes("openclaw gateway install") || text.startsWith("Service not installed. Run:")) {
    return "install";
  }
  if (text.startsWith("Restart the container or the service that manages it for ")) {
    return "container-restart";
  }
  if (text.startsWith("systemd user services are unavailable;")) {
    return "systemd-unavailable";
  }
  if (
    text.startsWith("On a headless server (SSH/no desktop session):") ||
    text.startsWith("Also ensure XDG_RUNTIME_DIR is set:")
  ) {
    return "systemd-headless";
  }
  if (text.startsWith("If you're in a container, run the gateway in the foreground instead of")) {
    return "container-foreground";
  }
  if (
    text.startsWith("WSL2 needs systemd enabled:") ||
    text.startsWith("Then run: wsl --shutdown") ||
    text.startsWith("Verify: systemctl --user status")
  ) {
    return "wsl-systemd";
  }
  return "generic";
}

/** Classify plain-text hints for JSON daemon responses. */
function buildDaemonHintItems(hints: string[] | undefined): DaemonHintItem[] | undefined {
  if (!hints?.length) {
    return undefined;
  }
  return hints.map((text) => ({ kind: classifyDaemonHintText(text), text }));
}

/** Build the service metadata snapshot embedded in JSON action responses. */
export function buildDaemonServiceSnapshot(service: GatewayService, loaded: boolean) {
  return {
    label: service.label,
    loaded,
    loadedText: service.loadedText,
    notLoadedText: service.notLoadedText,
  };
}

type DaemonEmit = (payload: Omit<DaemonActionResponse, "action">) => void;

/** Emit a lifecycle result and mirror its message to text output. */
function emitDaemonActionMessage(params: {
  json: boolean;
  emit: DaemonEmit;
  payload: Omit<DaemonActionResponse, "action">;
}): void {
  params.emit(params.payload);
  if (!params.json && params.payload.message) {
    defaultRuntime.log(params.payload.message);
  }
}

/** Emit the no-op success returned when a service is already running. */
export function emitDaemonAlreadyRunning(params: {
  serviceNoun: string;
  service: GatewayService;
  pid?: number;
  json: boolean;
  warnings: string[];
  emit: DaemonEmit;
}): void {
  const message =
    params.pid === undefined
      ? `${params.serviceNoun} service already running.`
      : `${params.serviceNoun} service already running (pid ${params.pid}).`;
  emitDaemonActionMessage({
    json: params.json,
    emit: params.emit,
    payload: {
      ok: true,
      result: "already-running",
      message,
      service: buildDaemonServiceSnapshot(params.service, true),
      warnings: params.warnings.length ? params.warnings : undefined,
    },
  });
}

/** Emit a service-manager restart that has been accepted but not completed. */
export function emitDaemonScheduledRestart(params: {
  json: boolean;
  emit: DaemonEmit;
  result: string;
  message: string;
  service: GatewayService;
  loaded: boolean;
  warnings: string[];
}): true {
  emitDaemonActionMessage({
    json: params.json,
    emit: params.emit,
    payload: {
      ok: true,
      result: params.result,
      message: params.message,
      service: buildDaemonServiceSnapshot(params.service, params.loaded),
      warnings: params.warnings.length ? params.warnings : undefined,
    },
  });
  return true;
}

/** Writable sink used when JSON output should suppress service command stdout. */
export function createNullWriter(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

/** Create stdout/warning/emit/fail helpers for one daemon lifecycle action. */
export function createDaemonActionContext(params: { action: DaemonAction; json: boolean }): {
  stdout: Writable;
  warnings: string[];
  emit: (payload: Omit<DaemonActionResponse, "action">) => void;
  fail: (message: string, hints?: string[]) => void;
} {
  const warnings: string[] = [];
  const stdout = params.json ? createNullWriter() : process.stdout;
  const emit = (payload: Omit<DaemonActionResponse, "action">) => {
    if (!params.json) {
      return;
    }
    emitDaemonActionJson({
      action: params.action,
      ...payload,
      hintItems: payload.hintItems ?? buildDaemonHintItems(payload.hints),
      warnings: payload.warnings ?? (warnings.length ? warnings : undefined),
    });
  };
  const fail = (message: string, hints?: string[]) => {
    if (params.json) {
      emit({
        ok: false,
        error: message,
        hints,
      });
    } else {
      defaultRuntime.error(message);
      if (hints?.length) {
        for (const hint of hints) {
          defaultRuntime.log(`Tip: ${hint}`);
        }
      }
    }
    defaultRuntime.exit(1);
  };

  return { stdout, warnings, emit, fail };
}

async function buildInstallFailureHints(error: unknown): Promise<string[] | undefined> {
  const detail = String(error);
  if (process.platform !== "linux" || !isSystemdUnavailableDetail(detail)) {
    return undefined;
  }
  return renderSystemdUnavailableHints({
    wsl: await isWSL(),
    kind: classifySystemdUnavailableDetail(detail),
  });
}

/** Install a service, convert platform install failures to hints, and emit the final response. */
export async function installDaemonServiceAndEmit(params: {
  serviceNoun: string;
  service: GatewayService;
  warnings: string[];
  emit: (payload: Omit<DaemonActionResponse, "action">) => void;
  fail: (message: string, hints?: string[]) => void;
  install: () => Promise<void>;
}) {
  try {
    await params.install();
  } catch (err) {
    params.fail(
      `${params.serviceNoun} install failed: ${String(err)}`,
      await buildInstallFailureHints(err),
    );
    return;
  }

  let installed;
  try {
    installed = await params.service.isLoaded({ env: process.env });
  } catch {
    installed = true;
  }
  params.emit({
    ok: true,
    result: "installed",
    service: buildDaemonServiceSnapshot(params.service, installed),
    warnings: params.warnings.length ? params.warnings : undefined,
  });
}
