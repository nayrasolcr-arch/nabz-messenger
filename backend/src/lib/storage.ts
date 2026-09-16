// Attachment storage abstraction.
// Free-tier default: Workers KV (25MB values, 1GB free) - good for a 20-user messenger.
// Future: add an R2 binding named ATTACHMENTS_R2 in wrangler.toml and set
// STORAGE_PROVIDER=r2; the interface stays identical so the switch is non-breaking.

export interface StoredObject {
  data: ArrayBuffer;
  contentType: string | null;
}

export interface StorageProvider {
  put(key: string, data: ArrayBuffer, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
}

class KvStorageProvider implements StorageProvider {
  constructor(private kv: KVNamespace) {}
  async put(key: string, data: ArrayBuffer, contentType: string): Promise<void> {
    await this.kv.put(key, data, { metadata: { contentType } });
  }
  async get(key: string): Promise<StoredObject | null> {
    const res = await this.kv.getWithMetadata(key, { type: 'arrayBuffer' });
    if (!res.value) return null;
    return { data: res.value, contentType: (res.metadata as { contentType?: string } | null)?.contentType ?? null };
  }
  async delete(key: string): Promise<void> {
    await this.kv.delete(key);
  }
}

class R2StorageProvider implements StorageProvider {
  constructor(private r2: R2Bucket) {}
  async put(key: string, data: ArrayBuffer, contentType: string): Promise<void> {
    await this.r2.put(key, data, { httpMetadata: { contentType } });
  }
  async get(key: string): Promise<StoredObject | null> {
    const obj = await this.r2.get(key);
    if (!obj) return null;
    return { data: await obj.arrayBuffer(), contentType: obj.httpMetadata?.contentType ?? null };
  }
  async delete(key: string): Promise<void> {
    await this.r2.delete(key);
  }
}

export function getStorage(env: Env): StorageProvider {
  const anyEnv = env as unknown as { ATTACHMENTS_R2?: R2Bucket; STORAGE_PROVIDER?: string };
  if (anyEnv.STORAGE_PROVIDER === 'r2' && anyEnv.ATTACHMENTS_R2) {
    return new R2StorageProvider(anyEnv.ATTACHMENTS_R2);
  }
  if (env.ATTACHMENTS) return new KvStorageProvider(env.ATTACHMENTS);
  if (anyEnv.ATTACHMENTS_R2) return new R2StorageProvider(anyEnv.ATTACHMENTS_R2);
  throw new Error('STORAGE_NOT_CONFIGURED');
}

export function storageKeyFor(attachmentId: string): string {
  return `att/${attachmentId}`;
}
