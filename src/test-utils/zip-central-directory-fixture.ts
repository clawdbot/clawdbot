// Valid local records let entry-limit tests reach the physical central-directory scan.
export function createZipCentralDirectoryArchive(params: {
  actualEntryCount: number;
  declaredEntryCount?: number;
  entryType?: "file" | "directory";
}): Buffer {
  const localEntries: Buffer[] = [];
  let localOffset = 0;
  const centralDirectory = Buffer.concat(
    Array.from({ length: params.actualEntryCount }, (_, index) => {
      const name = Buffer.from(
        params.entryType === "directory" ? `folder-${index}/` : `file-${index}.txt`,
      );
      const local = Buffer.alloc(30 + name.byteLength);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(name.byteLength, 26);
      name.copy(local, 30);
      localEntries.push(local);
      const header = Buffer.alloc(46 + name.byteLength);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(name.byteLength, 28);
      header.writeUInt32LE(localOffset, 42);
      name.copy(header, 46);
      localOffset += local.byteLength;
      return header;
    }),
  );
  const declaredEntryCount = params.declaredEntryCount ?? params.actualEntryCount;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Math.min(declaredEntryCount, 0xffff), 8);
  eocd.writeUInt16LE(Math.min(declaredEntryCount, 0xffff), 10);
  eocd.writeUInt32LE(centralDirectory.byteLength, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localEntries, centralDirectory, eocd]);
}
