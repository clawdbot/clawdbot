import type { MatrixClient } from "matrix-js-sdk";

import { saveMediaBuffer } from "../../../../../src/media/store.js";

async function fetchMatrixMediaBuffer(params: {
  client: MatrixClient;
  mxcUrl: string;
  maxBytes: number;
}): Promise<{ buffer: Buffer; headerType?: string } | null> {
  const url = params.client.mxcUrlToHttp(
    params.mxcUrl,
    undefined,
    undefined,
    undefined,
    false,
    true,
    true,
  );
  if (!url) return null;
  const token = params.client.getAccessToken();
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    throw new Error(`Matrix media download failed: HTTP ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > params.maxBytes) {
    throw new Error("Matrix media exceeds configured size limit");
  }
  const headerType = res.headers.get("content-type") ?? undefined;
  return { buffer, headerType };
}

export async function downloadMatrixMedia(params: {
  client: MatrixClient;
  mxcUrl: string;
  contentType?: string;
  maxBytes: number;
}): Promise<{
  path: string;
  contentType?: string;
  placeholder: string;
} | null> {
  const fetched = await fetchMatrixMediaBuffer({
    client: params.client,
    mxcUrl: params.mxcUrl,
    maxBytes: params.maxBytes,
  });
  if (!fetched) return null;
  const headerType = fetched.headerType ?? params.contentType ?? undefined;
  const saved = await saveMediaBuffer(fetched.buffer, headerType, "inbound", params.maxBytes);
  return {
    path: saved.path,
    contentType: saved.contentType,
    placeholder: "[matrix media]",
  };
}
