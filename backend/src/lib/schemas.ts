// Zod validation schemas. Every route validates its inputs; unknown fields are stripped.
import { z } from 'zod';

export const usernameSchema = z
  .string()
  .regex(/^[a-z0-9_]{3,32}$/, 'username must be 3-32 chars: a-z, 0-9, _');

export const passwordSchema = z.string().min(8, 'password too short (min 8)').max(128);

export const registerSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  display_name: z.string().min(1).max(64),
  invite_code: z.string().max(128).optional(),
});

export const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
  device_uid: z.string().min(8).max(128),
  device_name: z.string().max(64).optional(),
  device_platform: z.string().max(32).optional(),
});

export const refreshSchema = z.object({
  refresh_token: z.string().min(16).max(256),
});

export const updateProfileSchema = z
  .object({
    display_name: z.string().min(1).max(64).optional(),
    bio: z.string().max(280).optional(),
    avatar_attachment_id: z.string().min(1).max(64).nullable().optional(),
  })
  .strict();

export const createConversationSchema = z
  .object({
    type: z.enum(['private', 'group']),
    title: z.string().min(1).max(128).optional(),
    member_ids: z.array(z.string().min(1).max(64)).min(1).max(50),
  })
  .strict()
  .refine((v) => v.type !== 'group' || (v.title !== undefined && v.title.length > 0), {
    message: 'group conversations require a title',
  });

export const sendMessageSchema = z
  .object({
    type: z.enum(['text', 'voice', 'media', 'file']).default('text'),
    body: z.string().max(Number(process.env?.MAX_MESSAGE_LENGTH ?? 4096)).optional(),
    reply_to_message_id: z.string().max(64).optional(),
    attachment_id: z.string().max(64).optional(),
  })
  .strict()
  .refine((v) => v.type !== 'text' || (v.body !== undefined && v.body.trim().length > 0), {
    message: 'text messages require a body',
  })
  .refine((v) => v.type !== 'voice' || v.attachment_id !== undefined, {
    message: 'voice messages require an attachment_id',
  });

export const editMessageSchema = z
  .object({ body: z.string().min(1).max(4096) })
  .strict();

export const reactionSchema = z
  .object({ emoji: z.string().min(1).max(16).regex(/^\S+$/, 'emoji must not contain whitespace') })
  .strict();

export const readSchema = z
  .object({ message_id: z.string().min(1).max(64) })
  .strict();

export const typingSchema = z
  .object({ state: z.enum(['typing', 'stop']) })
  .strict();

export const pushRegisterSchema = z
  .object({
    device_uid: z.string().min(8).max(128),
    name: z.string().max(64).optional(),
    platform: z.enum(['android', 'ios', 'web', 'other']).default('android'),
    provider: z.enum(['fcm']).default('fcm'),
    push_token: z.string().min(16).max(4096),
  })
  .strict();

export const aiChatSchema = z
  .object({ content: z.string().min(1).max(8000) })
  .strict();

export const callEndSchema = z
  .object({ reason: z.enum(['hangup', 'decline', 'busy', 'timeout', 'error']).default('hangup') })
  .strict();
