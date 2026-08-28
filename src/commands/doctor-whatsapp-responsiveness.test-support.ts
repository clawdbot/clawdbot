import "./doctor-whatsapp-responsiveness.js";

type LocalTuiProcess = { pid: number; command: string };
type ProcessSignal = "SIGTERM" | "SIGKILL";
type ProcessController = { kill(pid: number, signal: ProcessSignal | 0): boolean };

type TestApi = {
  listLocalTuiProcesses(): LocalTuiProcess[];
  terminateLocalTuiProcesses(params: {
    processes: LocalTuiProcess[];
    controller?: ProcessController;
    graceMs?: number;
  }): Promise<{ stopped: number[]; failed: number[] }>;
};

function getTestApi(): TestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.doctorWhatsappResponsivenessTestApi")
  ] as TestApi;
}

export const listLocalTuiProcesses: TestApi["listLocalTuiProcesses"] = () =>
  getTestApi().listLocalTuiProcesses();

export const terminateLocalTuiProcesses: TestApi["terminateLocalTuiProcesses"] = (params) =>
  getTestApi().terminateLocalTuiProcesses(params);
