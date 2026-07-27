import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import {
  formatHostingProfileIds,
  getStandardHostingProfile,
  HOSTING_PROFILE_CONTRACT_VERSION,
  listStandardHostingProfiles,
  parseHostingProfileId,
  type HostingProfileDescriptor,
} from "../hosting/profiles.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

type HostingProfilesCommandOptions = {
  json?: boolean;
};

function formatProfileList(profiles: HostingProfileDescriptor[]): string {
  return renderTable({
    width: getTerminalTableWidth(),
    border: "none",
    columns: [
      { key: "profile", header: "PROFILE", minWidth: 14 },
      { key: "posture", header: "POSTURE", flex: true, minWidth: 28 },
      { key: "conditions", header: "CONDITIONS", minWidth: 10 },
      { key: "required", header: "REQUIRED", minWidth: 8 },
      { key: "advisory", header: "ADVISORY", minWidth: 8 },
    ],
    rows: profiles.map((profile) => ({
      profile: profile.id,
      posture: profile.description,
      conditions: String(profile.profileConditions.length),
      required: String(profile.requiredCriteria.length),
      advisory: String(profile.advisoryCriteria.length),
    })),
  });
}

function formatProfile(profile: HostingProfileDescriptor): string {
  const section = (label: string, values: readonly string[]) => [
    `${label}:`,
    ...values.map((value) => `- ${value}`),
  ];
  return [
    `Profile: ${profile.id}`,
    `Contract version: ${HOSTING_PROFILE_CONTRACT_VERSION}`,
    `Posture: ${profile.description}`,
    "",
    ...section("Profile conditions", profile.profileConditions),
    "",
    ...section("Required criteria", profile.requiredCriteria),
    "",
    ...section("Advisory criteria", profile.advisoryCriteria),
  ].join("\n");
}

export function hostingProfilesListCommand(
  options: HostingProfilesCommandOptions,
  runtime: RuntimeEnv,
): void {
  const profiles = listStandardHostingProfiles();
  if (options.json) {
    writeRuntimeJson(runtime, {
      contractVersion: HOSTING_PROFILE_CONTRACT_VERSION,
      profiles,
    });
    return;
  }
  runtime.log(formatProfileList(profiles));
}

export function hostingProfilesInspectCommand(
  id: string,
  options: HostingProfilesCommandOptions,
  runtime: RuntimeEnv,
): void {
  const profileId = parseHostingProfileId(id);
  if (!profileId) {
    runtime.error(
      `Unknown hosting profile ${JSON.stringify(id)}. Use ${formatHostingProfileIds()}.`,
    );
    runtime.exit(1);
    return;
  }
  const profile = getStandardHostingProfile(profileId);
  if (options.json) {
    writeRuntimeJson(runtime, {
      contractVersion: HOSTING_PROFILE_CONTRACT_VERSION,
      profile,
    });
    return;
  }
  runtime.log(formatProfile(profile));
}
