import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MACOS_APP_SOURCES_DIR } from "../compat/legacy-names.js";
import { CronDeliverySchema, CronJobStateSchema } from "../gateway/protocol/schema.js";

type SchemaLike = {
  anyOf?: Array<SchemaLike>;
  properties?: Record<string, unknown>;
  const?: unknown;
};

function extractDeliveryModes(schema: SchemaLike): string[] {
  const modeSchema = schema.properties?.mode as SchemaLike | undefined;
  const directModes = (modeSchema?.anyOf ?? [])
    .map((entry) => entry?.const)
    .filter((value): value is string => typeof value === "string");
  if (directModes.length > 0) {
    return directModes;
  }

  const unionModes = (schema.anyOf ?? [])
    .map((entry) => {
      const mode = entry.properties?.mode as SchemaLike | undefined;
      return mode?.const;
    })
    .filter((value): value is string => typeof value === "string");

  return Array.from(new Set(unionModes));
}

function extractConstUnionValues(schema: SchemaLike): string[] {
  return Array.from(
    new Set(
      (schema.anyOf ?? [])
        .map((entry) => entry?.const)
        .filter((value): value is string => typeof value === "string"),
    ),
  );
}

const UI_FILES = ["ui/src/ui/types.ts", "ui/src/ui/ui-types.ts", "ui/src/ui/views/cron.ts"];

const SWIFT_MODEL_CANDIDATES = [`${MACOS_APP_SOURCES_DIR}/CronModels.swift`];
const SWIFT_STATUS_CANDIDATES = [`${MACOS_APP_SOURCES_DIR}/GatewayConnection.swift`];

async function resolveSwiftFiles(cwd: string, candidates: string[]): Promise<string[]> {
  const matches: string[] = [];
  for (const relPath of candidates) {
    try {
      await fs.access(path.join(cwd, relPath));
      matches.push(relPath);
    } catch {
      // ignore missing path
    }
  }
  if (matches.length === 0) {
    throw new Error(`Missing Swift cron definition. Tried: ${candidates.join(", ")}`);
  }
  return matches;
}

describe("cron protocol conformance", () => {
  it("ui + swift include all cron delivery modes from gateway schema", async () => {
    const modes = extractDeliveryModes(CronDeliverySchema as SchemaLike);
    expect(modes.length).toBeGreaterThan(0);

    const cwd = process.cwd();
    for (const relPath of UI_FILES) {
      const content = await fs.readFile(path.join(cwd, relPath), "utf-8");
      for (const mode of modes) {
        expect(content, `${relPath} missing delivery mode ${mode}`).toContain(`"${mode}"`);
      }
    }

    const swiftModelFiles = await resolveSwiftFiles(cwd, SWIFT_MODEL_CANDIDATES);
    for (const relPath of swiftModelFiles) {
      const content = await fs.readFile(path.join(cwd, relPath), "utf-8");
      for (const mode of modes) {
        const pattern = new RegExp(`\\bcase\\s+${mode}\\b`);
        expect(content, `${relPath} missing case ${mode}`).toMatch(pattern);
      }
    }
  });

  it("cron status shape matches gateway fields in UI + Swift", async () => {
    const cwd = process.cwd();
    const uiTypes = await fs.readFile(path.join(cwd, "ui/src/ui/types.ts"), "utf-8");
    expect(uiTypes).toContain("export type CronStatus");
    expect(uiTypes).toContain("jobs:");
    expect(uiTypes).not.toContain("jobCount");

    const [swiftRelPath] = await resolveSwiftFiles(cwd, SWIFT_STATUS_CANDIDATES);
    const swiftPath = path.join(cwd, swiftRelPath);
    const swift = await fs.readFile(swiftPath, "utf-8");
    expect(swift).toContain("struct CronSchedulerStatus");
    expect(swift).toContain("let jobs:");
  });

  it("cron job state schema keeps the full failover reason set", () => {
    const properties = (CronJobStateSchema as SchemaLike).properties ?? {};
    const lastErrorReason = properties.lastErrorReason as SchemaLike | undefined;
    if (lastErrorReason === undefined) {
      throw new Error("missing lastErrorReason schema");
    }
    expect(extractConstUnionValues(lastErrorReason)).toEqual([
      "auth",
      "format",
      "rate_limit",
      "billing",
      "timeout",
      "model_not_found",
      "empty_response",
      "no_error_details",
      "unclassified",
      "unknown",
    ]);
  });
});
