import crypto from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { authenticate } from "./urbit/auth.js";
import { scryUrbitPath } from "./urbit/channel-ops.js";
import { ssrfPolicyFromDangerouslyAllowPrivateNetwork } from "./urbit/context.js";

type ClientConfig = {
  shipUrl: string;
  shipName: string;
  verbose: boolean;
  getCode: () => Promise<string>;
  dangerouslyAllowPrivateNetwork?: boolean;
};

type StorageService = "presigned-url" | "credentials";

type StorageConfiguration = {
  buckets: string[];
  currentBucket: string;
  region: string;
  publicUrlBase: string;
  presignedUrl: string;
  service: StorageService;
};

type StorageCredentials = {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
};

type UploadFileParams = {
  blob: Blob;
  fileName?: string;
  contentType?: string;
};

type UploadResult = {
  url: string;
};

const MEMEX_BASE_URL = "https://memex.tlon.network";

const mimeToExt: Record<string, string> = {
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

let currentClientConfig: ClientConfig | null = null;

export function configureClient(params: ClientConfig): void {
  currentClientConfig = {
    ...params,
    shipName: params.shipName.replace(/^~/, ""),
  };
}

function requireClientConfig(): ClientConfig {
  if (!currentClientConfig) {
    throw new Error("Tlon client not configured");
  }
  return currentClientConfig;
}

function getExtensionFromMimeType(mimeType?: string): string {
  if (!mimeType) {
    return ".jpg";
  }
  return mimeToExt[normalizeLowercaseStringOrEmpty(mimeType)] || ".jpg";
}

function hasCustomS3Creds(
  credentials: StorageCredentials | null,
): credentials is StorageCredentials {
  return Boolean(credentials?.accessKeyId && credentials?.endpoint && credentials?.secretAccessKey);
}

function isStorageCredentials(value: unknown): value is StorageCredentials {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.endpoint === "string" &&
    typeof record.accessKeyId === "string" &&
    typeof record.secretAccessKey === "string"
  );
}

function isHostedShipUrl(shipUrl: string): boolean {
  try {
    const { hostname } = new URL(shipUrl);
    return hostname.endsWith("tlon.network") || hostname.endsWith(".test.tlon.systems");
  } catch {
    return shipUrl.endsWith("tlon.network") || shipUrl.endsWith(".test.tlon.systems");
  }
}

function prefixEndpoint(endpoint: string): string {
  return endpoint.match(/https?:\/\//) ? endpoint : `https://${endpoint}`;
}

function sanitizeFileName(fileName: string): string {
  return fileName.split(/[/\\]/).pop() || fileName;
}

async function getAuthCookie(config: ClientConfig): Promise<string> {
  return await authenticate(config.shipUrl, await config.getCode(), {
    ssrfPolicy: ssrfPolicyFromDangerouslyAllowPrivateNetwork(config.dangerouslyAllowPrivateNetwork),
  });
}

async function scryJson<T>(config: ClientConfig, cookie: string, path: string): Promise<T> {
  return (await scryUrbitPath(
    {
      baseUrl: config.shipUrl,
      cookie,
      ssrfPolicy: ssrfPolicyFromDangerouslyAllowPrivateNetwork(
        config.dangerouslyAllowPrivateNetwork,
      ),
    },
    { path, auditContext: "tlon-storage-scry" },
  )) as T;
}

async function getStorageConfiguration(
  config: ClientConfig,
  cookie: string,
): Promise<StorageConfiguration> {
  const result = await scryJson<
    { "storage-update"?: { configuration?: StorageConfiguration } } | StorageConfiguration
  >(config, cookie, "/storage/configuration.json");

  if ("storage-update" in result && result["storage-update"]?.configuration) {
    return result["storage-update"].configuration;
  }
  if ("currentBucket" in result) {
    return result;
  }
  throw new Error("Invalid storage configuration response");
}

async function getStorageCredentials(
  config: ClientConfig,
  cookie: string,
): Promise<StorageCredentials | null> {
  const result = await scryJson<
    { "storage-update"?: { credentials?: StorageCredentials } } | StorageCredentials
  >(config, cookie, "/storage/credentials.json");

  if ("storage-update" in result) {
    return result["storage-update"]?.credentials ?? null;
  }
  if (isStorageCredentials(result)) {
    return result;
  }
  return null;
}

async function getMemexUploadUrl(params: {
  config: ClientConfig;
  cookie: string;
  contentLength: number;
  contentType: string;
  fileName: string;
}): Promise<{ hostedUrl: string; uploadUrl: string }> {
  const token = await scryJson<string | { secret?: string }>(
    params.config,
    params.cookie,
    "/genuine/secret.json",
  );
  const resolvedToken = typeof token === "string" ? token : token.secret;
  if (!resolvedToken) {
    throw new Error("Missing genuine secret");
  }

  const endpoint = `${MEMEX_BASE_URL}/v1/${params.config.shipName}/upload`;
  const response = await fetch(endpoint, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: resolvedToken,
      contentLength: params.contentLength,
      contentType: params.contentType,
      fileName: params.fileName,
    }),
  });

  if (!response.ok) {
    throw new Error(`Memex upload request failed: ${response.status}`);
  }

  const data = (await response.json()) as { url?: string; filePath?: string } | null;
  if (!data?.url || !data.filePath) {
    throw new Error("Invalid response from Memex");
  }

  return { hostedUrl: data.filePath, uploadUrl: data.url };
}

export async function uploadFile(params: UploadFileParams): Promise<UploadResult> {
  const config = requireClientConfig();
  const cookie = await getAuthCookie(config);

  const [storageConfig, credentials] = await Promise.all([
    getStorageConfiguration(config, cookie),
    getStorageCredentials(config, cookie),
  ]);

  const contentType = params.contentType || params.blob.type || "application/octet-stream";
  const extension = getExtensionFromMimeType(contentType);
  const fileName = sanitizeFileName(params.fileName || `upload${extension}`);
  const fileKey = `${config.shipName}/${Date.now()}-${crypto.randomUUID()}-${fileName}`;

  const useMemex =
    isHostedShipUrl(config.shipUrl) &&
    (storageConfig.service === "presigned-url" || !hasCustomS3Creds(credentials));

  if (useMemex) {
    const { hostedUrl, uploadUrl } = await getMemexUploadUrl({
      config,
      cookie,
      contentLength: params.blob.size,
      contentType,
      fileName: fileKey,
    });

    const response = await fetch(uploadUrl, {
      method: "PUT",
      body: params.blob,
      headers: {
        "Cache-Control": "public, max-age=3600",
        "Content-Type": contentType,
      },
    });

    if (!response.ok) {
      throw new Error(`Upload failed: ${response.status}`);
    }

    return { url: hostedUrl };
  }

  if (!hasCustomS3Creds(credentials)) {
    throw new Error("No storage credentials configured");
  }

  const endpoint = new URL(prefixEndpoint(credentials.endpoint));
  const client = new S3Client({
    endpoint: {
      protocol: endpoint.protocol.slice(0, -1) as "http" | "https",
      hostname: endpoint.host,
      path: endpoint.pathname || "/",
    },
    region: storageConfig.region || "us-east-1",
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
    forcePathStyle: true,
  });

  const headers: Record<string, string> = {
    "Cache-Control": "public, max-age=3600",
    "Content-Type": contentType,
    "x-amz-acl": "public-read",
  };

  const command = new PutObjectCommand({
    Bucket: storageConfig.currentBucket,
    Key: fileKey,
    ContentType: headers["Content-Type"],
    CacheControl: headers["Cache-Control"],
    ACL: "public-read",
  });

  const signedUrl = await getSignedUrl(client, command, {
    expiresIn: 3600,
    signableHeaders: new Set(Object.keys(headers)),
  });

  const response = await fetch(signedUrl, {
    method: "PUT",
    body: params.blob,
    headers: signedUrl.includes("digitaloceanspaces.com") ? headers : undefined,
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status}`);
  }

  const publicUrl = storageConfig.publicUrlBase
    ? new URL(fileKey, storageConfig.publicUrlBase).toString()
    : signedUrl.split("?")[0];

  return { url: publicUrl };
}
