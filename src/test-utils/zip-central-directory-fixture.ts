// Builds minimal ZIP central-directory-only archives for archive limit tests.
export function createZipCentralDirectoryArchive(params: {
  actualEntryCount: number;
  declaredEntryCount?: number;
  declaredCentralDirectorySize?: number;
}): Buffer {
  const centralDirectory = Buffer.concat(
    Array.from({ length: params.actualEntryCount }, (_, index) => {
      const name = Buffer.from(`file-${index}.txt`);
      const header = Buffer.alloc(46 + name.byteLength);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(name.byteLength, 28);
      name.copy(header, 46);
      return header;
    }),
  );
  const declaredEntryCount = params.declaredEntryCount ?? params.actualEntryCount;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Math.min(declaredEntryCount, 0xffff), 8);
  eocd.writeUInt16LE(Math.min(declaredEntryCount, 0xffff), 10);
  eocd.writeUInt32LE(params.declaredCentralDirectorySize ?? centralDirectory.byteLength, 12);
  eocd.writeUInt32LE(0, 16);
  return Buffer.concat([centralDirectory, eocd]);
}
