import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { UPDATE_RUN_PHASES } from "../../packages/gateway-protocol/src/update-run-vocabulary.js";
import { resolveStateDir } from "../config/paths.js";
import { redactSensitiveText } from "../logging/redact.js";
import { escapeRegExp } from "../shared/regexp.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import type { UpdateRuns } from "../state/openclaw-state-db.generated.js";
import { resolveRequiredHomeDir } from "./home-dir.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import { UpdateRunRecordSchema } from "./update-run-schema.js";

const JSON_BYTES = 16 * 1024;
const RETAINED_STEP_NAMES = [
  ...UPDATE_RUN_PHASES,
  "notice:ack",
  "notice:activating",
  "notice:verifying",
  "previous generation restoration",
  "post-update verification",
  "driver:adopted",
  "driver:identity-unavailable",
  "reconcile:abandoned",
  "reconcile:superseded",
  "reconcile:acknowledged",
];
const JSON_FIELDS = [
  "origin",
  "target",
  "before",
  "after",
  "steps",
  "verification",
  "repair",
] as const;
export type UpdateRunLedgerOptions = OpenClawStateDatabaseOptions & {
  redactPaths?: readonly string[];
};

function mapJsonText(value: unknown, transform: (text: string) => string): unknown {
  if (typeof value === "string") {
    return transform(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => mapJsonText(entry, transform));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, mapJsonText(value[key], transform)]),
    );
  }
  return value;
}

export function isRetainedStep(item: unknown): boolean {
  return (
    isRecord(item) &&
    typeof item.step === "string" &&
    (item.step.startsWith("finalize:") || RETAINED_STEP_NAMES.some((name) => name === item.step))
  );
}

/** Phase history, notice custody, and restoration proof survive diagnostic eviction. */
function boundedJson(input: unknown, maxBytes = JSON_BYTES): string {
  let value = input;
  let json = JSON.stringify(value);
  while (Buffer.byteLength(json) > maxBytes) {
    if (Array.isArray(value)) {
      const disposable = value.findIndex((item) => !isRetainedStep(item));
      if (disposable >= 0) {
        value = value.toSpliced(disposable, 1);
      } else {
        // Reserved identities and timestamps fit; discard optional diagnostics
        // before losing phase history, notice custody, or restoration proof.
        const compacted = value.map((item) =>
          isRecord(item) ? { ...item, detail: undefined } : item,
        );
        if (JSON.stringify(compacted) === json) {
          throw new Error("Update run retained step metadata exceeds its byte limit");
        }
        value = compacted;
      }
    } else if (isRecord(value)) {
      const object = value;
      const key = Object.keys(object)
        .toSorted()
        .find((field) => Array.isArray(object[field]) && object[field].length > 0);
      const array = key ? object[key] : undefined;
      if (key && Array.isArray(array)) {
        value = { ...object, [key]: array.slice(1) };
      } else {
        value = mapJsonText(value, (text) => truncateUtf16Safe(text, Math.floor(text.length / 2)));
      }
    } else {
      throw new Error("Update run metadata exceeds its bounded schema");
    }
    json = JSON.stringify(value);
  }
  return json;
}

function boundedOriginJson(origin: UpdateRunRecord["origin"]): string {
  const { driver, previousDrivers, ...diagnostics } = origin;
  const identities = JSON.stringify({ driver, previousDrivers });
  const boundedDiagnostics = boundedJson(diagnostics, JSON_BYTES - Buffer.byteLength(identities));
  return `{${[identities.slice(1, -1), boundedDiagnostics.slice(1, -1)].filter(Boolean).join(",")}}`;
}

export function encodeRun(input: UpdateRunRecord, options: UpdateRunLedgerOptions): UpdateRuns {
  const env = options.env ?? process.env;
  // Home-relative selectors remain actionable in reports. Other captured roots
  // are diagnostic only; model refs, slash commands, and URLs are not paths.
  const roots: [string | undefined, string][] = [
    [resolveRequiredHomeDir(env), "~"],
    [env.HOME, "~"],
    [env.USERPROFILE, "~"],
    [resolveStateDir(env), "$OPENCLAW_STATE_DIR"],
    [env.OPENCLAW_CONFIG_PATH, "[path]"],
    ...(options.redactPaths ?? []).map((root): [string, string] => [root, "[path]"]),
  ];
  const redactPaths: [RegExp, string][] = roots.flatMap(([root, replacement]) => {
    if (!root) {
      return [];
    }
    const prefix = root
      .replaceAll("\\", "/")
      .replace(/\/+$/u, "")
      .split("/")
      .map(escapeRegExp)
      .join("[\\\\/]");
    const flags = /^(?:[A-Za-z]:|\\\\)/u.test(root) ? "giu" : "gu";
    return prefix
      ? [
          [
            new RegExp(
              `(?<!https?:)(?:(?<![\\w/])|(?<=file:///?))${prefix}(?=$|[\\\\/\\s"'<>.,;:)])`,
              flags,
            ),
            replacement,
          ],
        ]
      : [];
  });
  // Process identities are exact observations, never redacted diagnostic strings.
  const { driver, previousDrivers, ...originDiagnostics } = input.origin;
  const record = UpdateRunRecordSchema.parse(
    mapJsonText({ ...input, origin: originDiagnostics }, (value) => {
      let text = redactSensitiveText(value, { mode: "tools" });
      for (const [pattern, replacement] of redactPaths) {
        text = text.replace(pattern, () => replacement);
      }
      return truncateUtf16Safe(text, 1024);
    }),
  );
  record.origin = UpdateRunRecordSchema.shape.origin.parse({
    ...record.origin,
    driver,
    previousDrivers,
  });
  return {
    run_id: record.runId,
    created_at_ms: record.createdAtMs,
    updated_at_ms: record.updatedAtMs,
    trigger: record.trigger,
    phase: record.phase,
    status: record.status,
    reason: record.reason,
    origin_json: boundedOriginJson(record.origin),
    target_json: boundedJson(record.target),
    before_json: boundedJson(record.before),
    after_json: boundedJson(record.after),
    steps_json: boundedJson(record.steps),
    verification_json: boundedJson(record.verification),
    repair_json: boundedJson(record.repair),
    confirmed_at_ms: record.confirmedAtMs,
    finished_at_ms: record.finishedAtMs,
    downtime_ms: record.downtimeMs,
  };
}

export function decodeRun(row: UpdateRuns): UpdateRunRecord {
  const metadata = Object.fromEntries(
    JSON_FIELDS.map((field) => [field, JSON.parse(row[`${field}_json`])]),
  );
  return UpdateRunRecordSchema.parse({
    ...metadata,
    runId: row.run_id,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    trigger: row.trigger,
    phase: row.phase,
    status: row.status,
    reason: row.reason,
    confirmedAtMs: row.confirmed_at_ms,
    finishedAtMs: row.finished_at_ms,
    downtimeMs: row.downtime_ms,
  });
}
