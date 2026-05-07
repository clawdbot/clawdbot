import { describe, expect, it } from "vitest";
import uiConfig from "../ui/vitest.config.ts";
import uiNodeConfig from "../ui/vitest.node.config.ts";

describe("ui package vitest config", () => {
  it("keeps the standalone ui package on thread workers without isolation", () => {
    expect(uiConfig.test?.pool).toBe("threads");
    expect(uiConfig.test?.isolate).toBe(false);
    expect(uiConfig.test?.projects).toHaveLength(3);

    for (const project of uiConfig.test?.projects ?? []) {
      expect(project.test?.pool).toBe("threads");
      expect(project.test?.isolate).toBe(false);
      expect(project.test?.runner).toBeUndefined();
    }
  });

  it("keeps the standalone ui node config on thread workers without isolation", () => {
    expect(uiNodeConfig.test?.pool).toBe("threads");
    expect(uiNodeConfig.test?.isolate).toBe(false);
    expect(uiNodeConfig.test?.runner).toBeUndefined();
  });
});
