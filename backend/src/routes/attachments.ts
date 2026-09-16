// Attachment routes: upload (voice/media/file), download (auth-gated), delete.
// Storage goes through the StorageProvider abstraction (KV today, R2-ready tomorrow).
import { Hono } from 'hono';
import { getAuth, requireAuth, requireMembership } from '../lib/auth';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { getStorage, storageKeyFor } from '../lib/storage';
import { publishToMembers } from '../lib/publish';
import { listMemberIds } from '../lib/auth';

export const attachmentRoutes = new Hono<{ Bindings: Env }>();

attachmentRoutes.use('*', requireAuth);

const ALLOWED_MIME = [
  'audio/ogg', 'audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/webm',
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/webm',
  'application/pdf', 'application/zip', 'application/octet-stream',
  'text/plain',
];

const KIND_BY_MIME: Record<string, 'voice' | 'image' | 'video' | 'file'> = {
  'audio/ogg': 'voice', 'audio/aac': 'voice', 'audio/mp4': 'voice', 'audio/mpeg': 'voice',
  'audio/wav': 'voice', 'audio/webm': 'voice',
};

attachmentRoutes.post('/attachments', async (c) => {
  const me = getAuth(c).userId;
  const maxBytes = parseInt(c.env.MAX_ATTACHMENT_BYTES ?? '24000000', 10);

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw badRequest('INVALID_FORM', 'Expected multipart/form-data');
  }
  const file = form.get('file');
  if (!(file instanceof File)) throw badRequest('VALIDATION_ERROR', 'file field is required');

  const mime = (file.type || 'application/octet-stream').toLowerCase();
  if (!ALLOWED_MIME.includes(mime)) throw badRequest('UNSUPPORTED_MEDIA', `MIME type not allowed: ${mime}`);
  if (file.size > maxBytes) throw badRequest('FILE_TOO_LARGE', `Max size is ${maxBytes} bytes`);

  const conversationId = (form.get('conversation_id') as string | null) || null;
  if (conversationId) await requireMembership(c.env.DB, me, conversationId);

  const declaredKind = (form.get('kind') as string | null) || '';
  const kind: 'voice' | 'image' | 'video' | 'file' =
    declaredKind === 'voice' || declaredKind === 'image' || declaredKind === 'video' || declaredKind === 'file'
      ? declaredKind
      : (KIND_BY_MIME[mime] ?? (mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'file'));

  let waveform: number[] | null = null;
  const waveRaw = form.get('waveform') as string | null;
  if (waveRaw) {
    try {
      const parsed = JSON.parse(waveRaw) as unknown;
      if (Array.isArray(parsed) && parsed.every((n) => typeof n === 'number' && n >= 0 && n <= 255) && parsed.length <= 256) {
        waveform = parsed;
      }
    } catch {
      /* ignore malformed waveform */
    }
  }
  const durationRaw = form.get('duration_ms') as string | null;
  const durationMs = durationRaw ? Math.max(0, Math.min(parseInt(durationRaw, 10) || 0, 24 * 3600_000)) : null;

  const attId = crypto.randomUUID();
  const key = storageKeyFor(attId);
  const storage = getStorage(c.env);
  const bytes = await file.arrayBuffer();
  await storage.put(key, bytes, mime);

  try {
    await c.env.DB.prepare(
      `INSERT INTO attachments (id, owner_id, conversation_id, kind, mime_type, size_bytes, duration_ms, waveform, storage_key, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
      .bind(attId, me, conversationId, kind, mime, file.size, durationMs, waveform ? JSON.stringify(waveform) : null, key, Date.now())
      .run();
  } catch (e) {
    await storage.delete(key).catch(() => undefined);
    throw e;
  }

  if (conversationId) {
    const memberIds = await listMemberIds(c.env.DB, conversationId);
    await publishToMembers(c.env, conversationId, memberIds, {
      t: 'attachment.ready',
      conversation_id: conversationId,
      attachment_id: attId,
    }, me);
  }

  return c.json(
    {
      attachment: {
        id: attId,
        kind,
        mime_type: mime,
        size_bytes: file.size,
        duration_ms: durationMs,
        waveform,
        conversation_id: conversationId,
      },
    },
    201,
  );
});

attachmentRoutes.get('/attachments/:id', async (c) => {
  const me = getAuth(c).userId;
  const att = await c.env.DB.prepare('SELECT * FROM attachments WHERE id = ?1').bind(c.req.param('id')).first();
  if (!att) throw notFound('ATTACHMENT_NOT_FOUND', 'Attachment not found');
  // Authorization: members of the conversation, or the owner for non-conversation attachments.
  if (att.conversation_id) {
    await requireMembership(c.env.DB, me, att.conversation_id as string);
  } else if (att.owner_id !== me) {
    throw forbidden('FORBIDDEN', 'Not allowed to download this attachment');
  }
  const storage = getStorage(c.env);
  const obj = await storage.get(att.storage_key as string);
  if (!obj) throw notFound('ATTACHMENT_MISSING', 'Attachment content is no longer available');
  return new Response(obj.data, {
    headers: {
      'content-type': obj.contentType ?? att.mime_type as string,
      'content-length': String(att.size_bytes),
      'cache-control': 'private, max-age=31536000, immutable',
      'content-disposition': att.kind === 'file' ? `attachment; filename="${att.id}"` : 'inline',
    },
  });
});

attachmentRoutes.delete('/attachments/:id', async (c) => {
  const me = getAuth(c).userId;
  const att = await c.env.DB.prepare('SELECT * FROM attachments WHERE id = ?1').bind(c.req.param('id')).first();
  if (!att) throw notFound('ATTACHMENT_NOT_FOUND', 'Attachment not found');
  if (att.owner_id !== me) throw forbidden('FORBIDDEN', 'Only the owner can delete an attachment');
  const storage = getStorage(c.env);
  await storage.delete(att.storage_key as string).catch(() => undefined);
  await c.env.DB.prepare('DELETE FROM attachments WHERE id = ?1').bind(att.id).run();
  return c.json({ ok: true });
});
