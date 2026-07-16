import { escapeOData, fetchGraphJson, type GraphResponse, type GraphUser } from "./graph.js";

export async function searchGraphUsers(params: {
  token: string;
  query: string;
  top?: number;
}): Promise<GraphUser[]> {
  const query = params.query.trim();
  if (!query) {
    return [];
  }

  if (query.includes("@")) {
    const escaped = escapeOData(query);
    const filter = `(mail eq '${escaped}' or userPrincipalName eq '${escaped}')`;
    const path = `/users?$filter=${encodeURIComponent(filter)}&$select=id,displayName,mail,userPrincipalName`;
    const res = await fetchGraphJson<GraphResponse<GraphUser>>({ token: params.token, path });
    return res.value ?? [];
  }

  const top = typeof params.top === "number" && params.top > 0 ? params.top : 10;
  const path = `/users?$search=${encodeURIComponent(`"displayName:${query}"`)}&$select=id,displayName,mail,userPrincipalName&$top=${top}`;
  const res = await fetchGraphJson<GraphResponse<GraphUser>>({
    token: params.token,
    path,
    headers: { ConsistencyLevel: "eventual" },
  });
  return res.value ?? [];
}
