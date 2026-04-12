import os from "node:os";
import { vi } from "vitest";

export type SkillsHomeEnvSnapshot = {
  previousHome: string | undefined;
  previousOpenClawHome: string | undefined;
  previousUserProfile: string | undefined;
};

export function setMockSkillsHomeEnv(fakeHome: string): SkillsHomeEnvSnapshot {
  const snapshot: SkillsHomeEnvSnapshot = {
    previousHome: process.env.HOME,
    previousOpenClawHome: process.env.OPENCLAW_HOME,
    previousUserProfile: process.env.USERPROFILE,
  };
  process.env.HOME = fakeHome;
  delete process.env.OPENCLAW_HOME;
  delete process.env.USERPROFILE;
  vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
  return snapshot;
}

export async function restoreMockSkillsHomeEnv(
  snapshot: SkillsHomeEnvSnapshot,
  cleanup?: () => Promise<void> | void,
) {
  vi.restoreAllMocks();
  if (snapshot.previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = snapshot.previousHome;
  }
  if (snapshot.previousOpenClawHome === undefined) {
    delete process.env.OPENCLAW_HOME;
  } else {
    process.env.OPENCLAW_HOME = snapshot.previousOpenClawHome;
  }
  if (snapshot.previousUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = snapshot.previousUserProfile;
  }
  await cleanup?.();
}
