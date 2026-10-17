import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'src/renderer/modules/artifact-security.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
const chatSource = fs.readFileSync(path.join(root, 'src/renderer/modules/chat-artifact.js'), 'utf8');
const savedSource = fs.readFileSync(path.join(root, 'src/renderer/modules/saved-apps.js'), 'utf8');

function loadSecurity() {
  const context: any = { URL };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'artifact-security.js' });
  return context.OrkasArtifactSecurity;
}

describe('artifact iframe security boundary', () => {
  it('round trips result JSON without allowing payload text to close its structural tag', () => {
    const context:any={window:{OrkasArtifactSecurity:loadSecurity()}};
    vm.runInNewContext(chatSource,context);
    const payload={text:'</artifact-result> unexpected <artifact-result> & "quoted"',nested:['<div>']};
    const result=context.window.encodeArtifactResult('artifact','commander','Fixture',payload);
    expect(result.match(/<\/artifact-result>/g)).toHaveLength(1);
    const body=result.match(/<artifact-result[^>]*>\n([\s\S]*)\n<\/artifact-result>/)[1];
    expect(JSON.parse(body)).toEqual(payload);
  });
  it('loads the shared boundary before eager and lazy artifact renderers use it', () => {
    expect(indexSource.indexOf('./modules/artifact-security.js')).toBeGreaterThanOrEqual(0);
    expect(indexSource.indexOf('./modules/artifact-security.js')).toBeLessThan(
      indexSource.indexOf('./modules/chat-artifact.js'),
    );
    expect(chatSource).toContain('artifactSecurity.trustedArtifactMessage');
    expect(savedSource).toContain('artifactSecurity.trustedArtifactMessage');
  });

  it('allows ordinary browser actions without top-level navigation', () => {
    const security = loadSecurity();
    expect(security.SANDBOX.split(/\s+/)).toEqual([
      'allow-scripts',
      'allow-same-origin',
      'allow-forms', 'allow-downloads', 'allow-popups', 'allow-modals',
    ]);
    expect(security.SANDBOX).not.toMatch(/allow-popups-to-escape-sandbox|allow-top-navigation/);
  });

  it('accepts only credential-free absolute HTTP(S) external URLs', () => {
    const security = loadSecurity();
    expect(security.safeExternalHttpUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(security.safeExternalHttpUrl('http://example.com')).toBe('http://example.com/');
    for (const value of [
      'javascript:alert(1)',
      'data:text/html,boom',
      'file:///etc/passwd',
      '//example.com/path',
      'https://user:password@example.com/',
      'https://example.com/\nattack',
    ]) {
      expect(security.safeExternalHttpUrl(value)).toBeNull();
    }
  });

  it('requires the marker, live iframe identity and its exact registered origin', () => {
    const security = loadSecurity();
    const liveWindow = {};
    const frame = { contentWindow: liveWindow, src:'chat-app://local/chat/app/index.html' };
    const origin = 'chat-app://local';
    const data = { __orkasArtifact: true, type: 'submit' };
    expect(security.trustedArtifactMessage({ source: liveWindow, origin, data }, frame)).toBe(true);
    expect(security.trustedArtifactMessage({ source: {}, data }, frame)).toBe(false);
    expect(security.trustedArtifactMessage({ source: liveWindow, data: { type: 'submit' } }, frame)).toBe(false);
    expect(security.trustedArtifactMessage({ source: liveWindow, data: null }, frame)).toBe(false);
    for(const foreign of ['https://example.com','chat-app://saved','chat-app://local.evil','null','',undefined])
      expect(security.trustedArtifactMessage({source:liveWindow,origin:foreign,data},frame)).toBe(false);
    expect(security.trustedArtifactMessage({source:liveWindow,origin:'https://example.com',data},{...frame,src:'https://example.com'})).toBe(false);
  });
});
