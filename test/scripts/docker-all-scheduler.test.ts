import { describe, expect, it } from "vitest";
import {
  canStartSchedulerLane,
  describeDockerSchedulerLimits,
} from "../../scripts/test-docker-all.mjs";

const limits = {
  resourceLimits: {
    docker: 2,
    npm: 2,
  },
  weightLimit: 2,
};

function activePool({
  count = 0,
  resources = {},
  weight = 0,
}: {
  count?: number;
  resources?: Record<string, number>;
  weight?: number;
} = {}) {
  return {
    count,
    resources: new Map(Object.entries(resources)),
    weight,
  };
}

describe("scripts/test-docker-all scheduler", () => {
  it("allows an overweight lane to start alone under low parallelism", () => {
    expect(
      canStartSchedulerLane(
        {
          name: "install-e2e",
          resources: ["npm"],
          weight: 4,
        },
        activePool(),
        2,
        limits,
      ),
    ).toBe(true);
  });

  it("does not co-schedule another lane while an overweight lane is active", () => {
    expect(
      canStartSchedulerLane(
        {
          name: "package-update",
          resources: ["npm"],
          weight: 1,
        },
        activePool({
          count: 1,
          resources: {
            docker: 4,
            npm: 4,
          },
          weight: 4,
        }),
        2,
        limits,
      ),
    ).toBe(false);
  });

  it("can co-schedule the split installer provider lanes", () => {
    expect(
      canStartSchedulerLane(
        {
          name: "install-e2e-anthropic",
          resources: ["npm", "service"],
          weight: 3,
        },
        activePool({
          count: 1,
          resources: {
            docker: 3,
            npm: 3,
            service: 3,
          },
          weight: 3,
        }),
        10,
        {
          resourceLimits: {
            docker: 10,
            npm: 10,
            service: 7,
          },
          weightLimit: 10,
        },
      ),
    ).toBe(true);
  });

  it("preserves the parallelism count cap", () => {
    expect(
      canStartSchedulerLane(
        {
          name: "package-update",
          resources: ["npm"],
          weight: 1,
        },
        activePool({
          count: 2,
          resources: {
            docker: 1,
            npm: 1,
          },
          weight: 1,
        }),
        2,
        limits,
      ),
    ).toBe(false);
  });

  it("keeps resource and weight limits as co-scheduling limits", () => {
    expect(
      canStartSchedulerLane(
        {
          name: "npm-smoke",
          resources: ["npm"],
          weight: 1,
        },
        activePool({
          count: 1,
          resources: {
            docker: 1,
            npm: 1,
          },
          weight: 1,
        }),
        2,
        limits,
      ),
    ).toBe(true);

    expect(
      canStartSchedulerLane(
        {
          name: "npm-heavy",
          resources: ["npm"],
          weight: 2,
        },
        activePool({
          count: 1,
          resources: {
            docker: 1,
            npm: 1,
          },
          weight: 1,
        }),
        2,
        limits,
      ),
    ).toBe(false);
  });

  it("describes effective scheduler limits for operator errors", () => {
    expect(describeDockerSchedulerLimits(2, limits)).toBe(
      "parallelism=2 weightLimit=2 resources=docker=2 npm=2",
    );
  });
});
