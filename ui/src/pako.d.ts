declare module "pako" {
  type CompressionLevel = -1 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

  export function gzip(
    data: string | ArrayBuffer | Uint8Array,
    options?: { legacyHash?: boolean; level?: CompressionLevel },
  ): Uint8Array;
}
