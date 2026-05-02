import type { OpenClawConfig } from "../runtime-api.js";
import { fetchGraphJson, resolveGraphToken } from "./graph.js";

type GraphUserProfile = {
  id?: string;
  displayName?: string;
  mail?: string;
  jobTitle?: string;
  userPrincipalName?: string;
  officeLocation?: string;
};

type GetMemberInfoMSTeamsParams = {
  cfg: OpenClawConfig;
  userId: string;
};

type GetMemberInfoMSTeamsResult = {
  user: {
    id: string | undefined;
    displayName: string | undefined;
    mail: string | undefined;
    jobTitle: string | undefined;
    userPrincipalName: string | undefined;
    officeLocation: string | undefined;
  };
};

/**
 * Fetch a user profile from Microsoft Graph by user ID.
 */
export async function getMemberInfoMSTeams(
  params: GetMemberInfoMSTeamsParams,
): Promise<GetMemberInfoMSTeamsResult> {
  const token = await resolveGraphToken(params.cfg);
  const path = `/users/${encodeURIComponent(params.userId)}?$select=id,displayName,mail,jobTitle,userPrincipalName,officeLocation`;
  const user = await fetchGraphJson<GraphUserProfile>({ token, path });
  return {
    user: {
      id: user.id,
      displayName: user.displayName,
      mail: user.mail,
      jobTitle: user.jobTitle,
      userPrincipalName: user.userPrincipalName,
      officeLocation: user.officeLocation,
    },
  };
}
