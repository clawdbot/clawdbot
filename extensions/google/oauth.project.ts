import { fetchWithTimeout } from "./oauth.http.js";
import {
  CODE_ASSIST_ENDPOINT_PROD,
  LOAD_CODE_ASSIST_ENDPOINTS,
  TIER_FREE,
  TIER_LEGACY,
  TIER_STANDARD,
  USERINFO_URL,
} from "./oauth.shared.js";

const LOAD_CODE_ASSIST_METADATA = {
  ideType: "IDE_UNSPECIFIED",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
} as const;

async function getUserEmail(accessToken: string): Promise<string | undefined> {
  try {
    const response = await fetchWithTimeout(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.ok) {
      const data = (await response.json()) as { email?: string };
      return data.email;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function isVpcScAffected(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") {
    return false;
  }
  const details = (error as { details?: unknown[] }).details;
  if (!Array.isArray(details)) {
    return false;
  }
  return details.some(
    (item) =>
      typeof item === "object" &&
      item &&
      (item as { reason?: string }).reason === "SECURITY_POLICY_VIOLATED",
  );
}

function getDefaultTier(
  allowedTiers?: Array<{ id?: string; isDefault?: boolean }>,
): { id?: string } | undefined {
  if (!allowedTiers?.length) {
    return { id: TIER_LEGACY };
  }
  return allowedTiers.find((tier) => tier.isDefault) ?? { id: TIER_LEGACY };
}

async function pollOperation(
  endpoint: string,
  operationName: string,
  headers: Record<string, string>,
): Promise<{ done?: boolean; response?: { cloudaicompanionProject?: { id?: string } } }> {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const response = await fetchWithTimeout(`${endpoint}/v1internal/${operationName}`, {
      headers,
    });
    if (!response.ok) {
      continue;
    }
    const data = (await response.json()) as {
      done?: boolean;
      response?: { cloudaicompanionProject?: { id?: string } };
    };
    if (data.done) {
      return data;
    }
  }
  throw new Error("Operation polling timeout");
}

export async function resolveGoogleOAuthIdentity(accessToken: string): Promise<{
  email?: string;
  projectId?: string;
}> {
  const email = await getUserEmail(accessToken);
  const projectId = await discoverProject(accessToken);
  return { email, projectId };
}

export async function resolveGooglePersonalOAuthIdentity(accessToken: string): Promise<{
  email?: string;
  projectId?: string;
}> {
  return { email: await getUserEmail(accessToken) };
}

async function discoverProject(accessToken: string): Promise<string> {
  const envProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": "google-api-nodejs-client/9.15.1",
    "X-Goog-Api-Client": `gl-node/${process.versions.node}`,
    "Client-Metadata": JSON.stringify(LOAD_CODE_ASSIST_METADATA),
  };

  const loadBody = {
    ...(envProject ? { cloudaicompanionProject: envProject } : {}),
    metadata: {
      ...LOAD_CODE_ASSIST_METADATA,
      ...(envProject ? { duetProject: envProject } : {}),
    },
  };

  let data: {
    currentTier?: { id?: string };
    cloudaicompanionProject?: string | { id?: string };
    allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
  } = {};
  let activeEndpoint = CODE_ASSIST_ENDPOINT_PROD;
  let loadError: Error | undefined;
  for (const endpoint of LOAD_CODE_ASSIST_ENDPOINTS) {
    try {
      const response = await fetchWithTimeout(`${endpoint}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers,
        body: JSON.stringify(loadBody),
      });

      if (!response.ok) {
        const errorPayload = await response.json().catch(() => null);
        if (isVpcScAffected(errorPayload)) {
          data = { currentTier: { id: TIER_STANDARD } };
          activeEndpoint = endpoint;
          loadError = undefined;
          break;
        }
        loadError = new Error(`loadCodeAssist failed: ${response.status} ${response.statusText}`);
        continue;
      }

      data = (await response.json()) as typeof data;
      activeEndpoint = endpoint;
      loadError = undefined;
      break;
    } catch (err) {
      loadError = err instanceof Error ? err : new Error("loadCodeAssist failed", { cause: err });
    }
  }

  const hasLoadCodeAssistData =
    Boolean(data.currentTier) ||
    Boolean(data.cloudaicompanionProject) ||
    Boolean(data.allowedTiers?.length);
  if (!hasLoadCodeAssistData && loadError) {
    if (envProject) {
      return envProject;
    }
    throw loadError;
  }

  if (data.currentTier) {
    const project = data.cloudaicompanionProject;
    if (typeof project === "string" && project) {
      return project;
    }
    if (typeof project === "object" && project?.id) {
      return project.id;
    }
    if (envProject) {
      return envProject;
    }
    throw new Error(
      "This account requires GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID to be set.",
    );
  }

  const tier = getDefaultTier(data.allowedTiers);
  const tierId = tier?.id || TIER_FREE;
  if (tierId !== TIER_FREE && !envProject) {
    throw new Error(
      "This account requires GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID to be set.",
    );
  }

  const onboardBody: Record<string, unknown> = {
    tierId,
    metadata: {
      ...LOAD_CODE_ASSIST_METADATA,
    },
  };
  if (tierId !== TIER_FREE && envProject) {
    onboardBody.cloudaicompanionProject = envProject;
    (onboardBody.metadata as Record<string, unknown>).duetProject = envProject;
  }

  const onboardResponse = await fetchWithTimeout(`${activeEndpoint}/v1internal:onboardUser`, {
    method: "POST",
    headers,
    body: JSON.stringify(onboardBody),
  });

  if (!onboardResponse.ok) {
    throw new Error(`onboardUser failed: ${onboardResponse.status} ${onboardResponse.statusText}`);
  }

  let lro = (await onboardResponse.json()) as {
    done?: boolean;
    name?: string;
    response?: { cloudaicompanionProject?: { id?: string } };
  };

  if (!lro.done && lro.name) {
    lro = await pollOperation(activeEndpoint, lro.name, headers);
  }

  const projectId = lro.response?.cloudaicompanionProject?.id;
  if (projectId) {
    return projectId;
  }
  if (envProject) {
    return envProject;
  }

  throw new Error(
    "Could not discover or provision a Google Cloud project. Set GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID.",
  );
}
