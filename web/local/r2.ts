// R2 on the local filesystem, for `yanroku up` (local mode). Covers what src/ uses: put, get (with a byte range), head,
// delete (one key or many), createMultipartUpload / resumeMultipartUpload (uploadPart, complete, abort).
// Layout under root: objects/<key> (the bytes), meta/<key>.json (size, etag, httpMetadata), uploads/<id>/ (parts).
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

type HttpMetadata = { contentType?: string };
type Meta = { size: number; etag: string; uploaded: string; httpMetadata: HttpMetadata };
type Body = ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null;

// keys are built by src/ (u/<uid>/rec/<id>/source.m4a …); still refuse anything that could leave root
function checkKey(key: string) {
  if (!key || key.startsWith("/") || key.includes("\\") || key.includes("\0") || key.split("/").some((s) => s === "" || s === "." || s === ".."))
    throw new Error(`invalid object key: ${JSON.stringify(key)}`);
  return key;
}

function checkUploadId(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("invalid upload id");
  return id;
}

function toNodeStream(body: Body): Readable {
  if (body == null) return Readable.from([]);
  if (typeof body === "string") return Readable.from([Buffer.from(body)]);
  if (body instanceof ArrayBuffer) return Readable.from([Buffer.from(body)]);
  if (ArrayBuffer.isView(body)) return Readable.from([Buffer.from(body.buffer, body.byteOffset, body.byteLength)]);
  if (body instanceof Blob) return Readable.fromWeb(body.stream() as never);
  return Readable.fromWeb(body as never);
}

/** Writes body to path through a temp file (renamed into place); returns size and MD5. */
async function writeAtomic(path: string, body: Body) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  const md5 = createHash("md5");
  let size = 0;
  const count = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      md5.update(chunk);
      size += chunk.length;
      cb(null, chunk);
    },
  });
  try {
    await pipeline(toNodeStream(body), count, createWriteStream(tmp));
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  return { size, md5: md5.digest("hex") };
}

async function fileMd5(path: string) {
  const md5 = createHash("md5");
  for await (const chunk of createReadStream(path)) md5.update(chunk as Buffer);
  return md5.digest("hex");
}

class LocalObject {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly httpEtag: string;
  readonly uploaded: Date;
  readonly httpMetadata: HttpMetadata;
  readonly range?: { offset: number; length: number };
  readonly body: ReadableStream;

  constructor(key: string, meta: Meta, body: ReadableStream, range?: { offset: number; length: number }) {
    this.key = key;
    this.size = meta.size;
    this.etag = meta.etag;
    this.httpEtag = `"${meta.etag}"`;
    this.uploaded = new Date(meta.uploaded);
    this.httpMetadata = meta.httpMetadata;
    this.range = range;
    this.body = body;
  }

  writeHttpMetadata(headers: Headers) {
    if (this.httpMetadata.contentType) headers.set("Content-Type", this.httpMetadata.contentType);
  }

  async arrayBuffer() {
    return new Response(this.body).arrayBuffer();
  }
}

export class LocalR2 {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  #object(key: string) {
    return join(this.root, "objects", checkKey(key));
  }
  #meta(key: string) {
    return join(this.root, "meta", `${checkKey(key)}.json`);
  }
  #upload(id: string) {
    return join(this.root, "uploads", checkUploadId(id));
  }

  async #readMeta(key: string): Promise<Meta | null> {
    try {
      return JSON.parse(await readFile(this.#meta(key), "utf8")) as Meta;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async #writeMeta(key: string, meta: Meta) {
    await writeAtomic(this.#meta(key), JSON.stringify(meta)); // a crash mid-write must not leave half a JSON file
  }

  async put(key: string, body: Body, opts: { httpMetadata?: HttpMetadata } = {}) {
    const { size, md5 } = await writeAtomic(this.#object(key), body);
    const meta: Meta = { size, etag: md5, uploaded: new Date().toISOString(), httpMetadata: opts.httpMetadata ?? {} };
    await this.#writeMeta(key, meta);
    return new LocalObject(key, meta, new ReadableStream({ start: (c) => c.close() }));
  }

  async head(key: string) {
    const meta = await this.#readMeta(key);
    return meta && new LocalObject(key, meta, new ReadableStream({ start: (c) => c.close() }));
  }

  async get(key: string, opts: { range?: { offset?: number; length?: number; suffix?: number } } = {}) {
    const stored = await this.#readMeta(key);
    if (!stored) return null;
    // size from the open file, not the meta: a put renaming a new file into place in between can't skew the lengths
    const fh = await open(this.#object(key), "r").catch(() => null);
    if (!fh) return null;
    const meta = { ...stored, size: (await fh.stat()).size };
    let range: { offset: number; length: number } | undefined;
    if (opts.range) {
      const r = opts.range;
      const offset = r.suffix !== undefined ? Math.max(0, meta.size - r.suffix) : (r.offset ?? 0);
      const length = r.suffix !== undefined ? meta.size - offset : Math.min(r.length ?? meta.size - offset, meta.size - offset);
      range = { offset, length: Math.max(0, length) };
    }
    if (range && range.length === 0) await fh.close();
    const stream = range
      ? range.length > 0 ? fh.createReadStream({ start: range.offset, end: range.offset + range.length - 1 }) : Readable.from([])
      : fh.createReadStream();
    return new LocalObject(key, meta, Readable.toWeb(stream) as ReadableStream, range);
  }

  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      await rm(this.#meta(key), { force: true }); // meta first: an object without meta reads as missing, not as broken
      await rm(this.#object(key), { force: true });
    }
  }

  async createMultipartUpload(key: string, opts: { httpMetadata?: HttpMetadata } = {}) {
    checkKey(key);
    const uploadId = randomUUID();
    await mkdir(this.#upload(uploadId), { recursive: true });
    await writeAtomic(join(this.#upload(uploadId), "upload.json"), JSON.stringify({ key, httpMetadata: opts.httpMetadata ?? {} }));
    return this.resumeMultipartUpload(key, uploadId);
  }

  resumeMultipartUpload(key: string, uploadId: string) {
    const dir = this.#upload(uploadId);
    const info = async () => {
      let raw: string;
      try {
        raw = await readFile(join(dir, "upload.json"), "utf8");
      } catch {
        throw new Error("multipart upload not found");
      }
      const u = JSON.parse(raw) as { key: string; httpMetadata: HttpMetadata };
      if (u.key !== key) throw new Error("multipart upload belongs to another key");
      return u;
    };
    const partPath = (n: number) => join(dir, `part-${n}`);
    return {
      key,
      uploadId,
      uploadPart: async (partNumber: number, body: Body) => {
        await info();
        if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) throw new Error("part number must be 1..10000");
        const { md5 } = await writeAtomic(partPath(partNumber), body);
        return { partNumber, etag: md5 };
      },
      complete: async (parts: { partNumber: number; etag: string }[]) => {
        const u = await info();
        if (!parts.length) throw new Error("no parts");
        const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
        if (sorted.some((p, i) => i > 0 && p.partNumber === sorted[i - 1].partNumber)) throw new Error("duplicate part numbers");
        for (const p of sorted) {
          const md5 = await fileMd5(partPath(p.partNumber)).catch(() => null);
          if (md5 === null) throw new Error(`part ${p.partNumber} not uploaded`);
          if (md5 !== p.etag) throw new Error(`part ${p.partNumber}: etag mismatch`);
        }
        const all = Readable.from((async function* () {
          for (const p of sorted) yield* createReadStream(partPath(p.partNumber));
        })());
        const { size } = await writeAtomic(this.#object(key), Readable.toWeb(all) as ReadableStream);
        // like R2: a multipart etag is the MD5 of the parts' MD5s plus the part count
        const etag = `${createHash("md5").update(Buffer.from(sorted.map((p) => p.etag).join(""), "hex")).digest("hex")}-${sorted.length}`;
        const meta: Meta = { size, etag, uploaded: new Date().toISOString(), httpMetadata: u.httpMetadata };
        await this.#writeMeta(key, meta);
        await rm(dir, { recursive: true, force: true });
        return new LocalObject(key, meta, new ReadableStream({ start: (c) => c.close() }));
      },
      abort: async () => {
        await info();
        await rm(dir, { recursive: true, force: true });
      },
    };
  }

  /** Removes multipart uploads untouched for maxAgeMs (R2 expires them after 7 days). */
  async pruneUploads(maxAgeMs = 7 * 24 * 3600_000) {
    const dir = join(this.root, "uploads");
    const ids = await readdir(dir).catch(() => [] as string[]);
    for (const id of ids) {
      const s = await stat(join(dir, id)).catch(() => null);
      if (s && Date.now() - s.mtimeMs > maxAgeMs) await rm(join(dir, id), { recursive: true, force: true });
    }
  }
}
