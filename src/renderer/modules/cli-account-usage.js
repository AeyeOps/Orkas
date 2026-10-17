// Account allowance belongs to the CLI login, shared by its agents and sessions.
// Query when rendering details or after a CLI upgrade; no background poll.
let _cliAccountUsageGeneration = 0;
const _cliAccountUsageLog = createLogger('cli-account-usage');

async function renderCliAccountUsage(agent, { force = false } = {}) {
  const generation = ++_cliAccountUsageGeneration;
  const section = document.getElementById('agents-detail-cli-usage-section');
  const slot = document.getElementById('agents-detail-cli-usage');
  if (!section || !slot) return;
  const supported = agent.runtime?.kind === 'cli' && ['codex', 'claude'].includes(agent.runtime.cli);
  section.hidden = !supported;
  slot.innerHTML = '';
  if (!supported) return;
  slot.innerHTML = `<div class="agents-detail-cli-loading">${escapeHtml(t('common.loading'))}</div>`;
  let usage;
  try {
    const response = await window.orkas.invoke('localAgents.accountUsage', { agent_id: agent.agent_id, force });
    usage = response?.usage;
  } catch (_) {
    _cliAccountUsageLog.warn('CLI account allowance request unavailable');
  }
  if (generation !== _cliAccountUsageGeneration) return;
  const date = (value) => new Date(value).toLocaleString(getLang(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const rows = usage?.status === 'ready' && Array.isArray(usage.windows) ? usage.windows : [];
  const body = rows.length ? rows.map(row => {
    const duration = row.minutes >= 1440 && row.minutes % 1440 === 0
      ? t('agents.cli_usage_days', { count: row.minutes / 1440 })
      : row.minutes > 0 ? t('agents.cli_usage_hours', { count: row.minutes / 60 }) : t('agents.cli_usage_window');
    const name = [row.label, duration].filter(Boolean).join(' · ');
    const percent = Math.max(0, Math.min(100, row.remaining_percent));
    const formatted = new Intl.NumberFormat(getLang(), { maximumFractionDigits: 1 }).format(percent);
    return `<div class="agents-detail-cli-field">
      <div class="agents-detail-cli-field-label">${escapeHtml(name)} · ${escapeHtml(formatted)}%</div>
      <progress max="100" value="${percent}" aria-label="${escapeHtml(name)}"></progress>
      ${row.resets_at ? `<div class="agents-detail-cli-note">${escapeHtml(t('agents.cli_usage_resets', { time: date(row.resets_at) }))}</div>` : ''}
    </div>`;
  }).join('') : `<div class="agents-detail-cli-note">${escapeHtml(t(usage?.status === 'unsupported' ? 'agents.cli_usage_unsupported' : 'agents.cli_usage_unavailable'))}</div>`;
  slot.innerHTML = `<div class="agents-detail-cli-settings agents-detail-cli-grid">${body}</div>`;
}
