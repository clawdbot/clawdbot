import { describe, it } from "vitest";
import { expectNativeHarnessModelsPublishedFromWorker } from "./prepared-model-catalog-worker.test-support.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest } = usePreparedCatalogWorkerFixtures();

describe("prepared native model catalog worker boundary", () => {
  it("publishes native harness models through prepared list and chat metadata", async () => {
    await expectNativeHarnessModelsPublishedFromWorker({ makeTempDir, retireAfterTest });
  });
});
