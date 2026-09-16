// AI Assistant provider layer (server-side only - keys NEVER ship in the APK).
// Priority: 1) AI_MOCK=1 (tests/dev)  2) Workers AI binding (free tier)
//           3) OpenAI-compatible endpoint via AI_API_KEY (+ optional AI_BASE_URL)

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export const AI_SYSTEM_PROMPT =
  'You are Nabz AI, the built-in assistant of a small private messenger. ' +
  'Be concise, friendly and helpful. Support the chat language of the user.';

export async function generateAiReply(env: Env, history: ChatMessage[]): Promise<string> {
  const messages = [{ role: 'system' as const, content: AI_SYSTEM_PROMPT }, ...history];

  if (env.AI_MOCK === '1') {
    const lastUser = [...history].reverse().find((m) => m.role === 'user');
    return `[mock-ai] You said: "${(lastUser?.content ?? '').slice(0, 200)}"`;
  }

  if (env.AI) {
    const model = env.AI_MODEL || '@cf/meta/llama-3.1-8b-instruct';
    const result = await env.AI.run(model, { messages });
    const response = (result as { response?: string }).response;
    if (typeof response === 'string' && response.length > 0) return response;
    throw new Error('Workers AI returned an empty response');
  }

  if (env.AI_API_KEY) {
    const base = env.AI_BASE_URL || 'https://api.openai.com/v1';
    const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.AI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: env.AI_MODEL || 'gpt-4o-mini', messages, max_tokens: 1024 }),
    });
    if (!res.ok) throw new Error(`AI provider error (${res.status})`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (content) return content;
    throw new Error('AI provider returned an empty response');
  }

  throw new Error('AI_NOT_CONFIGURED');
}
