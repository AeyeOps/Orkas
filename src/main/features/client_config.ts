import { DEFAULT_RETRY_ERROR_POLICY, type RetryErrorPolicyConfig } from '../../core-agent/src/shared/errors';
import { PUBLIC_PROVIDER_MODELS, type ProviderModelEntry } from '../model/public_model_catalog';

export type { RetryErrorPolicyConfig } from '../../core-agent/src/shared/errors';
export type { ProviderModelEntry } from '../model/public_model_catalog';

export interface ImageGenCapability {
  model: string;
  api: 'openai' | 'gemini' | 'doubao';
  supportsEdit: boolean;
}

export interface ImageGenCapabilityOverride {
  model?: string;
  api?: 'openai' | 'gemini' | 'doubao';
  supportsEdit?: boolean;
}

export type ConnectorSwitchState = 'enabled' | 'disabled' | 'visible_disabled';

export interface GoogleConnectorsConfig {
  google: ConnectorSwitchState;
  gmail: ConnectorSwitchState;
}

export type QuickStartScenarioId =
  | 'data'
  | 'office'
  | 'ppt'
  | 'creation'
  | 'ecommerce'
  | 'video'
  | 'image'
  | 'ui_design'
  | 'rnd'
  | 'seo_geo';

export interface QuickStartConfigEntry {
  id: QuickStartScenarioId;
  agent_id: string;
}

export type QuickStartConfigSource = 'pc_default';

export interface QuickStartConfigState {
  items: QuickStartConfigEntry[];
  source: QuickStartConfigSource;
}

function cloneRetryErrorPolicyConfig(config: RetryErrorPolicyConfig): RetryErrorPolicyConfig {
  return {
    permanent_statuses: [...config.permanent_statuses],
    permanent_message_patterns: [...config.permanent_message_patterns],
    permanent_code_patterns: [...config.permanent_code_patterns],
  };
}

export const DEFAULT_PROVIDER_MODELS = PUBLIC_PROVIDER_MODELS;

export const DEFAULT_IMAGE_GEN_BY_PROVIDER: Readonly<Record<string, ImageGenCapability>> = {
  openai: { model: 'gpt-image-2', api: 'openai', supportsEdit: true },
  google: { model: 'gemini-nano-banana-2.1', api: 'gemini', supportsEdit: true },
  doubao: { model: 'doubao-seedream-5-0-lite-260128', api: 'doubao', supportsEdit: true },
};

export const DEFAULT_QUICK_START_CONFIG: ReadonlyArray<QuickStartConfigEntry> = [
  { id: 'data', agent_id: '78900d8758bc' },
  { id: 'ecommerce', agent_id: '5a1d43c2f28a' },
  { id: 'ppt', agent_id: '7e91cb9ec9e9' },
  { id: 'office', agent_id: 'a19101ba698a' },
  { id: 'image', agent_id: '814b61b027f0' },
  { id: 'video', agent_id: '79df9cc89f5f' },
  { id: 'ui_design', agent_id: 'bcfcb4921dce' },
  { id: 'rnd', agent_id: 'a316881746f9' },
  { id: 'seo_geo', agent_id: 'e064dca9e1bd' },
];

export function getConfiguredProviderModels(providerId: string): { models: ProviderModelEntry[] } | null {
  const models = DEFAULT_PROVIDER_MODELS[providerId];
  return models ? { models: models.map(model => ({ ...model })) } : null;
}

export function getConfiguredImageGenCapability(providerId: string): ImageGenCapabilityOverride | null {
  const capability = DEFAULT_IMAGE_GEN_BY_PROVIDER[providerId];
  return capability ? { ...capability } : null;
}

export function getGoogleConnectorsConfig(): GoogleConnectorsConfig {
  return { google: 'disabled', gmail: 'disabled' };
}

export function isDeepSeekModelConfigEnabled(): boolean {
  return true;
}

export function getMinimumAppVersion(): string {
  return '';
}

export function getQuickStartConfig(): QuickStartConfigEntry[] {
  return getQuickStartConfigState().items;
}

export function getQuickStartConfigState(): QuickStartConfigState {
  return {
    items: DEFAULT_QUICK_START_CONFIG.map(entry => ({ ...entry })),
    source: 'pc_default',
  };
}

export function getRetryErrorPolicyConfig(): RetryErrorPolicyConfig {
  return cloneRetryErrorPolicyConfig(DEFAULT_RETRY_ERROR_POLICY);
}
