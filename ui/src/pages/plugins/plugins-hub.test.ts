import { beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { pluginsHubTabs } from "./plugins-hub.ts";

describe("pluginsHubTabs", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  it("exposes Claws only when the connected Gateway advertises it", () => {
    expect(pluginsHubTabs().map((tab) => tab.value)).not.toContain("claws");
    expect(pluginsHubTabs(null, true).map((tab) => tab.value)).toContain("claws");
  });
});
