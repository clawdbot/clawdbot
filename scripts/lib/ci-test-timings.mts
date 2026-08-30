// Committed CI measurements are advisory weights, never a test inventory.
import { readFileSync } from "node:fs";
import { ciTestTimingsSchema, type CiTestTimings } from "./ci-test-timings-schema.mts";

const emptyUiTimings = { fileSeconds: {}, perFileOverheadSeconds: 0 };
const emptyGroupTimings: Readonly<Record<string, number>> = {};
let cachedTimings: CiTestTimings | null | undefined;

function readTestTimings(): CiTestTimings | null {
  if (process.env.OPENCLAW_CI_TEST_TIMINGS === "0") {
    return null;
  }
  if (cachedTimings === undefined) {
    try {
      // Every independent UI shard must read the same checkout bytes, not a
      // restored cache or downloaded artifact that may differ between jobs.
      cachedTimings = ciTestTimingsSchema.parse(
        JSON.parse(
          readFileSync(new URL("../../config/ci-test-timings.json", import.meta.url), "utf8"),
        ),
      );
    } catch {
      cachedTimings = null;
    }
  }
  return cachedTimings;
}

export function readUiE2eFileTimings(): {
  readonly fileSeconds: Readonly<Record<string, number>>;
  readonly perFileOverheadSeconds: number;
} {
  return readTestTimings()?.uiE2e ?? emptyUiTimings;
}

export function readCompactGroupTimings(
  profile: "blacksmith" | "github",
): Readonly<Record<string, number>> {
  return readTestTimings()?.compactGroupSeconds[profile] ?? emptyGroupTimings;
}
