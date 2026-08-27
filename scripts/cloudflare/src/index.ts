export { OpenClawContainer } from "./container.js";

interface ContainerStub {
  fetch(request: Request): Promise<Response>;
}

interface ContainerNamespace {
  getByName(name: string): ContainerStub;
}

interface WorkerEnv {
  OPENCLAW_CONTAINER: ContainerNamespace;
}

interface WorkerHandler {
  fetch(request: Request, env: WorkerEnv): Promise<Response>;
}

// One stable name gives the installation one globally unique Durable Object.
// That object is the outer single-writer fence for the Litestream replica.
const INSTALLATION_INSTANCE = "openclaw-installation";

const worker: WorkerHandler = {
  async fetch(request, env) {
    return env.OPENCLAW_CONTAINER.getByName(INSTALLATION_INSTANCE).fetch(request);
  },
};

export default worker;
