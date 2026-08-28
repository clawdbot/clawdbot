import type { DraftCloudProfile } from "./discovery.ts";

export class DraftCloudMachineState {
  private readonly overrides = new Map<string, string>();

  clear() {
    this.overrides.clear();
  }

  applyPending(profileId: string, machineClass?: string) {
    if (machineClass) {
      this.overrides.set(profileId, machineClass);
    } else {
      this.overrides.delete(profileId);
    }
  }

  resolve(profileId: string): string {
    return this.overrides.get(profileId) ?? "";
  }

  select(
    profileId: string,
    machineId: string,
    profiles: readonly DraftCloudProfile[],
    disabled = false,
    onChange?: () => void,
  ): boolean {
    if (disabled) {
      return false;
    }
    const profile = profiles.find((candidate) => candidate.id === profileId);
    const machine = profile?.machines?.find((candidate) => candidate.id === machineId);
    if (!machine) {
      return false;
    }
    if (machine.default === true) {
      this.overrides.delete(profileId);
    } else {
      this.overrides.set(profileId, machine.id);
    }
    onChange?.();
    return true;
  }
}
