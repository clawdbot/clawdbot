type ScreencastFrame = {
  data: string;
  metadata: {
    deviceWidth: number;
    deviceHeight: number;
    scrollOffsetX: number;
    scrollOffsetY: number;
    timestamp?: number;
  };
};

export function encodeBrowserScreencastFrame(url: string, frame: ScreencastFrame): Buffer {
  const header = Buffer.from(
    JSON.stringify({
      url,
      cssWidth: frame.metadata.deviceWidth,
      cssHeight: frame.metadata.deviceHeight,
      scrollX: frame.metadata.scrollOffsetX,
      scrollY: frame.metadata.scrollOffsetY,
      ts: frame.metadata.timestamp,
    }),
    "utf8",
  );
  const jpeg = Buffer.from(frame.data, "base64");
  const wire = Buffer.allocUnsafe(4 + header.length + jpeg.length);
  wire.writeUInt32BE(header.length, 0);
  header.copy(wire, 4);
  jpeg.copy(wire, 4 + header.length);
  return wire;
}
