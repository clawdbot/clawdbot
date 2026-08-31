// @vitest-environment node
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("cron jobs pagination style ownership", () => {
  it("loads shared pagination styles through the component on either route", async () => {
    const [componentSource, sharedStyles, cronStyles, agentsSource, cronSource] = await Promise.all(
      [
        readFile(new URL("./cron-jobs-pagination.ts", import.meta.url), "utf8"),
        readFile(new URL("../styles/cron-jobs-pagination.css", import.meta.url), "utf8"),
        readFile(new URL("../styles/cron.css", import.meta.url), "utf8"),
        readFile(new URL("../pages/agents/panels-status-files.ts", import.meta.url), "utf8"),
        readFile(new URL("../pages/cron/view.ts", import.meta.url), "utf8"),
      ],
    );

    expect(componentSource).toContain('import "../styles/cron-jobs-pagination.css"');
    expect(agentsSource).toContain('from "../../components/cron-jobs-pagination.ts"');
    expect(cronSource).toContain('from "../../components/cron-jobs-pagination.ts"');

    for (const selector of [".cron-table__footer", ".cron-load-more"]) {
      expect(sharedStyles).toContain(`${selector} {`);
      expect(cronStyles).not.toContain(`${selector} {`);
    }
  });
});
