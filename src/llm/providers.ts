export interface ProviderPreset {
  id: string;
  label: string;
  detail: string;
  baseUrl: string;
  /** Suggested model; replaced by a `prefer` match when the provider no longer lists it. */
  model: string;
  /** Where to create a key. Local servers have none. */
  keyUrl?: string;
  /** Picks the newest matching model when `model` is gone from the provider's list. */
  prefer?: RegExp;
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'gemini',
    label: 'Google Gemini',
    detail: 'Free tier — key from Google AI Studio',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3.8-flash',
    keyUrl: 'https://aistudio.google.com/apikey',
    prefer: /^gemini-[\d.]+-flash$/,
  },
  {
    id: 'groq',
    label: 'Groq',
    detail: 'Free tier — fast open models',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'openai/gpt-oss-120b',
    keyUrl: 'https://console.groq.com/keys',
    prefer: /gpt-oss-120b|^llama-[\d.]+-70b-versatile$/,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    detail: 'Hundreds of models with one key, some free',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'google/gemini-3.8-flash',
    keyUrl: 'https://openrouter.ai/keys',
    prefer: /^google\/gemini-[\d.]+-flash$/,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    detail: 'Paid — GPT models',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
    keyUrl: 'https://platform.openai.com/api-keys',
    prefer: /^gpt-[\d.]+$/,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    detail: 'Low-cost coding models',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    prefer: /^deepseek-(chat|v[\d.]+(-flash)?)$/,
  },
  {
    id: 'ollama',
    label: 'Ollama',
    detail: 'Free — runs on your computer, no key',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5-coder:14b',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    detail: 'Free — runs on your computer, no key',
    baseUrl: 'http://localhost:1234/v1',
    model: '',
  },
];

/** Chooses the model to use after connecting, given the provider's model list (may be empty if it could not be fetched). */
export function pickModel(preset: ProviderPreset, available: string[]): string {
  if (!available.length || available.includes(preset.model)) return preset.model;
  const preferred = preset.prefer ? available.filter((m) => preset.prefer!.test(m)) : [];
  if (preferred.length) {
    return preferred.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[preferred.length - 1];
  }
  // Local servers only offer what the user has downloaded, so any of those beats a missing default.
  return preset.keyUrl ? preset.model : available[0];
}
