import {
  listDoctorDeprecationCompatRecords,
  type DoctorDeprecationCompatRecord,
} from "../src/commands/doctor/shared/deprecation-compat.js";
import { hasValidIsoCalendarComponents } from "../src/shared/iso-time.js";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

type DeadlineRecord = Pick<DoctorDeprecationCompatRecord, "code" | "status" | "removeAfter">;
type ExpiredDeadlineRecord = DeadlineRecord & { removeAfter: string };
type OutputWriter = { write(chunk: string): unknown };
type RegistryCheckIo = { stdout: OutputWriter; stderr: OutputWriter };

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
  return DATE_PATTERN.test(value) && hasValidIsoCalendarComponents(value);
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

function writeLine(writer: OutputWriter, message: string): void {
  writer.write(`${message}\n`);
}

export function main(argv = process.argv.slice(2), io: RegistryCheckIo = process): 0 | 1 | 2 {
  let requestedAsOf: string | undefined;
  try {
    requestedAsOf = parseAsOf(argv);
  } catch (error) {
    writeLine(io.stderr, error instanceof Error ? error.message : String(error));
    return 2;
  }

  const asOf = requestedAsOf ?? new Date().toISOString().slice(0, 10);
  const expired = findExpiredDeprecatedDoctorRecords(listDoctorDeprecationCompatRecords(), asOf);
  if (expired.length === 0) {
    writeLine(io.stdout, `[doctor-deprecation-registry] OK as of ${asOf}`);
    return 0;
  }

  writeLine(
    io.stderr,
    `[doctor-deprecation-registry] ${expired.length} deprecated record(s) reached removeAfter by ${asOf}:`,
  );
  for (const record of expired) {
    writeLine(io.stderr, `- ${record.code}: removeAfter ${record.removeAfter}`);
  }
  writeLine(
    io.stderr,
    "Remove each migration after supported-upgrade proof, or move it to removal-pending with a documented blocker.",
  );
  return 1;
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}
