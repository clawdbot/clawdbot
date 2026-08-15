import type { WorkerBrowserRuntime } from "./browser-runtime.js";

const workerDeployBrowserRuntime: WorkerBrowserRuntime = {
  async createAttachedBrowserToolRuntime() {
    throw new Error("worker deploy Browser runtime was not composed by the build");
  },
};

export default workerDeployBrowserRuntime;
