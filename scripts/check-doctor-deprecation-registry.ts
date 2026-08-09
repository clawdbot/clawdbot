import { pathToFileURL } from "node:url";
import {
  listDoctorDeprecationCompatRecords,
  type DoctorDeprecationCompatRecord,
} from "../src/commands/doctor/shared/deprecation-compat.js";

type DeadlineRecord = Pick<DoctorDeprecationCompatRecord, "code" | "status" | "removeAfter">;
type ExpiredDeadlineRecord = DeadlineRecord & { removeAfter: string };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export function findExpiredDeprecatedDoctorRecords(
  records: readonly DeadlineRecord[],
  asOf: string,
): ExpiredDeadlineRecord[] {
  return records
    .filter(
      (record): record is ExpiredDeadlineRecord =>
        record.status === "deprecated" &&
        record.removeAfter !== undefined &&
        record.removeAfter <= asOf,
    )
    .toSorted(
      (left, right) =>
        left.removeAfter.localeCompare(right.removeAfter) || left.code.localeCompare(right.code),
    );
}

function isUtcDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) {
    return false;
  }
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function parseAsOf(argv: readonly string[]): string | undefined {
  if (argv.length === 0) {
    return undefined;
  }
  if (argv.length === 2 && argv[0] === "--as-of" && isUtcDate(argv[1] ?? "")) {
    return argv[1];
  }
  throw new Error(
    "Usage: node --import tsx scripts/check-doctor-deprecation-registry.ts [--as-of YYYY-MM-DD]",
  );
}

function main(argv = process.argv.slice(2)): void {
  let requestedAsOf: string | undefined;
  try {
    requestedAsOf = parseAsOf(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  const asOf = requestedAsOf ?? new Date().toISOString().slice(0, 10);
  const expired = findExpiredDeprecatedDoctorRecords(listDoctorDeprecationCompatRecords(), asOf);
  if (expired.length === 0) {
    console.log(`[doctor-deprecation-registry] OK as of ${asOf}`);
    return;
  }

  console.error(
    `[doctor-deprecation-registry] ${expired.length} deprecated record(s) reached removeAfter by ${asOf}:`,
  );
  for (const record of expired) {
    console.error(`- ${record.code}: removeAfter ${record.removeAfter}`);
  }
  console.error(
    "Remove each migration after supported-upgrade proof, or move it to removal-pending with a documented blocker.",
  );
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
