import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalSparkleBuildFromVersion } from "../scripts/sparkle-build.ts";

const APPCAST_URL = new URL("../appcast.xml", import.meta.url);

type AppcastItem = {
  raw: string;
  shortVersion: string | null;
  sparkleVersion: number | null;
};

function parseItems(appcast: string): AppcastItem[] {
  return [...appcast.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((match) => {
    const raw = match[1] ?? "";
    const shortVersion =
      raw.match(/<sparkle:shortVersionString>([^<]+)<\/sparkle:shortVersionString>/)?.[1] ?? null;
    const sparkleVersionText = raw.match(/<sparkle:version>([^<]+)<\/sparkle:version>/)?.[1] ?? "";
    const sparkleVersion = Number.parseInt(sparkleVersionText, 10);
    return {
      raw,
      shortVersion,
      sparkleVersion: Number.isFinite(sparkleVersion) ? sparkleVersion : null,
    };
  });
}

describe("appcast.xml", () => {
  it("keeps every appcast entry on the canonical sparkle build for its version", () => {
    const appcast = readFileSync(APPCAST_URL, "utf8");
    const items = parseItems(appcast);
    expect(items.length).toBeGreaterThan(0);

    for (const item of items) {
      if (item.shortVersion === null || item.sparkleVersion === null) {
        throw new Error(`Appcast entry missing version fields: ${item.raw}`);
      }
      expect(item.sparkleVersion).toBe(canonicalSparkleBuildFromVersion(item.shortVersion));
    }
  });

  it("keeps the first stable appcast entry aligned with the newest stable build", () => {
    const appcast = readFileSync(APPCAST_URL, "utf8");
    const stableItems = parseItems(appcast).filter(
      (item) => item.sparkleVersion !== null && item.sparkleVersion % 100 === 90,
    );

    expect(stableItems.length).toBeGreaterThan(0);
    const firstStable = stableItems[0];
    const newestStable = [...stableItems].toSorted(
      (left, right) => (right.sparkleVersion ?? 0) - (left.sparkleVersion ?? 0),
    )[0];

    expect(firstStable.sparkleVersion).toBe(newestStable.sparkleVersion);
    expect(firstStable.shortVersion).toBe(newestStable.shortVersion);
  });
});
