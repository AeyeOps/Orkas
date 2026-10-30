import { describe, it, expect } from 'vitest';
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';
import {
  CATALOG,
  CURATED_MODELS,
  VISIBLE_PROVIDERS,
  FEATURED_API_PROVIDERS,
  EXTERNAL_API_PROVIDERS,
  OAUTH_ALIAS_FOR,
  EXTRA_LABELS,
  isVisibleProvider,
  providerLabel,
  providerDocsUrl,
  providerSubscriptionNote,
  sortProviderIds,
  curatedModelsFor,
  modelInputFromConfiguredCapabilities,
  modelInputImageLimit,
  resolveConfiguredPiModel,
  isSelectableModel,
  resolveModelUpgrade,
  pickLatestGenerations,
} from '../../../src/main/model/provider_catalog';

describe('provider_catalog › CATALOG', () => {
  it('holds unique provider ids in display order', () => {
    const ids = CATALOG.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    // DeepSeek 直连先（pi-ai 不带，自建适配），然后全球前沿（OpenAI Codex /
    // OpenAI / Google / Anthropic），CN 主流（Zhipu / Moonshot / Kimi-Coding /
    // MiniMax × 3 / Doubao），最后聚合器（OpenRouter）。
    expect(ids).toEqual([
      'deepseek',
      'openai-codex',
      'openai',
      'google',
      'anthropic',
      'zai',
      'moonshot',
      'kimi-coding',
      'minimax-portal',
      'minimax-portal-cn',
      'minimax-cn',
      'doubao',
      'openrouter',
      'custom',
    ]);
  });

  it('has VISIBLE_PROVIDERS derived from CATALOG order', () => {
    expect([...VISIBLE_PROVIDERS]).toEqual(CATALOG.map((p) => p.id));
  });

  it('excludes oauthOnly entries from FEATURED_API_PROVIDERS (API-key docs list)', () => {
    const featuredIds = FEATURED_API_PROVIDERS.map((p) => p.id);
    expect(featuredIds).not.toContain('openai-codex');
    expect(featuredIds).toContain('openai');
    expect(featuredIds).toContain('zai');
    for (const p of FEATURED_API_PROVIDERS) {
      expect(p.docsUrl).toBeTruthy();
    }
  });

  it('tags Chinese providers with region=cn', () => {
    const cnIds = CATALOG.filter((p) => p.region === 'cn').map((p) => p.id);
    expect(cnIds).toEqual([
      'zai',
      'moonshot',
      'kimi-coding',
      'minimax-portal',
      'minimax-portal-cn',
      'minimax-cn',
      'doubao',
    ]);
  });

  it('aliases minimax-cn → minimax-portal-cn (same CN endpoint, 不同 auth)', () => {
    // OpenAI 和 OpenAI Codex 仍是两张独立卡（OAUTH_ALIAS_FOR 不含 openai）。
    // MiniMax 的 API-key 与 OAuth 走同一 endpoint (api.minimaxi.com)，折到
    // 同一张卡更符合用户直觉。
    expect(OAUTH_ALIAS_FOR).toEqual({ 'minimax-cn': 'minimax-portal-cn' });
  });
});

describe('provider_catalog › CURATED_MODELS', () => {
  it('curates every visible non-oauth-only provider', () => {
    // Every visible provider should have a curated list — no silent fall-
    // through to pickLatestGenerations for providers we advertise.
    for (const p of CATALOG) {
      if (p.customOpenAICompatible) {
        expect(CURATED_MODELS[p.id]).toBeUndefined();
        continue;
      }
      if (p.oauthOnly && p.id === 'openai-codex') {
        // openai-codex has a curated whitelist (ChatGPT subscription accepts
        // only 2 models — probed empirically).
        expect(CURATED_MODELS[p.id]?.length).toBeGreaterThan(0);
        continue;
      }
      expect(CURATED_MODELS[p.id]).toBeTruthy();
      expect(CURATED_MODELS[p.id]!.length).toBeGreaterThan(0);
    }
  });

  it('lists Chinese provider models', () => {
    expect(CURATED_MODELS.zai?.length).toBeGreaterThan(0);
    expect(CURATED_MODELS['kimi-coding']?.length).toBeGreaterThan(0);
    expect(CURATED_MODELS['minimax-cn']?.length).toBeGreaterThan(0);
    expect(CURATED_MODELS['moonshot']?.length).toBeGreaterThan(0);
  });

  it('moonshot catalog exposes only K3 and K2.7', () => {
    const ids = (CURATED_MODELS['moonshot'] || []).map((m) => m.id);
    expect(ids).toEqual(['kimi-k3', 'kimi-k2.7-code']);
  });

  it('offers two recent Kimi Coding generations with native SDK metadata and retains legacy identity', () => {
    const rows = CURATED_MODELS['kimi-coding'] || [];
    expect(rows.filter(m => !('hiddenFromPicker' in m && m.hiddenFromPicker)).map(m => m.id))
      .toEqual(['k3', 'k3-256k', 'kimi-for-coding']);
    expect(rows.find(m => m.id === 'k2p7')).toMatchObject({ hiddenFromPicker: true });
    for (const row of rows.filter(m => m.id !== 'k2p7')) {
      const resolved = resolveConfiguredPiModel({ getPiModel: getBuiltinModel as any }, 'kimi-coding', row.id);
      expect(resolved).toMatchObject({ templateModelId: row.id, isConfiguredFallback: false,
        model: { id: row.id, api: 'anthropic-messages', compat: { forceAdaptiveThinking: true } } });
    }
    expect(isSelectableModel('kimi-coding', 'k2p7')).toBe(true);
    expect(resolveModelUpgrade('kimi-coding', 'k2p7')).toMatchObject({ modelId: 'k2p7', upgraded: false });
  });

  it('resolves kimi-coding K3 as a native pi-ai model', async () => {
    const { getBuiltinModel } = await import('@earendil-works/pi-ai/providers/all');
    const catalog = {
      getPiModel(provider: string, modelId: string) {
        return (getBuiltinModel as (p: string, m: string) => any)(provider, modelId);
      },
    };
    const resolved = resolveConfiguredPiModel(catalog, 'kimi-coding', 'k3');
    expect(resolved).toMatchObject({
      requestedModelId: 'k3',
      templateModelId: 'k3',
      isConfiguredFallback: false,
      needsCustomModel: true,
      model: {
        api: 'anthropic-messages',
        reasoning: true,
        contextWindow: 1_000_000,
        maxTokens: 131_072,
        compat: {
          allowEmptySignature: true,
          forceAdaptiveThinking: true,
        },
      },
    });
  });

  it('minimax catalog exposes M3 before the M2.7 generation', () => {
    const directIds = (CURATED_MODELS['minimax-cn'] || []).map((m) => m.id);
    expect(directIds).toEqual([
      'MiniMax-M3',
      'MiniMax-M2.7',
    ]);

    const globalPortalIds = (CURATED_MODELS['minimax-portal'] || []).map((m) => m.id);
    expect(globalPortalIds).toEqual(directIds);

    const portalIds = (CURATED_MODELS['minimax-portal-cn'] || []).map((m) => m.id);
    expect(portalIds).toEqual(directIds);
  });

  it('exposes GLM 5.3 and 5.2 as native runnable Z.AI models', () => {
    const ids = (CURATED_MODELS.zai || []).map((m) => m.id);
    expect(ids).toEqual([
      'glm-5.3',
      'glm-5.2',
    ]);

    const catalog = {
      getPiModel(provider: string, modelId: string) {
        return (getBuiltinModel as (p: string, m: string) => any)(provider, modelId);
      },
    };
    for (const modelId of ids) {
      expect(resolveConfiguredPiModel(catalog, 'zai', modelId), modelId).toMatchObject({
        requestedModelId: modelId,
        templateModelId: modelId,
        isConfiguredFallback: false,
        needsCustomModel: false,
        model: {
          id: modelId,
          provider: 'zai',
          api: 'openai-completions',
          contextWindow: 1_000_000,
          maxTokens: 131_072,
          reasoning: true,
          input: ['text'],
        },
      });
    }
  });

  it.each([
    ['anthropic', 'claude-haiku-5-5'],
    ['openrouter', 'anthropic/claude-haiku-5.5'],
  ])('offers %s Haiku 5.5 with native adaptive thinking and accurate capacity', (provider, modelId) => {
    expect(isSelectableModel(provider, modelId)).toBe(true);
    const resolved = resolveConfiguredPiModel({ getPiModel: getBuiltinModel as any }, provider, modelId);
    expect(resolved).toMatchObject({
      isConfiguredFallback: false,
      templateModelId: modelId,
      model: {
        id: modelId,
        api: 'anthropic-messages',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        compat: { forceAdaptiveThinking: true, supportsTemperature: false },
        thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
        cost: { input: 0.1, output: 0.5, tiers: [{ inputTokensAbove: 100000, input: 0.5, output: 2.5 }] },
      },
    });
    expect(modelInputImageLimit(provider, modelId, resolved?.model)).toBe(20);
    expect(resolveModelUpgrade(provider, modelId).upgraded).toBe(false);
  });

  it('natively resolves every curated Claude and Gemini model', () => {
    for (const provider of ['anthropic', 'google']) {
      const modelIds = CURATED_MODELS[provider].map((model) => model.id);
      expect(modelIds.length).toBeGreaterThan(0);
      for (const modelId of modelIds) {
        const resolved = resolveConfiguredPiModel({ getPiModel: getBuiltinModel as any }, provider, modelId);
        expect(resolved).toMatchObject({
          requestedModelId: modelId,
          templateModelId: modelId,
          isConfiguredFallback: false,
          model: {
            id: modelId,
            provider,
            api: provider === 'anthropic' ? 'anthropic-messages' : 'google-generative-ai',
            input: ['text', 'image'],
          },
        });
      }
    }
  });

  it('natively resolves GPT-6 tiers and every retained GPT-5.6 tier', () => {
    const expected = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
    expect((CURATED_MODELS.openai || []).map((m) => m.id)).toEqual(expected);
    expect((CURATED_MODELS['openai-codex'] || []).map((m) => m.id)).toEqual(expected);
  });


  it('openrouter catalog includes DeepSeek / Qwen / GLM / Kimi / MiniMax', () => {
    const ids = (CURATED_MODELS.openrouter || []).map((m) => m.id);
    expect(ids.some((id) => id.startsWith('deepseek/'))).toBe(true);
    expect(ids.some((id) => id.startsWith('qwen/'))).toBe(true);
    expect(ids.some((id) => id.startsWith('z-ai/'))).toBe(true);
    expect(ids.some((id) => id.startsWith('moonshotai/'))).toBe(true);
    expect(ids.some((id) => id.startsWith('minimax/'))).toBe(true);
    expect(ids).toContain('minimax/minimax-m3');
    expect(ids).toContain('minimax/minimax-m2.7');
  });

  it('openrouter Claude shortcuts keep every Claude 5 variant', () => {
    const claudeIds = (CURATED_MODELS.openrouter || [])
      .map((m) => m.id)
      .filter((id) => id.includes('/claude-'));
    expect(claudeIds).toEqual([
      'anthropic/claude-opus-5.5',
      'anthropic/claude-opus-5',
      'anthropic/claude-fable-5.1',
      'anthropic/claude-fable-5',
      'anthropic/claude-sonnet-5.5',
      'anthropic/claude-sonnet-5',
      'anthropic/claude-haiku-5.5',
    ]);
  });

  it('openrouter GPT shortcuts keep every GPT-5.6 variant', () => {
    const ids = (CURATED_MODELS.openrouter || [])
      .map((m) => m.id)
      .filter((id) => id.startsWith('openai/gpt-'));
    expect(ids).toEqual([
      'openai/gpt-6-astra',
      'openai/gpt-6.1-sol',
      'openai/gpt-6-sol',
      'openai/gpt-6-luna',
      'openai/gpt-5.6-sol',
      'openai/gpt-5.6-terra',
      'openai/gpt-5.6-luna',
    ]);
  });

  it('resolves the OpenRouter V4.1 Flash shortcut with vision before the SDK catalogs it', () => {
    const modelId = 'deepseek/deepseek-v4.1-flash';
    const catalog = {
      getPiModel(provider: string, id: string) {
        if (provider === 'openrouter' && id === modelId) return undefined;
        return (getBuiltinModel as (p: string, m: string) => any)(provider, id);
      },
    };
    expect(curatedModelsFor('openrouter')).toContainEqual(expect.objectContaining({
      id: modelId,
      name: 'DeepSeek V4.1 Flash',
    }));
    const resolved = resolveConfiguredPiModel(catalog, 'openrouter', modelId);
    expect(resolved).toMatchObject({
      requestedModelId: modelId,
      isConfiguredFallback: true,
      needsCustomModel: true,
      model: {
        id: modelId,
        name: 'DeepSeek V4.1 Flash',
        provider: 'openrouter',
        api: 'openai-completions',
        baseUrl: 'https://openrouter.ai/api/v1',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        compat: { thinkingFormat: 'openrouter', requiresReasoningContentOnAssistantMessages: true },
      },
    });
    expect(modelInputImageLimit('openrouter', modelId, resolved?.model)).toBe(20);
  });

  it('curatedModelsFor returns a shallow copy safe to mutate', () => {
    const a = curatedModelsFor('anthropic');
    const b = curatedModelsFor('anthropic');
    expect(a).not.toBe(b);
    a.pop();
    expect(curatedModelsFor('anthropic').length).toBe(b.length);
  });

  it('curatedModelsFor returns [] for unknown providers (triggers pi-ai fallback)', () => {
    expect(curatedModelsFor('no-such-provider-id')).toEqual([]);
  });

  it.each([
    { input: ['text'] as const, configured: {}, expected: ['text'] },
    { input: ['text', 'image'] as const, configured: {}, expected: ['text', 'image'] },
    { input: ['text'] as const, configured: { supportsVision: true }, expected: ['text', 'image'] },
    { input: ['text', 'image'] as const, configured: { supportsVision: false }, expected: ['text'] },
    { input: ['text'] as const, configured: { maxInputImages: 12 }, expected: ['text', 'image'] },
    { input: ['text', 'image'] as const, configured: { maxInputImages: 0 }, expected: ['text'] },
    { input: ['text'] as const, configured: { supportsVision: true, maxInputImages: 12 }, expected: ['text', 'image'] },
    { input: ['text', 'image'] as const, configured: { supportsVision: false, maxInputImages: 0 }, expected: ['text'] },
  ])('applies configured vision capabilities: $configured', ({ input, configured, expected }) => {
    expect(modelInputFromConfiguredCapabilities([...input], configured)).toEqual(expected);
  });

  it('uses the product image limit for a multimodal model without a provider limit', () => {
    expect(modelInputImageLimit('unknown-provider', 'vision-next', {
      id: 'vision-next',
      input: ['text', 'image'],
    } as any)).toBe(20);
  });

  it('resolves bundled model ids by cloning a same-family pi-ai template', () => {
    const template = {
      id: 'claude-opus-5',
      name: 'Claude Opus 5',
      api: 'anthropic-messages',
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      reasoning: true,
      input: ['text'],
      cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1 },
      contextWindow: 200000,
      maxTokens: 32000,
    };
    const catalog = {
      getPiModel(provider: string, model: string) {
        return provider === 'anthropic' && model === template.id ? template as any : undefined;
      },
    };
    const resolved = resolveConfiguredPiModel(catalog, 'anthropic', 'claude-opus-5-5');
    expect(resolved).toMatchObject({
      needsCustomModel: true,
      isConfiguredFallback: true,
      templateModelId: template.id,
      model: { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', api: template.api },
    });
    const exactCatalog = {
      getPiModel(provider: string, model: string) {
        return provider === 'anthropic' && model === 'claude-opus-5-5'
          ? { ...template, id: 'claude-opus-5-5', name: 'Claude Opus 5.5' } as any : undefined;
      },
    };
    expect(resolveConfiguredPiModel(exactCatalog, 'anthropic', 'claude-opus-5-5')).toMatchObject({
      needsCustomModel: true,
      isConfiguredFallback: false,
      templateModelId: 'claude-opus-5-5',
    });
    const wrongFamilyCatalog = {
      getPiModel(provider: string, model: string) {
        return provider === 'anthropic' && model === 'claude-haiku-5-5'
          ? { ...template, id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' } as any : undefined;
      },
    };
    expect(resolveConfiguredPiModel(wrongFamilyCatalog, 'anthropic', 'claude-opus-5-5')).toBeNull();
    expect(resolveConfiguredPiModel(catalog, 'anthropic', 'claude-opus-future')).toBeNull();
  });
});

describe('provider_catalog › labels and docs', () => {
  it('providerLabel prefers CATALOG, then EXTRA_LABELS, then the raw id', () => {
    expect(providerLabel('zai')).toBe('Zhipu GLM');
    expect(providerLabel('minimax')).toBe(EXTRA_LABELS['minimax']);
    expect(providerLabel('totally-unknown-id')).toBe('totally-unknown-id');
  });

  it('providerDocsUrl is defined for every FEATURED_API_PROVIDERS entry', () => {
    for (const p of FEATURED_API_PROVIDERS) {
      expect(providerDocsUrl(p.id)).toBeTruthy();
    }
  });

  it('providerDocsUrl is undefined for oauthOnly providers', () => {
    expect(providerDocsUrl('openai-codex')).toBeUndefined();
  });

  it('providerDocsUrl is undefined for orphan providers', () => {
    expect(providerDocsUrl('huggingface')).toBeUndefined();
  });

  it('providerSubscriptionNote 在两条 Moonshot endpoint 上都给出明确前提', () => {
    // 用户反馈：开放平台按量付费和 Moonshot Coding Plan 订阅是两套独立账户，
    // 一张 key 不能两边通用。UI 必须在卡片/表单上把前提标清楚。
    // catalog 把前提存成 i18n key（renderer 端 t() 翻译），这里验 key 命名
    // 语义自带"paygo / subscription"区分，避免上线时两条混淆。
    expect(providerSubscriptionNote('moonshot')).toBe('provider.moonshot.note_paygo');
    expect(providerSubscriptionNote('kimi-coding')).toBe('provider.kimi_coding.note_subscription');
  });

  it('providerSubscriptionNote 对没前提要求的 provider 返 undefined / 空串', () => {
    // anthropic / openai 没声明 subscriptionNote → undefined；
    // doubao 在 catalog 里显式写了空串占位 → 空串。两种都视为"无前提"。
    expect(providerSubscriptionNote('anthropic')).toBeUndefined();
    expect(providerSubscriptionNote('openai')).toBeUndefined();
    expect(providerSubscriptionNote('totally-unknown')).toBeUndefined();
    expect(providerSubscriptionNote('doubao') || undefined).toBeUndefined();
  });
});

describe('provider_catalog › EXTERNAL_API_PROVIDERS', () => {
  it('列出所有走 Orkas 自建适配层的 provider（pi-ai 不认识）', () => {
    // EXTERNAL_API_PROVIDERS 是 `listProviders` / `runner.ts::buildRunner` /
    // `auth.ts::testConnection` 的分发依据——名单必须和 CATALOG 里真实
    // 标记为"外部"的 provider 严格一致，否则会出现"能选但调用报
    // No model found for provider"。
    expect([...EXTERNAL_API_PROVIDERS]).toEqual([
      'moonshot',
      'deepseek',
      'doubao',
      'custom',
    ]);
  });

  it('每个外部 provider 都在 CATALOG + CURATED_MODELS 有对应条目', () => {
    for (const id of EXTERNAL_API_PROVIDERS) {
      const entry = CATALOG.find((p) => p.id === id);
      expect(entry).toBeTruthy();
      if (entry?.customOpenAICompatible) {
        expect(CURATED_MODELS[id]).toBeUndefined();
      } else {
        expect(CURATED_MODELS[id]?.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('provider_catalog › isVisibleProvider / sortProviderIds', () => {
  it('isVisibleProvider mirrors CATALOG membership', () => {
    expect(isVisibleProvider('anthropic')).toBe(true);
    expect(isVisibleProvider('zai')).toBe(true);
    expect(isVisibleProvider('minimax')).toBe(false); // only minimax-cn is visible
  });

  it('sortProviderIds puts CATALOG ids first in CATALOG order, orphans last alphabetically', () => {
    const input = ['minimax', 'huggingface', 'openrouter', 'anthropic', 'zai'];
    expect(sortProviderIds(input)).toEqual([
      'anthropic',
      'zai',
      'openrouter',
      'huggingface',
      'minimax',
    ]);
  });
});

describe('provider_catalog › pickLatestGenerations (fallback)', () => {
  it('keeps the last N version bands newest-first', () => {
    const raw = [
      { id: 'foo-1.0', name: 'Foo 1.0' },
      { id: 'foo-2.0', name: 'Foo 2.0' },
      { id: 'foo-2.1', name: 'Foo 2.1' },
      { id: 'foo-2.1-mini', name: 'Foo 2.1 Mini' },
      { id: 'foo-3.0', name: 'Foo 3.0' },
    ];
    const picked = pickLatestGenerations(raw, 2);
    expect(picked.map((m) => m.id)).toEqual([
      'foo-3.0',
      'foo-2.1',
      'foo-2.1-mini',
    ]);
  });

  it('drops preview / dated / :free variants', () => {
    const raw = [
      { id: 'foo-2.0' },
      { id: 'foo-2.0-preview' },
      { id: 'foo-2.0-2025-01-15' },
      { id: 'vendor/foo-2.0:free' },
    ];
    const picked = pickLatestGenerations(raw, 1);
    expect(picked.map((m) => m.id)).toEqual(['foo-2.0']);
  });

  it('returns [] on empty / invalid input', () => {
    expect(pickLatestGenerations([], 2)).toEqual([]);
    expect(pickLatestGenerations(null as any, 2)).toEqual([]);
  });
});

  it('natively resolves GPT-6 tiers and every retained GPT-5.6 tier', () => {
    const expected = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
    expect((CURATED_MODELS.openai || []).map((m) => m.id)).toEqual(expected);
    expect((CURATED_MODELS['openai-codex'] || []).map((m) => m.id)).toEqual(expected);

    for (const provider of ['openai', 'openai-codex'] as const) {
      for (const modelId of expected) {
        expect(getBuiltinModel(provider, modelId)).toBeDefined();
      }
    }

    expect(getBuiltinModel('openai', 'gpt-6-astra')).toMatchObject({
      id: 'gpt-6-astra',
      provider: 'openai',
      api: 'openai-responses',
      reasoning: true,
      input: ['text', 'image'],
      maxTokens: 128_000,
      thinkingLevelMap: { off: null, minimal: null, low: 'low', max: 'max' },
      compat: { supportsExplicitPromptCacheMode: true },
    });
    expect(getBuiltinModel('openai-codex', 'gpt-6-astra')).toMatchObject({
      id: 'gpt-6-astra',
      provider: 'openai-codex',
      api: 'openai-codex-responses',
      reasoning: true,
      input: ['text', 'image'],
      maxTokens: 128_000,
    });
    for (const id of ['gpt-6-sol', 'gpt-6-luna']) {
      expect(getBuiltinModel('openai', id)).toMatchObject({
        id, api: 'openai-responses', contextWindow: 272_000, maxTokens: 128_000,
      });
      expect(getBuiltinModel('openai-codex', id)).toMatchObject({
        id, api: 'openai-codex-responses', contextWindow: 272_000, maxTokens: 128_000,
      });
    }
  });

  it('inherits each GPT provider window from pi-ai while retaining output reservations', () => {
    const catalog = { getPiModel: getBuiltinModel as any };
    const ids = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
    for (const provider of ['openai', 'openai-codex', 'openrouter']) {
      for (const id of ids) {
        const modelId = provider === 'openrouter' ? `openai/${id}` : id;
        const sdk = (getBuiltinModel as any)(provider, modelId);
        const resolved = resolveConfiguredPiModel(catalog, provider, modelId);
        expect(resolved?.model.contextWindow, `${provider}/${id}`).toBe(sdk.contextWindow);
        expect(resolved?.model.maxTokens).toBe(
          provider === 'openrouter' ? sdk.maxTokens : id === 'gpt-6-astra' ? 128_000 : 64_000,
        );
        expect(resolved?.needsCustomModel).toBe(true);
      }
    }
  });
