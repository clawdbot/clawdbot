import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "../config/zod-schema.js";

const CLOUD_WORKER_DOCS = [
  "docs/gateway/cloud-workers.md",
  "docs/gateway/config-cloud-workers.md",
] as const;
const CLOUD_WORKER_PAGE = "gateway/cloud-workers";

type NavigationNode = {
  group?: string;
  groups?: NavigationNode[];
  pages?: Array<NavigationNode | string>;
  tab?: string;
};

function cloudWorkerConfigExamples(filePath: string): unknown[] {
  const markdown = fs.readFileSync(path.join(process.cwd(), filePath), "utf8");
  return Array.from(markdown.matchAll(/```(?:json5|json)\n([\s\S]*?)```/gu))
    .map((match) => match[1] ?? "")
    .filter((source) => /["']?cloudWorkers["']?\s*:/u.test(source))
    .map((source) => JSON5.parse(source));
}

function countPage(value: unknown, page: string): number {
  if (value === page) {
    return 1;
  }
  if (Array.isArray(value)) {
    return value.reduce((count, entry) => count + countPage(entry, page), 0);
  }
  if (value && typeof value === "object") {
    return Object.values(value).reduce((count, entry) => count + countPage(entry, page), 0);
  }
  return 0;
}

describe("Cloud Workers documentation contract", () => {
  it.each(CLOUD_WORKER_DOCS)("keeps %s config examples schema-valid", (filePath) => {
    const examples = cloudWorkerConfigExamples(filePath);
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      expect(OpenClawSchema.safeParse(example).success).toBe(true);
    }
  });

  it("lists Cloud Workers exactly once in English navigation", () => {
    const docs = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "docs", "docs.json"), "utf8"),
    ) as {
      navigation?: { languages?: Array<{ language?: string; tabs?: NavigationNode[] }> };
    };
    const english = docs.navigation?.languages?.find((entry) => entry.language === "en");
    const gatewayOps = english?.tabs?.find((entry) => entry.tab === "Gateway & Ops");
    const gateway = gatewayOps?.groups?.find((entry) => entry.group === "Gateway");
    const scaling = gateway?.pages?.find(
      (entry): entry is NavigationNode =>
        typeof entry === "object" && entry.group === "Scaling and operations",
    );

    expect(english).toBeDefined();
    expect(countPage(english?.tabs, CLOUD_WORKER_PAGE)).toBe(1);
    expect(countPage(scaling?.pages, CLOUD_WORKER_PAGE)).toBe(1);
  });
});
