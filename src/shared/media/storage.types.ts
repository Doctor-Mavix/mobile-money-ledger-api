export interface ObjectStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Used by the processing worker, which reads the original the request already stored. */
  get(key: string): Promise<Buffer>;
  /** Time-limited read URL. Buckets stay private; nothing is ever served by a public URL. */
  presignedUrl(key: string, expiresInSeconds: number): Promise<string>;
  remove(key: string): Promise<void>;
}
