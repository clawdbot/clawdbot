import photon from "@silvia-odwyer/photon-node";

/** Decode validated BMP bytes only after Rastermill rejects the format. */
export function convertBmpToPngWithPhoton(buffer: Buffer): Buffer {
  let image: InstanceType<typeof photon.PhotonImage> | undefined;
  try {
    image = photon.PhotonImage.new_from_byteslice(buffer);
    const bytes = image.get_bytes();
    // Photon copies PNG bytes out of WASM, so this view survives image.free().
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } finally {
    image?.free();
  }
}
