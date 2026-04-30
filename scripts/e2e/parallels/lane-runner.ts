import { warn } from "./host-command.ts";

export type SmokeLane = "fresh" | "upgrade";
export type SmokeLaneStatus = "pass" | "fail";

export async function runSmokeLane(
  name: SmokeLane,
  fn: () => Promise<void>,
  setStatus: (name: SmokeLane, status: SmokeLaneStatus) => void,
): Promise<void> {
  try {
    await fn();
    setStatus(name, "pass");
  } catch (error) {
    setStatus(name, "fail");
    warn(`${name} lane failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
