export async function readRemoteMediaResponse(
  res: Response,
  params: { maxBytes?: number; filePathHint?: string },
) {
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (typeof params.maxBytes === "number" && buffer.byteLength > params.maxBytes) {
    throw new Error(`payload exceeds maxBytes ${params.maxBytes}`);
  }
  return {
    buffer,
    contentType: res.headers.get("content-type") ?? undefined,
    fileName: params.filePathHint,
  };
}
