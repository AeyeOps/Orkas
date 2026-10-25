import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDER_MODELS } from '../../../src/main/features/client_config';

describe('client_config', () => {
  it('ships the synchronized public model catalog with compatibility metadata', () => {
    expect(DEFAULT_PROVIDER_MODELS['openai-codex']).toEqual([
      { id: 'gpt-6-astra', name: 'GPT-6 Astra', maxTokens: 128000, maxInputImages: 20 },
      { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', maxTokens: 64000, maxInputImages: 20 },
      { id: 'gpt-6-sol', name: 'GPT-6 Sol', maxTokens: 64000, maxInputImages: 20 },
      { id: 'gpt-6-luna', name: 'GPT-6 Luna', maxTokens: 64000, maxInputImages: 20 },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', template: 'gpt-5.5', maxTokens: 64000, maxInputImages: 20 },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', template: 'gpt-5.5', maxTokens: 64000, maxInputImages: 20 },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', template: 'gpt-5.5', maxTokens: 64000, maxInputImages: 20 },
    ]);
  });
});
