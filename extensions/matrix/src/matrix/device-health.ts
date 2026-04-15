export type MatrixManagedDeviceInfo = {
  deviceId: string;
  displayName: string | null;
  current: boolean;
};

export type MatrixDeviceHealthSummary = {
  currentDeviceId: string | null;
  staleOpenClawDevices: MatrixManagedDeviceInfo[];
  currentOpenClawDevices: MatrixManagedDeviceInfo[];
};

const OPENCLAW_DEVICE_NAME_PREFIX = "OpenClaw ";

export function isOpenClawManagedMatrixDevice(displayName: string | null | undefined): boolean {
  return displayName?.startsWith(OPENCLAW_DEVICE_NAME_PREFIX) === true;
}

export function summarizeMatrixDeviceHealth(
  devices: MatrixManagedDeviceInfo[],
): MatrixDeviceHealthSummary {
  const currentDeviceId = devices.find((device) => device.current)?.deviceId ?? null;
  const openClawDevices = devices.filter((device) =>
    isOpenClawManagedMatrixDevice(device.displayName),
  );
  return {
    currentDeviceId,
    staleOpenClawDevices: openClawDevices.filter((device) => !device.current),
    currentOpenClawDevices: openClawDevices.filter((device) => device.current),
  };
}
