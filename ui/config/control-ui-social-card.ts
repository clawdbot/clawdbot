import fs from "node:fs";
import { PhotonImage, resize, SamplingFilter, watermark } from "@silvia-odwyer/photon-node";
import type { Plugin } from "vite";

/** Generate the public card from the existing brand artwork, without a browser or fonts. */
export function controlUiSocialCardPlugin(): Plugin {
  return {
    name: "control-ui-social-card",
    apply: "build",
    buildStart() {
      const pixels = Buffer.alloc(1200 * 630 * 4, Buffer.from([11, 16, 22, 255]));
      const canvas = new PhotonImage(pixels, 1200, 630);
      const images = [canvas];
      try {
        const source = PhotonImage.new_from_byteslice(
          fs.readFileSync(new URL("../../docs/assets/openclaw-hero-dark.png", import.meta.url)),
        );
        images.push(source);
        const logo = resize(source, 1060, 376, SamplingFilter.Lanczos3);
        images.push(logo);
        watermark(canvas, logo, 70n, 127n);
        this.emitFile({ type: "asset", fileName: "social-card.png", source: canvas.get_bytes() });
      } finally {
        for (const image of images) {
          image.free();
        }
      }
    },
  };
}
