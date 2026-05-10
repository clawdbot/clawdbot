import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import { execDockerRaw } from "./docker.js";

describe("execDockerRaw", () => {
  it("wraps docker ENOENT with an actionable configuration error", async () => {
    await withEnvAsync({ PATH: "" }, async () => {
      let err: unknown;
      try {
        await execDockerRaw(["version"]);
      } catch (caught) {
        err = caught;
      }

      expect(err).toBeInstanceOf(Error);
      const error = err as Error & { code?: string };
      expect(error.code).toBe("INVALID_CONFIG");
      expect(error.message).toContain("Sandbox mode requires Docker");
      expect(error.message).toContain("agents.defaults.sandbox.mode=off");
    });
  });
});
