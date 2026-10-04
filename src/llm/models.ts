/** Model families that cannot chat with tools (embeddings, speech, image generation, research agents, moderation…). */
const NON_CHAT =
  /embed|tts|whisper|transcri|audio|speech|dall-e|imagen|-image\b|image-generation|veo|aqa|moderation|rerank|davinci|babbage|deep-research|computer-use|\blive\b/i;

/** Lists chat models from an OpenAI-compatible `GET {baseUrl}/models`. */
export async function listModels(baseUrl: string, apiKey: string | undefined, signal?: AbortSignal): Promise<string[]> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { headers, signal });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return parseModelList(await response.json());
}

export function parseModelList(json: unknown): string[] {
  const data = (json as { data?: unknown; models?: unknown })?.data ?? (json as { models?: unknown })?.models;
  if (!Array.isArray(data)) return [];
  const ids = data
    .map((m) => (typeof m === 'string' ? m : (m as { id?: unknown; name?: unknown })?.id ?? (m as { name?: unknown })?.name))
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    // Gemini lists ids as "models/gemini-…" but expects them without the prefix.
    .map((id) => id.replace(/^models\//, ''))
    .filter((id) => !NON_CHAT.test(id));
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
