/** Shared host/isolated-page URL projection; no external closure dependencies. */
export function displayBrowserUrl(raw: string): string {
  const url = new URL(raw);
  url.username = ''; url.password = '';
  const secrets = ['access_token', 'refresh_token', 'id_token', 'token', 'password', 'secret', 'api_key', 'signature', 'sig'];
  const hash = url.hash.slice(1);
  const split = hash.indexOf('?');
  const fragmentPrefix = split >= 0 ? hash.slice(0, split + 1) : '';
  const fragment = new URLSearchParams(split >= 0 ? hash.slice(split + 1) : hash);
  for (const params of [url.searchParams, fragment]) {
    let changed = false;
    const names = [];
    for (const key of params.keys()) names.push(key.toLowerCase());
    // OAuth response structure, rather than a generic business parameter name.
    const oauthCode = names.includes('state');
    for (const key of [...params.keys()]) {
      if (secrets.includes(key.toLowerCase()) || (key.toLowerCase() === 'code' && oauthCode)) {
        params.set(key, '[redacted]'); changed = true;
      }
    }
    if (params === fragment && changed) url.hash = fragmentPrefix + fragment.toString();
  }
  return url.toString();
}
