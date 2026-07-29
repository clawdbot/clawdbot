import photon from "@silvia-odwyer/photon-node";

/** Decode validated BMP bytes only after Rastermill rejects the format. */
export function convertBmpToPngWithPhoton(buffer: Buffer): Buffer {
  let image: InstanceType<typeof photon.PhotonImage> | undefined;
  try {
    image = photon.PhotonImage.new_from_byteslice(buffer);
    return Buffer.from(image.get_bytes());
  } finally {
    image?.free();
  }
}
