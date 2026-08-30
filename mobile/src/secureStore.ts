import {JarvisSecureStore} from './native';

export const SECURE_KEYS = {
  cursorApiKey: 'cursor_api_key',
  cursorModelId: 'cursor_model_id',
  cursorEnabled: 'cursor_enabled',
  openaiApiKey: 'openai_api_key',
  openaiModelId: 'openai_model_id',
  openaiEnabled: 'openai_enabled',
} as const;

export async function getSecureValue(key: string): Promise<string | null> {
  return JarvisSecureStore.getSecret(key);
}

export async function setSecureValue(key: string, value: string): Promise<void> {
  await JarvisSecureStore.setSecret(key, value);
}

export async function deleteSecureValue(key: string): Promise<void> {
  await JarvisSecureStore.deleteSecret(key);
}

export async function hasSecureValue(key: string): Promise<boolean> {
  return JarvisSecureStore.hasSecret(key);
}

export async function isCursorCloudEnabled(): Promise<boolean> {
  const [enabled, apiKey] = await Promise.all([
    getSecureValue(SECURE_KEYS.cursorEnabled),
    getSecureValue(SECURE_KEYS.cursorApiKey),
  ]);
  return enabled === 'true' && Boolean(apiKey);
}

export async function getCursorCloudSettings(): Promise<{apiKey: string | null; modelId: string; enabled: boolean}> {
  const [apiKey, modelId, enabled] = await Promise.all([
    getSecureValue(SECURE_KEYS.cursorApiKey),
    getSecureValue(SECURE_KEYS.cursorModelId),
    getSecureValue(SECURE_KEYS.cursorEnabled),
  ]);
  return {
    apiKey,
    modelId: modelId || 'composer-2.5',
    enabled: enabled === 'true' && Boolean(apiKey),
  };
}

export async function getOpenAISettings(): Promise<{apiKey: string | null; modelId: string; enabled: boolean}> {
  const [apiKey, modelId, enabled] = await Promise.all([
    getSecureValue(SECURE_KEYS.openaiApiKey),
    getSecureValue(SECURE_KEYS.openaiModelId),
    getSecureValue(SECURE_KEYS.openaiEnabled),
  ]);
  return {
    apiKey,
    modelId: modelId || 'gpt-4o-mini',
    enabled: enabled === 'true' && Boolean(apiKey),
  };
}

export async function getAllLlmSettings(): Promise<{
  provider: 'openai' | 'cursor' | 'embedded';
  cursor: {apiKey: string | null; modelId: string; enabled: boolean};
  openai: {apiKey: string | null; modelId: string; enabled: boolean};
}> {
  const cursor = await getCursorCloudSettings();
  const openai = await getOpenAISettings();

  let provider: 'openai' | 'cursor' | 'embedded' = 'embedded';
  if (openai.enabled) provider = 'openai';
  if (cursor.enabled && !openai.enabled) provider = 'cursor';

  return {provider, cursor, openai};
}
