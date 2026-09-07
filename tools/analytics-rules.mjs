#!/usr/bin/env node
// Safely review/deploy the additive Baser analytics rules using firebase login.
// Never reads Firestore documents. Refuses to replace unrelated live rules.
// The only other permitted change adds three existing app block types.
// node tools/analytics-rules.mjs check
// node tools/analytics-rules.mjs deploy
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const project = 'maxmendelson-com-dental-school';
const rulesPath = fileURLToPath(new URL('../firestore.rules', import.meta.url));
const marker = /\n    \/\/ BEGIN BASER ANALYTICS[^\n]*\n[\s\S]*?    \/\/ END BASER ANALYTICS\n/g;
const local = fs.readFileSync(rulesPath, 'utf8');
const command = process.argv[2] || 'check';
if (!['check', 'deploy'].includes(command)) throw new Error('Usage: node tools/analytics-rules.mjs check|deploy');

function withoutAnalytics(content) {
  const matches = [...content.matchAll(marker)];
  if (matches.length > 1) throw new Error('Multiple analytics rule sections found; review manually.');
  // Editors may add a final newline; it has no effect on rule semantics.
  return content.replace(/\n$/, '').replace(marker, '').replace(/function validType\(t\) \{\s*return t in \[[^\]]+\];\s*\}/, (rule) =>
    rule.replace(/,'(?:Perio|Clerkship|Shady Grove)'/g, ''));
}
function firebaseToolsRoot() {
  if (process.env.FIREBASE_TOOLS_PATH) return process.env.FIREBASE_TOOLS_PATH;
  const result = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
  if (result.status === 0) return path.join(result.stdout.trim(), 'firebase-tools');
  throw new Error('Install the Firebase CLI or set FIREBASE_TOOLS_PATH to its package directory.');
}
async function run() {
  if (![...local.matchAll(marker)].length) throw new Error('Local analytics section missing.');
  const localTypeRule = local.match(/function validType\(t\) \{\s*return t in \[[^\]]+\];\s*\}/)?.[0] || '';
  if (!['Perio', 'Clerkship', 'Shady Grove'].every(type => localTypeRule.includes(`'${type}'`))) {
    throw new Error('Local rules must retain all three existing app block-type additions.');
  }
  // Tokens remain in memory and are never printed or written by this tool.
  const require = createRequire(import.meta.url);
  const auth = require(path.join(firebaseToolsRoot(), 'lib/auth.js'));
  const account = auth.getGlobalDefaultAccount();
  if (!account) throw new Error('Run firebase login first.');
  const credentials = await auth.getAccessToken(account.tokens.refresh_token, ['https://www.googleapis.com/auth/cloud-platform']);
  async function api(url, method = 'GET', body) {
    const response = await fetch(url, { method, headers: { Authorization: `Bearer ${credentials.access_token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`${method} ${new URL(url).pathname}: HTTP ${response.status}. No credentials or response payload were logged.`);
    return response.json();
  }
  const origin = 'https://firebaserules.googleapis.com/v1';
  const releaseURL = `${origin}/projects/${project}/releases/cloud.firestore`;
  const release = await api(releaseURL);
  const ruleset = await api(`${origin}/${release.rulesetName}`);
  const files = ruleset.source?.files;
  if (files?.length !== 1 || typeof files[0].content !== 'string') throw new Error('Unexpected live rules structure; review manually.');
  if (withoutAnalytics(files[0].content) !== withoutAnalytics(local)) {
    throw new Error('Unrelated live rules differ from firestore.rules. Fetch and reconcile them before deploying; nothing was changed.');
  }
  console.log(`Project: ${project}`);
  console.log('Verified: existing live rules are preserved except the three allowlisted block-type additions.');
  console.log(`Current ruleset: ${release.rulesetName}`);
  if (files[0].content === local) { console.log('The analytics rules are already deployed.'); return; }
  if (command === 'check') { console.log('Additive analytics update is ready. Run emulator tests, then deploy.'); return; }
  // Creating a ruleset compiles it but does not activate it.
  const next = await api(`${origin}/projects/${project}/rulesets`, 'POST', { source: { files: [{ name: files[0].name, content: local }] } });
  const latest = await api(releaseURL);
  if (latest.rulesetName !== release.rulesetName) throw new Error('The live release changed during validation; refusing to overwrite it. The compiled ruleset was not activated.');
  await api(`${releaseURL}?updateMask=rulesetName`, 'PATCH', { release: { name: release.name, rulesetName: next.name } });
  const verified = await api(releaseURL);
  if (verified.rulesetName !== next.name) throw new Error('Release verification did not match; inspect Firebase before retrying.');
  console.log(`Deployed and verified: ${next.name}`);
  console.log(`Previous ruleset (rollback reference): ${release.rulesetName}`);
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
