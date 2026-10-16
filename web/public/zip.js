// Yanroku export zips (設定 › 搬家, public/transfer.js): a STORE-only zip writer and reader with zip64, so archives and
// entries over 4 GB work. Audio is already AAC, so nothing is compressed. Plain script (no build step): sets
// globalThis.YanrokuZip; node tests load it with import(). The writer keeps Blobs as Blobs, so a multi-GB export is
// assembled by the browser (disk-backed) instead of sitting in JS memory.
(() => {
  const TABLE = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  /** CRC-32 of bytes, continuing from `crc` (the previous call's result). */
  function crc32(bytes, crc = 0) {
    let c = ~crc;
    for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return ~c >>> 0;
  }

  const MAX32 = 0xffffffff, MAX16 = 0xffff, SLICE = 8 * 1024 * 1024;
  const enc = new TextEncoder();
  const put64 = (v, n, x) => { v.setUint32(n, x % 0x100000000, true); v.setUint32(n + 4, Math.floor(x / 0x100000000), true); };
  const get64 = (v, n) => v.getUint32(n, true) + v.getUint32(n + 4, true) * 0x100000000;
  const asBlob = (d) => (d instanceof Blob ? d : new Blob([typeof d === "string" ? enc.encode(d) : d]));

  async function blobCrc(blob) {
    let crc = 0;
    for (let at = 0; at < blob.size; at += SLICE) crc = crc32(new Uint8Array(await blob.slice(at, at + SLICE).arrayBuffer()), crc);
    return crc;
  }

  class ZipWriter {
    constructor({ zip64Always = false } = {}) {
      this.zip64Always = zip64Always;
      this.parts = [];
      this.entries = [];
      this.offset = 0;
    }
    async add(name, data) {
      const blob = asBlob(data), size = blob.size, crc = await blobCrc(blob), nameBytes = enc.encode(name);
      const zip64 = this.zip64Always || size >= MAX32 || this.offset >= MAX32;
      const extra = zip64 ? 20 : 0;
      const h = new DataView(new ArrayBuffer(30 + nameBytes.length + extra));
      h.setUint32(0, 0x04034b50, true);
      h.setUint16(4, zip64 ? 45 : 20, true);
      h.setUint16(6, 0x0800, true); // UTF-8 names
      h.setUint16(8, 0, true); // STORE
      h.setUint32(14, crc, true);
      h.setUint32(18, zip64 ? MAX32 : size, true);
      h.setUint32(22, zip64 ? MAX32 : size, true);
      h.setUint16(26, nameBytes.length, true);
      h.setUint16(28, extra, true);
      new Uint8Array(h.buffer).set(nameBytes, 30);
      if (zip64) {
        const at = 30 + nameBytes.length;
        h.setUint16(at, 0x0001, true);
        h.setUint16(at + 2, 16, true);
        put64(h, at + 4, size);
        put64(h, at + 12, size);
      }
      this.entries.push({ nameBytes, size, crc, offset: this.offset, zip64: zip64 || this.offset >= MAX32 });
      this.parts.push(new Uint8Array(h.buffer), blob);
      this.offset += h.byteLength + size;
    }
    finish() {
      const cdStart = this.offset;
      let cdSize = 0, any64 = this.zip64Always;
      for (const e of this.entries) {
        const zip64 = e.zip64 || e.size >= MAX32 || e.offset >= MAX32;
        any64 ||= zip64;
        const extra = zip64 ? 28 : 0;
        const c = new DataView(new ArrayBuffer(46 + e.nameBytes.length + extra));
        c.setUint32(0, 0x02014b50, true);
        c.setUint16(4, zip64 ? 45 : 20, true);
        c.setUint16(6, zip64 ? 45 : 20, true);
        c.setUint16(8, 0x0800, true);
        c.setUint16(10, 0, true);
        c.setUint32(16, e.crc, true);
        c.setUint32(20, zip64 ? MAX32 : e.size, true);
        c.setUint32(24, zip64 ? MAX32 : e.size, true);
        c.setUint16(28, e.nameBytes.length, true);
        c.setUint16(30, extra, true);
        c.setUint32(42, zip64 ? MAX32 : e.offset, true);
        new Uint8Array(c.buffer).set(e.nameBytes, 46);
        if (zip64) {
          const at = 46 + e.nameBytes.length;
          c.setUint16(at, 0x0001, true);
          c.setUint16(at + 2, 24, true);
          put64(c, at + 4, e.size);
          put64(c, at + 12, e.size);
          put64(c, at + 20, e.offset);
        }
        this.parts.push(new Uint8Array(c.buffer));
        cdSize += c.byteLength;
      }
      const n = this.entries.length;
      any64 ||= n >= MAX16 || cdStart >= MAX32 || cdSize >= MAX32;
      if (any64) {
        const z = new DataView(new ArrayBuffer(56 + 20));
        z.setUint32(0, 0x06064b50, true);
        put64(z, 4, 44);
        z.setUint16(12, 45, true);
        z.setUint16(14, 45, true);
        put64(z, 24, n);
        put64(z, 32, n);
        put64(z, 40, cdSize);
        put64(z, 48, cdStart);
        z.setUint32(56, 0x07064b50, true); // locator
        put64(z, 64, cdStart + cdSize);
        z.setUint32(72, 1, true);
        this.parts.push(new Uint8Array(z.buffer));
      }
      const end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true);
      end.setUint16(8, any64 ? MAX16 : n, true);
      end.setUint16(10, any64 ? MAX16 : n, true);
      end.setUint32(12, any64 ? MAX32 : cdSize, true);
      end.setUint32(16, any64 ? MAX32 : cdStart, true);
      this.parts.push(new Uint8Array(end.buffer));
      return new Blob(this.parts, { type: "application/zip" });
    }
  }

  const view = async (blob, at, len) => new DataView(await blob.slice(at, at + len).arrayBuffer());

  /** Entries of a STORE zip (ours), read through File.slice: Map name → { size, crc, blob() }. */
  async function readZip(file) {
    const tailLen = Math.min(file.size, 22 + 0xffff);
    const tail = await view(file, file.size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("not a zip file");
    let count = tail.getUint16(eocd + 10, true), cdSize = tail.getUint32(eocd + 12, true), cdStart = tail.getUint32(eocd + 16, true);
    if (eocd >= 20 && tail.getUint32(eocd - 20, true) === 0x07064b50) {
      const z = await view(file, get64(tail, eocd - 20 + 8), 56);
      if (z.getUint32(0, true) !== 0x06064b50) throw new Error("broken zip64 end record");
      count = get64(z, 32), cdSize = get64(z, 40), cdStart = get64(z, 48);
    }
    const cd = await view(file, cdStart, cdSize);
    const dec = new TextDecoder();
    const out = new Map();
    for (let p = 0, i = 0; i < count; i++) {
      if (cd.getUint32(p, true) !== 0x02014b50) throw new Error("broken zip central directory");
      if (cd.getUint16(p + 10, true) !== 0) throw new Error("unsupported zip (compressed entry)");
      const crc = cd.getUint32(p + 16, true), nameLen = cd.getUint16(p + 28, true), extraLen = cd.getUint16(p + 30, true), commentLen = cd.getUint16(p + 32, true);
      let size = cd.getUint32(p + 24, true), offset = cd.getUint32(p + 42, true);
      const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
      for (let x = p + 46 + nameLen; x < p + 46 + nameLen + extraLen;) {
        const tag = cd.getUint16(x, true), len = cd.getUint16(x + 2, true);
        if (tag === 0x0001) {
          let q = x + 4;
          if (size === MAX32) size = get64(cd, q), (q += 8);
          if (cd.getUint32(p + 20, true) === MAX32) q += 8; // compressed size (= size for STORE)
          if (offset === MAX32) offset = get64(cd, q);
        }
        x += 4 + len;
      }
      const local = await view(file, offset, 30);
      if (local.getUint32(0, true) !== 0x04034b50) throw new Error("broken zip local header");
      const start = offset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
      out.set(name, { size, crc, blob: () => file.slice(start, start + size) });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  globalThis.YanrokuZip = { crc32, ZipWriter, readZip };
})();
