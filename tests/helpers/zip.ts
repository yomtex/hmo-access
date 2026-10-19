/**
 * Minimal ZIP writer for upload-security tests. Entries are stored (not compressed) and the sizes
 * written to the directory can be overridden, which lets tests describe hostile archives
 * (decompression bombs, encrypted entries, path traversal) without producing gigabytes of data.
 */
export type ZipEntry = { name: string; data?: Buffer; flags?: number; claimUncompressed?: number; claimCompressed?: number };

export function makeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = e.data ?? Buffer.alloc(0);
    const comp = e.claimCompressed ?? data.length;
    const uncomp = e.claimUncompressed ?? data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(e.flags ?? 0, 6);
    lh.writeUInt32LE(comp, 18);
    lh.writeUInt32LE(uncomp, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(e.flags ?? 0, 8);
    ch.writeUInt32LE(comp, 20);
    ch.writeUInt32LE(uncomp, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** The parts every .xlsx has; tests add hostile parts to these. */
export const XLSX_BASE: ZipEntry[] = [
  { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
  { name: "xl/workbook.xml", data: Buffer.from("<workbook/>") },
];
