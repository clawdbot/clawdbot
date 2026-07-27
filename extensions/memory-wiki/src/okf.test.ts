// Memory Wiki tests cover Open Knowledge Format import behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseWikiMarkdown } from "./markdown.js";
import { importMemoryWikiOkfBundle } from "./okf.js";
import { searchMemoryWiki } from "./query.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createTempDir, createVault } = createMemoryWikiTestHarness();

function getOnlyPagePath(paths: string[]): string {
  expect(paths).toHaveLength(1);
  const [pagePath] = paths;
  if (!pagePath) {
    throw new Error("Expected OKF import to produce one page path.");
  }
  return pagePath;
}

async function writeOkfBundle(rootDir: string) {
  const bundlePath = path.join(rootDir, "sales-okf");
  await fs.mkdir(path.join(bundlePath, "tables"), { recursive: true });
  await fs.mkdir(path.join(bundlePath, "metrics"), { recursive: true });
  await fs.writeFile(
    path.join(bundlePath, "index.md"),
    `---
id: sales-okf
okf_version: "0.1"
---

# Sales Bundle
`,
    "utf8",
  );
  await fs.writeFile(path.join(bundlePath, "log.md"), "# Directory Update Log\n", "utf8");
  await fs.writeFile(
    path.join(bundlePath, "tables", "customers.md"),
    `---
type: BigQuery Table
title: Customers
description: Customer table.
resource: https://console.cloud.google.com/bigquery?p=acme&d=sales&t=customers
tags: [sales, customers]
timestamp: 2026-05-28T00:00:00Z
producer_field:
  owner: data
---

# Schema

Customer rows.
`,
    "utf8",
  );
  await fs.writeFile(
    path.join(bundlePath, "tables", "orders.md"),
    `---
type: BigQuery Table
title: Orders
description: One row per completed order.
tags:
  - sales
  - orders
---

# Schema

Joined with [Customers](/tables/customers.md) and the [weekly metric](../metrics/weekly-active-users.md).
Titled link to [weekly metric](../metrics/weekly-active-users.md "metric docs").

Inline code keeps \`[customers](/tables/customers.md)\` unchanged.

\`\`\`markdown
[customers](/tables/customers.md)
\`\`\`

External citation stays as [BigQuery](https://cloud.google.com/bigquery).
`,
    "utf8",
  );
  await fs.writeFile(
    path.join(bundlePath, "metrics", "weekly-active-users.md"),
    `---
type: Metric
title: Weekly Active Users
---

Computed from [orders](../tables/orders.md).
`,
    "utf8",
  );
  await fs.writeFile(
    path.join(bundlePath, "tables", "draft.md"),
    `---
title: Draft
---

Missing type.
`,
    "utf8",
  );
  return bundlePath;
}

describe("importMemoryWikiOkfBundle", () => {
  it("imports OKF concept documents as searchable wiki concept pages", async () => {
    const rootDir = await createTempDir("memory-wiki-okf-");
    const bundlePath = await writeOkfBundle(rootDir);
    const { config } = await createVault({
      rootDir: path.join(rootDir, "vault"),
    });

    const result = await importMemoryWikiOkfBundle({
      config,
      bundlePath,
      nowMs: Date.UTC(2026, 5, 12, 10, 0, 0),
    });

    expect(result.okfVersion).toBe("0.1");
    expect(result.importedCount).toBe(3);
    expect(result.skippedCount).toBe(1);
    expect(result.warnings[0]).toMatchObject({
      code: "missing-type",
      path: "tables/draft.md",
    });
    expect(result.pagePaths).toHaveLength(3);
    const repeat = await importMemoryWikiOkfBundle({
      config,
      bundlePath,
      nowMs: Date.UTC(2026, 5, 12, 10, 5, 0),
    });
    expect(repeat.importedCount).toBe(3);
    expect(repeat.updatedCount).toBe(0);

    const ordersPath = result.pagePaths.find((pagePath) => pagePath.includes("orders"));
    expect(ordersPath).toBeTruthy();
    const ordersRaw = await fs.readFile(path.join(config.vault.path, ordersPath!), "utf8");
    const orders = parseWikiMarkdown(ordersRaw);
    expect(orders.frontmatter).toMatchObject({
      pageType: "concept",
      title: "Orders",
      sourceType: "okf",
      provenanceMode: "okf-import",
      okfConceptId: "tables/orders",
      okfType: "BigQuery Table",
    });
    expect(orders.frontmatter.sourceIds).toEqual([
      expect.stringMatching(/^source\.okf\.sales-okf$/),
    ]);
    expect(orders.body).toMatch(/\]\(okf-sales-okf-tables-customers-/);
    expect(orders.body).toMatch(/\]\(okf-sales-okf-metrics-weekly-active-users-/);
    expect(orders.body).toContain('"metric docs"');
    expect(orders.body).toContain("`[customers](/tables/customers.md)`");
    expect(orders.body).toContain("```markdown\n[customers](/tables/customers.md)\n```");
    expect(orders.body).toContain("https://cloud.google.com/bigquery");

    const okf = orders.frontmatter.okf as Record<string, unknown>;
    expect(okf).toMatchObject({
      version: "0.1",
      bundleName: "sales-okf",
      conceptId: "tables/orders",
      sourceRelativePath: "tables/orders.md",
    });
    expect(orders.frontmatter.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetPath: expect.stringMatching(/^concepts\/okf-sales-okf-tables-customers-/),
          kind: "okf-link",
        }),
        expect.objectContaining({
          targetPath: expect.stringMatching(
            /^concepts\/okf-sales-okf-metrics-weekly-active-users-/,
          ),
          kind: "okf-link",
        }),
      ]),
    );

    const customersPath = result.pagePaths.find((pagePath) => pagePath.includes("customers"));
    const customersRaw = await fs.readFile(path.join(config.vault.path, customersPath!), "utf8");
    const customers = parseWikiMarkdown(customersRaw);
    const customersOkf = customers.frontmatter.okf as Record<string, unknown>;
    expect(customersOkf.frontmatter).toMatchObject({
      producer_field: { owner: "data" },
    });

    const searchResults = await searchMemoryWiki({
      config,
      query: "completed order",
      searchCorpus: "wiki",
    });
    expect(searchResults.map((searchResult) => searchResult.path)).toContain(ordersPath);
  });

  it("caps generated concept filenames for long OKF concept paths", async () => {
    const rootDir = await createTempDir("memory-wiki-okf-long-");
    const bundlePath = path.join(rootDir, "long-okf");
    const deepSegments = Array.from({ length: 40 }, (_, index) => `segment-${index}`);
    const deepDir = path.join(bundlePath, ...deepSegments);
    await fs.mkdir(deepDir, { recursive: true });
    await fs.writeFile(
      path.join(deepDir, "orders.md"),
      `---
type: BigQuery Table
title: Long Orders
---

Long concept body.
`,
      "utf8",
    );
    const { config } = await createVault({
      rootDir: path.join(rootDir, "vault"),
    });

    const result = await importMemoryWikiOkfBundle({
      config,
      bundlePath,
      nowMs: Date.UTC(2026, 5, 12, 10, 0, 0),
    });

    expect(result.importedCount).toBe(1);
    const [pagePath] = result.pagePaths;
    expect(pagePath).toBeDefined();
    if (!pagePath) {
      throw new Error("Expected OKF import to produce a page path.");
    }
    const fileName = path.basename(pagePath);
    expect(Buffer.byteLength(fileName)).toBeLessThanOrEqual(255);
    await expect(fs.readFile(path.join(config.vault.path, pagePath), "utf8")).resolves.toContain(
      "Long concept body.",
    );
  });

  it("namespaces concept pages by bundle so repeated OKF paths do not overwrite", async () => {
    const rootDir = await createTempDir("memory-wiki-okf-bundles-");
    const firstBundle = path.join(rootDir, "first-bundle");
    const secondBundle = path.join(rootDir, "second-bundle");
    for (const [bundlePath, title] of [
      [firstBundle, "First Customers"],
      [secondBundle, "Second Customers"],
    ] as const) {
      await fs.mkdir(path.join(bundlePath, "tables"), { recursive: true });
      await fs.writeFile(
        path.join(bundlePath, "tables", "customers.md"),
        `---
type: BigQuery Table
title: ${title}
---

${title} body.
`,
        "utf8",
      );
    }
    const { config } = await createVault({
      rootDir: path.join(rootDir, "vault"),
    });

    const first = await importMemoryWikiOkfBundle({
      config,
      bundlePath: firstBundle,
      nowMs: Date.UTC(2026, 5, 12, 10, 0, 0),
    });
    const second = await importMemoryWikiOkfBundle({
      config,
      bundlePath: secondBundle,
      nowMs: Date.UTC(2026, 5, 12, 10, 0, 0),
    });

    const firstPath = getOnlyPagePath(first.pagePaths);
    const secondPath = getOnlyPagePath(second.pagePaths);
    expect(firstPath).not.toBe(secondPath);
    await expect(fs.readFile(path.join(config.vault.path, firstPath), "utf8")).resolves.toContain(
      "First Customers body.",
    );
    await expect(fs.readFile(path.join(config.vault.path, secondPath), "utf8")).resolves.toContain(
      "Second Customers body.",
    );
  });

  it("removes stale concept pages when an OKF bundle drops a concept", async () => {
    const rootDir = await createTempDir("memory-wiki-okf-remove-");
    const bundlePath = path.join(rootDir, "removing-okf");
    await fs.mkdir(path.join(bundlePath, "tables"), { recursive: true });
    const customersPath = path.join(bundlePath, "tables", "customers.md");
    const ordersPath = path.join(bundlePath, "tables", "orders.md");
    await fs.writeFile(
      customersPath,
      `---
type: BigQuery Table
title: Customers
---

Customer body.
`,
      "utf8",
    );
    await fs.writeFile(
      ordersPath,
      `---
type: BigQuery Table
title: Orders
---

Order body.
`,
      "utf8",
    );
    const { config } = await createVault({
      rootDir: path.join(rootDir, "vault"),
    });
    const first = await importMemoryWikiOkfBundle({
      config,
      bundlePath,
      nowMs: Date.UTC(2026, 5, 12, 10, 0, 0),
    });
    const stalePagePath = first.pagePaths.find((pagePath) => pagePath.includes("orders"));
    expect(stalePagePath).toBeDefined();
    if (!stalePagePath) {
      throw new Error("Expected initial OKF import to include orders.");
    }

    await fs.rm(ordersPath);
    const second = await importMemoryWikiOkfBundle({
      config,
      bundlePath,
      nowMs: Date.UTC(2026, 5, 12, 10, 0, 0),
    });

    expect(second.importedCount).toBe(1);
    expect(second.removedCount).toBe(1);
    expect(second.removedPagePaths).toEqual([stalePagePath]);
    await expect(fs.stat(path.join(config.vault.path, stalePagePath))).rejects.toThrow();
    const results = await searchMemoryWiki({
      config,
      query: "Order body",
      searchCorpus: "wiki",
    });
    expect(results).toHaveLength(0);
  });

  it("does not prune existing pages when current OKF scan has invalid concepts", async () => {
    const rootDir = await createTempDir("memory-wiki-okf-invalid-");
    const bundlePath = path.join(rootDir, "invalid-okf");
    await fs.mkdir(path.join(bundlePath, "tables"), { recursive: true });
    const customersPath = path.join(bundlePath, "tables", "customers.md");
    await fs.writeFile(
      customersPath,
      `---
type: BigQuery Table
title: Customers
---

Customer body.
`,
      "utf8",
    );
    const { config } = await createVault({
      rootDir: path.join(rootDir, "vault"),
    });
    const first = await importMemoryWikiOkfBundle({
      config,
      bundlePath,
      nowMs: Date.UTC(2026, 5, 12, 10, 0, 0),
    });
    const pagePath = getOnlyPagePath(first.pagePaths);
    await fs.writeFile(
      customersPath,
      `---
title: Customers
---

Temporarily invalid body.
`,
      "utf8",
    );

    const second = await importMemoryWikiOkfBundle({
      config,
      bundlePath,
      nowMs: Date.UTC(2026, 5, 12, 10, 0, 0),
    });

    expect(second.importedCount).toBe(0);
    expect(second.skippedCount).toBe(1);
    expect(second.removedCount).toBe(0);
    await expect(fs.readFile(path.join(config.vault.path, pagePath), "utf8")).resolves.toContain(
      "Customer body.",
    );
  });

  it("detects body-only changes on timestamp-shaped markdown lines", async () => {
    const rootDir = await createTempDir("memory-wiki-okf-body-timestamp-");
    const bundlePath = path.join(rootDir, "body-timestamp-okf");
    await fs.mkdir(path.join(bundlePath, "tables"), { recursive: true });
    const conceptPath = path.join(bundlePath, "tables", "events.md");
    await fs.writeFile(
      conceptPath,
      `---
type: BigQuery Table
title: Events
---

updatedAt: 2026-06-12
`,
      "utf8",
    );
    const { config } = await createVault({
      rootDir: path.join(rootDir, "vault"),
    });
    const first = await importMemoryWikiOkfBundle({
      config,
      bundlePath,
      nowMs: Date.UTC(2026, 5, 12, 10, 0, 0),
    });
    const pagePath = getOnlyPagePath(first.pagePaths);
    await fs.writeFile(
      conceptPath,
      `---
type: BigQuery Table
title: Events
---

updatedAt: 2026-06-13
`,
      "utf8",
    );

    const second = await importMemoryWikiOkfBundle({
      config,
      bundlePath,
      nowMs: Date.UTC(2026, 5, 13, 10, 0, 0),
    });

    expect(second.updatedCount).toBe(1);
    await expect(fs.readFile(path.join(config.vault.path, pagePath), "utf8")).resolves.toContain(
      "updatedAt: 2026-06-13",
    );
  });

  it("rewrites percent-encoded OKF markdown links and preserves suffixes", async () => {
    const rootDir = await createTempDir("memory-wiki-okf-encoded-link-");
    const bundlePath = path.join(rootDir, "encoded-okf");
    await fs.mkdir(bundlePath, { recursive: true });
    await fs.writeFile(
      path.join(bundlePath, "BigQuery Table.md"),
      `---
type: BigQuery Table
title: BigQuery Table
---

Table body.
`,
      "utf8",
    );
    await fs.writeFile(
      path.join(bundlePath, "links.md"),
      `---
type: Concept
title: Links
---

See [table](BigQuery%20Table.md?view=compact#columns).
`,
      "utf8",
    );
    const { config } = await createVault({
      rootDir: path.join(rootDir, "vault"),
    });

    const result = await importMemoryWikiOkfBundle({
      config,
      bundlePath,
      nowMs: Date.UTC(2026, 5, 12, 10, 0, 0),
    });

    const linksPath = result.pagePaths.find((pagePath) => pagePath.includes("links"));
    expect(linksPath).toBeDefined();
    if (!linksPath) {
      throw new Error("Expected links page to be imported.");
    }
    await expect(fs.readFile(path.join(config.vault.path, linksPath), "utf8")).resolves.toMatch(
      /\[table\]\(okf-encoded-okf-[0-9a-f]{8}-bigquery-table-[^)]+\.md\?view=compact#columns\)/,
    );
  });

  it("imports OKF concept frontmatter with CRLF line endings", async () => {
    const rootDir = await createTempDir("memory-wiki-okf-crlf-");
    const bundlePath = path.join(rootDir, "crlf-okf");
    await fs.mkdir(path.join(bundlePath, "tables"), { recursive: true });
    await fs.writeFile(
      path.join(bundlePath, "tables", "events.md"),
      [
        "---",
        "type: BigQuery Table",
        "title: Events",
        "---",
        "",
        "Windows-flavored frontmatter.",
        "",
      ].join("\r\n"),
      "utf8",
    );
    const { config } = await createVault({
      rootDir: path.join(rootDir, "vault"),
    });

    const result = await importMemoryWikiOkfBundle({
      config,
      bundlePath,
      nowMs: Date.UTC(2026, 5, 12, 10, 0, 0),
    });

    expect(result.importedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    await expect(
      fs.readFile(path.join(config.vault.path, getOnlyPagePath(result.pagePaths)), "utf8"),
    ).resolves.toContain("Windows-flavored frontmatter.");
  });

  it("refuses to write imported OKF concept pages through symlinks", async () => {
    const rootDir = await createTempDir("memory-wiki-okf-symlink-");
    const bundlePath = path.join(rootDir, "safe-okf");
    await fs.mkdir(path.join(bundlePath, "tables"), { recursive: true });
    const conceptPath = path.join(bundlePath, "tables", "customers.md");
    await fs.writeFile(
      conceptPath,
      `---
type: BigQuery Table
title: Customers
---

Original body.
`,
      "utf8",
    );
    const { config } = await createVault({
      rootDir: path.join(rootDir, "vault"),
    });
    const first = await importMemoryWikiOkfBundle({
      config,
      bundlePath,
      nowMs: Date.UTC(2026, 5, 12, 10, 0, 0),
    });
    const pagePath = getOnlyPagePath(first.pagePaths);
    const pageAbsolutePath = path.join(config.vault.path, pagePath);
    const externalTarget = path.join(rootDir, "outside.md");
    await fs.writeFile(externalTarget, "external target\n", "utf8");
    await fs.rm(pageAbsolutePath);
    await fs.symlink(externalTarget, pageAbsolutePath);
    await fs.writeFile(
      conceptPath,
      `---
type: BigQuery Table
title: Customers
---

Updated body.
`,
      "utf8",
    );

    await expect(
      importMemoryWikiOkfBundle({
        config,
        bundlePath,
        nowMs: Date.UTC(2026, 5, 12, 11, 0, 0),
      }),
    ).rejects.toThrow("through symlink");
    await expect(fs.readFile(externalTarget, "utf8")).resolves.toBe("external target\n");
  });

  it("refuses to import OKF concept files through hardlinks", async () => {
    const rootDir = await createTempDir("memory-wiki-okf-hardlink-");
    const bundlePath = path.join(rootDir, "hardlink-okf");
    await fs.mkdir(path.join(bundlePath, "tables"), { recursive: true });
    const externalSource = path.join(rootDir, "outside.md");
    await fs.writeFile(
      externalSource,
      `---
type: BigQuery Table
title: Private
---

private body
`,
      "utf8",
    );
    await fs.link(externalSource, path.join(bundlePath, "tables", "private.md"));
    const { config } = await createVault({
      rootDir: path.join(rootDir, "vault"),
    });

    const result = await importMemoryWikiOkfBundle({
      config,
      bundlePath,
      nowMs: Date.UTC(2026, 5, 12, 10, 0, 0),
    });

    expect(result.importedCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(result.warnings[0]).toMatchObject({
      code: "unreadable-entry",
      path: "tables/private.md",
    });
  });
});
