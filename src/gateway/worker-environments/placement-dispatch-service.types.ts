import type { createWorkerPlacementDispatchService } from "./placement-dispatch.js";

export type WorkerPlacementDispatchService = ReturnType<
  typeof createWorkerPlacementDispatchService
>;
