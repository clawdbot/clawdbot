import fs from "node:fs";
import { z } from "zod";

export const TELEGRAM_DESKTOP_VERSION = "7.0.9";
export const TELEGRAM_DESKTOP_AWS_IMAGE = "telegram-desktop=7.0.9";
export const TELEGRAM_DESKTOP_DOCKER_IMAGE = "openclaw-telegram-desktop:7.0.9";
export const RECORDER_AUTHORIZATION_FAILURE_FILENAME =
  "telegram-desktop-authorization-failure.json";

export const recorderAuthorizationFailureSchema = z.object({
  acceptedTokenCount: z.number().int().nonnegative(),
  classification: z.enum(["main-window-timeout", "qr-unreadable", "token-accepted-no-transition"]),
  failedAt: z.string(),
  loginScreenshotPath: z.string().optional(),
  qrAttemptCount: z.number().int().positive(),
});

export const recorderAuthorizationFailureFactSchema = z.object({
  failures: z.array(recorderAuthorizationFailureSchema).min(1),
  schemaVersion: z.literal(1),
});

export type RecorderAuthorizationFailure = z.infer<typeof recorderAuthorizationFailureSchema>;

const recorderSessionBaseSchema = z.object({
  artifacts: z.record(z.string(), z.string()).optional(),
  chat: z.string().regex(/^-100\d+$/u),
  cleanupErrors: z.array(z.string()).optional(),
  desktopSessionId: z.string().min(1),
  leaseId: z.string().min(1),
  /** False when `--lease-id` borrowed an existing box: the recorder never stops it. */
  leaseOwned: z.boolean(),
  outputDir: z.string().min(1),
  recordFps: z.number().int().positive(),
  remotePaths: z.object({
    desktopLog: z.string(),
    ffmpegLog: z.string(),
    ffmpegPid: z.string(),
    finalScreenshot: z.string(),
    video: z.string(),
  }),
  schemaVersion: z.literal(2),
  startedAt: z.string(),
  /** Telegram Desktop window as placed on the recorded desktop; the crop uses it. */
  window: z.object({
    height: z.number().int().positive(),
    id: z.string().regex(/^0x[0-9a-f]+$/iu),
    width: z.number().int().positive(),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
  }),
  stoppedAt: z.string().optional(),
  userDriver: z.array(z.string()).min(1),
});

const recorderSessionSchema = z.discriminatedUnion("provider", [
  recorderSessionBaseSchema.extend({
    imageSource: z.literal(TELEGRAM_DESKTOP_AWS_IMAGE),
    provider: z.literal("aws"),
  }),
  recorderSessionBaseSchema.extend({
    imageSource: z.literal(TELEGRAM_DESKTOP_DOCKER_IMAGE),
    provider: z.literal("docker"),
  }),
]);

export type RecorderSession = z.infer<typeof recorderSessionSchema>;
export type RecorderProvider = RecorderSession["provider"];

export type StartOptions = {
  command: "start";
  chat: string;
  crabboxClass: string;
  idleTimeout: string;
  json: boolean;
  leaseId?: string;
  messageId?: string;
  outputDir: string;
  provider: RecorderProvider;
  recordFps: number;
  sessionPath: string;
  ttl: string;
  userDriver: string[];
};

export type ViewOptions = {
  command: "view";
  messageId: string;
  sessionPath: string;
};

export type ActionsOptions = {
  actionsFile: string;
  command: "actions";
  sessionPath: string;
  timeoutSeconds: number;
};

export type ScreenshotOptions = {
  command: "screenshot";
  output?: string;
  sessionPath: string;
};

export type StopOptions = {
  command: "stop";
  crop?: "telegram-window";
  sessionPath: string;
};

export type TeardownOptions = {
  command: "teardown";
  sessionPath: string;
};

export type StatusOptions = {
  command: "status";
  sessionPath: string;
};

export type RecoverOptions = {
  command: "recover";
  sessionPath: string;
};

export type ArtifactsOptions = {
  command: "artifacts";
  sessionPath: string;
};

type RecorderOptions =
  | ArtifactsOptions
  | ActionsOptions
  | RecoverOptions
  | ScreenshotOptions
  | StartOptions
  | StatusOptions
  | StopOptions
  | TeardownOptions
  | ViewOptions;

export function recorderUsageText(): string {
  return [
    "Usage:",
    "  pnpm qa:telegram-desktop-recorder artifacts --session <recorder.json>",
    '  pnpm qa:telegram-desktop-recorder start --session <recorder.json> --output-dir <dir> --chat <-100groupId> --user-driver "<space-separated cmd prefix>" [options]',
    "  pnpm qa:telegram-desktop-recorder view --session <recorder.json> --message-id <id>",
    "  pnpm qa:telegram-desktop-recorder actions --session <recorder.json> --actions-file <json> [--timeout-seconds <seconds>]",
    "  pnpm qa:telegram-desktop-recorder screenshot --session <recorder.json> [--output <png>]",
    "  pnpm qa:telegram-desktop-recorder recover --session <recorder.json>",
    "  pnpm qa:telegram-desktop-recorder stop --session <recorder.json> [--crop telegram-window]",
    "  pnpm qa:telegram-desktop-recorder teardown --session <recorder.json>",
    "  pnpm qa:telegram-desktop-recorder status --session <recorder.json>",
    "",
    "Start options:",
    "  --provider aws|docker     Crabbox provider. Default: docker.",
    "  --lease-id <cbx…>        Reuse an existing desktop lease.",
    "  --class <name>            Crabbox class. Default: standard.",
    "  --ttl <duration>          Lease TTL. Default: 2h.",
    "  --idle-timeout <duration> Idle timeout. Default: 1h.",
    "  --record-fps <fps>        Recording frame rate. Default: 24.",
    "  --message-id <id>         Open this private-group post before recording.",
    "  --json                    Print recorder.json after start.",
  ].join("\n");
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function positiveInteger(value: string, flag: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function requiredString(values: Map<string, string>, flag: string): string {
  const value = values.get(flag)?.trim();
  if (!value) {
    throw new Error(`${flag} is required.`);
  }
  return value;
}

export function parseRecorderArgs(argv: string[]): RecorderOptions {
  const rawCommand = argv[0];
  if (!rawCommand || rawCommand === "--help" || rawCommand === "-h") {
    throw new Error(recorderUsageText());
  }
  const parsedCommand = z
    .enum([
      "actions",
      "artifacts",
      "recover",
      "screenshot",
      "start",
      "status",
      "stop",
      "teardown",
      "view",
    ])
    .safeParse(rawCommand);
  if (!parsedCommand.success) {
    throw new Error(`Unknown command: ${rawCommand}\n\n${recorderUsageText()}`);
  }
  const command = parsedCommand.data;
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag) {
      break;
    }
    if (flag === "--json") {
      switches.add(flag);
      continue;
    }
    if (!flag.startsWith("--")) {
      throw new Error(`Unexpected argument: ${flag}`);
    }
    if (values.has(flag)) {
      throw new Error(`${flag} was provided more than once.`);
    }
    values.set(flag, requiredValue(argv, index, flag));
    index += 1;
  }
  const allowed =
    command === "start"
      ? new Set([
          "--chat",
          "--class",
          "--idle-timeout",
          "--lease-id",
          "--message-id",
          "--output-dir",
          "--provider",
          "--record-fps",
          "--session",
          "--ttl",
          "--user-driver",
        ])
      : command === "view"
        ? new Set(["--message-id", "--session"])
        : command === "actions"
          ? new Set(["--actions-file", "--session", "--timeout-seconds"])
          : command === "screenshot"
            ? new Set(["--output", "--session"])
            : command === "stop"
              ? new Set(["--crop", "--session"])
              : new Set(["--session"]);
  for (const flag of values.keys()) {
    if (!allowed.has(flag)) {
      throw new Error(`${flag} is not available for ${command}.`);
    }
  }
  if (switches.has("--json") && command !== "start") {
    throw new Error(`--json is not available for ${command}.`);
  }
  if (command === "start") {
    const chat = requiredString(values, "--chat");
    if (!/^-100\d+$/u.test(chat)) {
      throw new Error("--chat must be a Telegram private-group id beginning with -100.");
    }
    // Whitespace-separated command prefix (e.g. `uv run /path/user-driver.py`); the
    // recorder appends `confirm-qr …` / `terminate-session …`. No quoting: driver
    // paths are our own tooling and never contain spaces.
    const userDriver = requiredString(values, "--user-driver").split(/\s+/u);
    const parsedProvider = z
      .enum(["aws", "docker"])
      .safeParse(values.get("--provider") ?? "docker");
    if (!parsedProvider.success) {
      throw new Error("--provider must be aws or docker.");
    }
    const provider = parsedProvider.data;
    const leaseId = values.get("--lease-id");
    if (leaseId && !/^cbx_[A-Za-z0-9_-]+$/u.test(leaseId)) {
      throw new Error("--lease-id must be a cbx lease id.");
    }
    const messageId = values.get("--message-id");
    if (messageId) {
      positiveInteger(messageId, "--message-id");
    }
    return {
      command,
      chat,
      crabboxClass: values.get("--class") ?? "standard",
      idleTimeout: values.get("--idle-timeout") ?? "1h",
      json: switches.has("--json"),
      leaseId,
      messageId,
      outputDir: requiredString(values, "--output-dir"),
      provider,
      recordFps: positiveInteger(values.get("--record-fps") ?? "24", "--record-fps"),
      sessionPath: requiredString(values, "--session"),
      ttl: values.get("--ttl") ?? "2h",
      userDriver,
    };
  }
  const sessionPath = requiredString(values, "--session");
  if (command === "view") {
    const messageId = requiredString(values, "--message-id");
    positiveInteger(messageId, "--message-id");
    return { command, messageId, sessionPath };
  }
  if (command === "actions") {
    return {
      actionsFile: requiredString(values, "--actions-file"),
      command,
      sessionPath,
      timeoutSeconds: positiveInteger(values.get("--timeout-seconds") ?? "60", "--timeout-seconds"),
    };
  }
  if (command === "screenshot") {
    return { command, output: values.get("--output"), sessionPath };
  }
  if (command === "stop") {
    const crop = values.get("--crop");
    if (crop === undefined) {
      return { command, sessionPath };
    }
    if (crop !== "telegram-window") {
      throw new Error("--crop must be telegram-window.");
    }
    return { command, crop, sessionPath };
  }
  return { command, sessionPath };
}

export function readRecorderSession(sessionPath: string): RecorderSession {
  return recorderSessionSchema.parse(JSON.parse(fs.readFileSync(sessionPath, "utf8")));
}

export function writeRecorderSession(sessionPath: string, session: RecorderSession): void {
  const parsed = recorderSessionSchema.parse(session);
  fs.writeFileSync(sessionPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
}
