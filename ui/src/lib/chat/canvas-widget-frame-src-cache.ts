const MAX_ENTRIES = 100;
// Rotations within one connection keep srcs stable so mounted frames retain state;
// connection boundaries clear the cache before dead credentials can be reused.
const srcByDocumentId = new Map<string, string>();

export function resolveCanvasWidgetFrameSrc(params: {
  documentId: string;
  resolve: () => string | undefined;
}): string | undefined {
  const cached = srcByDocumentId.get(params.documentId);
  if (cached !== undefined) {
    return cached;
  }
  const src = params.resolve();
  if (!src) {
    return undefined;
  }
  if (srcByDocumentId.size >= MAX_ENTRIES) {
    const oldest = srcByDocumentId.keys().next().value;
    if (oldest !== undefined) {
      srcByDocumentId.delete(oldest);
    }
  }
  srcByDocumentId.set(params.documentId, src);
  return src;
}

export function resetCanvasWidgetFrameSrcCache(): void {
  srcByDocumentId.clear();
}
