import { describe, it } from "vitest";
import { expectNativeHarnessModelsPublishedFromWorker } from "./prepared-model-catalog-worker.test-support.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest } = usePreparedCatalogWorkerFixtures();

describe("prepared native model catalog worker boundary", () => {
  it("retains configured dynamic models alongside native harness models after full refresh", async () => {
    await expectNativeHarnessModelsPublishedFromWorker({ makeTempDir, retireAfterTest });
  });
});
