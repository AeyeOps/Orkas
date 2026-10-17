import { describe, expect, it } from 'vitest';
import { CLI_TASK_HELP_ARGS, adaptCliRuntimeOverrides, codexNativeModelMinimum, unsupportedCliOverride } from '../../../../src/main/features/local_agents/compatibility';
import { MIN_VERSIONS, cliVersionAtLeast } from '../../../../src/main/features/local_agents/version';

describe('external CLI compatibility contracts', () => {
  it.each([
    ['0.145.0', 'gpt-6-sol', '0.156.1'], ['0.156.0', 'gpt-6-luna', '0.156.1'],
    ['0.156.1', 'gpt-6-sol', null], ['0.156.1', 'gpt-6.1-sol', '0.159.1'],
    ['0.159.0', 'gpt-6.1-sol', '0.159.1'], ['0.159.1-alpha.1', 'gpt-6.1-sol', '0.159.1'],
    ['0.159.1', 'gpt-6.1-sol', null], ['0.159.3', 'gpt-6.1-sol', null],
    ['0.156.1', 'custom/gpt-6.1-sol', null], ['0.156.1', 'gpt-6.1-sol-custom', null],
    ['0.156.1', 'constructor', null], ['0.156.1', '__proto__', null],
  ])('keeps the optional catalog boundary separate: %s / %s', (version, model, expected) => {
    expect(codexNativeModelMinimum(model, version)).toBe(expected);
    expect(MIN_VERSIONS.codex).toBe('0.145.0');
  });
  it.each([
    ['claude', '--effort'], ['opencode', '--variant'], ['openclaw', '--thinking'],
  ] as const)('uses the actual %s command capability, including backports', (cli, effort) => {
    expect(unsupportedCliOverride(cli, {})).toBeNull();
    expect(unsupportedCliOverride(cli, { thinkingLevel: 'high', cliFlags: [] })).toBeNull();
    expect(adaptCliRuntimeOverrides(cli, { modelOverride: 'selected', thinkingLevel: 'high', cliFlags: [] }))
      .toEqual({ modelOverride: 'selected', thinkingLevel: undefined });
    expect(adaptCliRuntimeOverrides(cli, { thinkingLevel: 'high', cliFlags: [effort] }).thinkingLevel).toBe('high');
    expect(unsupportedCliOverride(cli, { thinkingLevel: 'high', cliFlags: [effort] })).toBeNull();
    expect(unsupportedCliOverride(cli, { modelOverride: 'selected', cliFlags: [] })).toBe('--model');
    expect(unsupportedCliOverride(cli, { modelOverride: 'selected', cliFlags: ['--model'] })).toBeNull();
  });
  it('discovers flags from their owning task subcommand', () => {
    expect(CLI_TASK_HELP_ARGS).toEqual({ claude: ['--help'], opencode: ['run', '--help'], openclaw: ['agent', '--help'] });
    expect(cliVersionAtLeast('2.1.81-alpha.1', '2.1.81')).toBe(false);
    expect(cliVersionAtLeast('2.1.81+vendor.1', '2.1.81')).toBe(true);
  });
});
