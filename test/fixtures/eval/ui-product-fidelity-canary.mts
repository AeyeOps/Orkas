import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectUiProductArtifact } from '../../../eval/model-eval/regression/ui-product-fidelity.js';

// Independent accepted source translation, with JS-only workflow headings and
// equivalent minmax geometry. Labels in script text alone cannot certify it.
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Northstar</title><style>
*{box-sizing:border-box}body{margin:0;font:13px/1.45 system-ui}.app-shell{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:100vh}
.app-sidebar{background:#10273e;color:white;padding:20px 14px}.brand{color:inherit}.app-sidebar nav{display:grid}.app-sidebar nav a{min-height:32px;color:inherit}
.project-page{padding:28px 32px}.project-header,.section-heading{display:flex;justify-content:space-between}.eyebrow{color:#17837a}
.project-summary,.activity{border-radius:6px;padding:16px;border:1px solid #c9d4df;margin-top:20px}.board{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}
.task-row{display:flex;gap:8px}.icon{width:16px;height:16px;flex-shrink:0}.task-row h3{font-size:13px}.muted{color:#607487}a:focus,button:focus{outline:2px solid #17837a;outline-offset:2px}
</style></head><body><div class="app-shell"><aside class="app-sidebar"><a class="brand" href="#">Northstar</a><nav aria-label="Primary"><a href="#">Overview</a><a class="active" href="#">Projects</a><a href="#">Inbox</a><a href="#">Reports</a></nav><button class="account">AC · Alex Chen</button></aside>
<main class="project-page"><header class="project-header"><div><p class="eyebrow">Projects / Operations</p><h1>Atlas migration</h1><p class="muted">Move customer workflows to the new workspace.</p></div><button class="secondary">Share</button></header>
<section class="project-summary"><h2>Project summary</h2><dl><div><dt>Owner</dt><dd>Alex Chen</dd></div><div><dt>Due</dt><dd>Sep 18</dd></div><div><dt>Status</dt><dd>On track</dd></div></dl></section>
<section class="board" id="board"></section>
<section class="activity"><div class="section-heading"><h2>Recent activity</h2><button class="primary">Add update</button></div><p class="muted">Three updates this week</p></section></main></div>
<script>const labels=['Intake','Planned','Building','Review','Done'];
document.getElementById('board').innerHTML=labels.map(label => '<section><h3>'+label+'</h3><article class="task-row"><svg class="icon" viewBox="0 0 16 16"><path stroke="currentColor" d="M2 8h12"/></svg><div><h3>Map data</h3><p class="muted">Due Sep 12 · Alex Chen</p></div><span class="status">On track</span></article></section>').join('');</script></body></html>`;

export async function main(): Promise<number> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uid-fidelity-canary-'));
  const dir = path.join(root, 'ui-artifacts', 'northstar');
  fs.mkdirSync(dir, { recursive: true });
  const files = ['ui-artifacts/northstar/artifact.json', 'ui-artifacts/northstar/index.html'];
  const manifest = path.join(dir, 'artifact.json');
  const entry = path.join(dir, 'index.html');
  fs.writeFileSync(manifest, JSON.stringify({ entry: 'index.html' }));
  const observe = async (body: string) => {
    fs.writeFileSync(entry, body);
    const facts = await inspectUiProductArtifact(root, files);
    assert.equal(facts?.rendered, true, JSON.stringify(facts));
    return facts!;
  };
  try {
    const good = await observe(html);
    assert.equal(good.shellPreserved, true);
    assert.equal(good.workflowBetweenRegions, true);
    assert.equal(good.workflowColumnCount, 5);
    assert.equal(good.sidebarWidth, 232);
    assert.equal(good.visualSystemPreserved, true);
    assert.equal(good.taskPatternPreserved, true);
    // A stage count is supplementary content, not part of its workflow name.
    const counted = html.replace("<h3>'+label+'</h3>", '<h3>\'+label+\'<span class="count">1</span></h3>');
    assert.notEqual(counted, html);
    const countedFacts = await observe(counted);
    assert.equal(countedFacts.workflowColumnCount, 5);
    assert.equal(countedFacts.workflowBetweenRegions, true);
    assert.equal((await observe(counted.replace("'Review',", ''))).workflowColumnCount, 4);
    const divLabels = counted.replace('<h3>\'+label+\'', '<div>\'+label+\'').replace('</span></h3>', '</span></div>');
    const divFacts = await observe(divLabels);
    assert.equal(divFacts.workflowColumnCount, 5);
    assert.equal(divFacts.workflowBetweenRegions, true);
    const flexLabels = html.replace("<h3>'+label+'</h3>", '<header><strong>\'+label+\'</strong></header>')
      .replace('display:grid;grid-template-columns:repeat(5,minmax(0,1fr))', 'display:flex')
      .replace('</style>', '.board>section{flex:1}</style>');
    assert.equal((await observe(flexLabels)).workflowColumnCount, 5);
    const inlineLabels = html.replace(/<script>[\s\S]*?<\/script>/, '')
      .replace('<section class="board" id="board"></section>', '<p><span>Intake</span> <span>Planned</span> <span>Building</span> <span>Review</span> <span>Done</span></p>');
    assert.equal((await observe(inlineLabels)).workflowColumnCount, 0);
    assert.equal((await observe(html.replace('</style>', '.board{grid-template-columns:1fr}</style>'))).workflowColumnCount, 0);
    assert.equal((await observe(divLabels.replace('</style>', '#board>section:nth-child(4)>div{visibility:hidden}</style>'))).workflowColumnCount, 4);
    const countOnly = html.replace("<h3>'+label+'</h3>", '<h3><span class="count">\'+label+\'</span></h3>');
    assert.equal((await observe(countOnly)).workflowColumnCount, 0);
    const literal = html.replace(/<script>[\s\S]*?<\/script>/, '<script>const labels=["Intake","Planned","Building","Review","Done"];</script>');
    assert.equal((await observe(literal)).workflowColumnCount, 0);
    assert.equal((await observe(html.replace("'Review',", ''))).workflowColumnCount, 4);
    const hidden = await observe(html.replace('</style>', '#board>section:nth-child(4){display:none}</style>'));
    assert.equal(hidden.workflowColumnCount, 4);
    assert.equal(hidden.workflowBetweenRegions, false);
    const moved = html.replace('<section class="board" id="board"></section>', '')
      .replace('</main>', '<section class="board" id="board"></section></main>');
    assert.equal((await observe(moved)).workflowBetweenRegions, false);
    const reordered = html.replace('</style>', '.project-page{display:flex;flex-direction:column}.board{order:2}</style>');
    assert.equal((await observe(reordered)).workflowBetweenRegions, false);
    assert.equal((await observe(html.replace('232px', '280px'))).visualSystemPreserved, false);
    assert.equal((await observe(html.replaceAll('#17837a', '#12695f'))).visualSystemPreserved, false);
    assert.equal((await observe(html.replace(/<svg class="icon"[\s\S]*?<\/svg>/, ''))).taskPatternPreserved, false);
    assert.equal((await observe(html.replace('AC · Alex Chen', 'New account'))).shellPreserved, false);
    // Package boundary failures must never execute an outside entry.
    for (const unsafe of ['../index.html', '/tmp/index.html', 'nested\\index.html']) {
      fs.writeFileSync(manifest, JSON.stringify({ entry: unsafe }));
      assert.equal(await inspectUiProductArtifact(root, files), undefined);
    }
    fs.writeFileSync(manifest, JSON.stringify({ entry: 'index.html' }));
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    const siblingFiles = files.map(file => `../${file}`);
    assert.equal(await inspectUiProductArtifact(project, siblingFiles), undefined);
    assert.equal((await inspectUiProductArtifact(project, siblingFiles, root))?.rendered, true);
    assert.equal(await inspectUiProductArtifact(project, siblingFiles, project), undefined);
    assert.equal(await inspectUiProductArtifact(root, [files[0]]), undefined);
    assert.equal(await inspectUiProductArtifact(root, [...files, files[0]]), undefined);
    const outside = path.join(root, 'outside.html');
    fs.writeFileSync(outside, html); fs.unlinkSync(entry); fs.symlinkSync(outside, entry);
    assert.equal(await inspectUiProductArtifact(root, files), undefined);
    console.info('ui-product-fidelity-canary=passed rendered-cases=19 boundary-controls=8');
    return 0;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
