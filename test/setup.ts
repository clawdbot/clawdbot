import { installTestEnv } from "./test-env";

const { cleanup } = installTestEnv();
process.on("exit", cleanup);
