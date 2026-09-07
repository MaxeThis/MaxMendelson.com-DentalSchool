#!/usr/bin/env node
// Configure email-link admin sign-in without changing other auth providers.
// This script never creates users, sends email, or prints credentials.
// node tools/analytics-auth.mjs check|enable-email-link
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const project = 'maxmendelson-com-dental-school';
const command = process.argv[2] || 'check';
if (!['check', 'enable-email-link'].includes(command)) throw new Error('Usage: node tools/analytics-auth.mjs check|enable-email-link');
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function unrelated(config) {
  const copy = structuredClone(config);
  if (copy.signIn) delete copy.signIn.email;
  return JSON.stringify(stable(copy));
}
async function main() {
  const npm = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
  const root = process.env.FIREBASE_TOOLS_PATH || (npm.status === 0 && path.join(npm.stdout.trim(), 'firebase-tools'));
  if (!root) throw new Error('Install the Firebase CLI or set FIREBASE_TOOLS_PATH to its package directory.');
  const require = createRequire(import.meta.url);
  const auth = require(path.join(root, 'lib/auth.js'));
  const account = auth.getGlobalDefaultAccount();
  if (!account) throw new Error('Run firebase login first.');
  const credentials = await auth.getAccessToken(account.tokens.refresh_token, ['https://www.googleapis.com/auth/cloud-platform']);
  const url = `https://identitytoolkit.googleapis.com/admin/v2/projects/${project}/config`;
  async function config(method = 'GET') {
    const patch = method === 'PATCH';
    const response = await fetch(url + (patch ? '?updateMask=signIn.email' : ''), {
      method,
      headers: { Authorization: `Bearer ${credentials.access_token}`, ...(patch ? { 'Content-Type': 'application/json' } : {}) },
      ...(patch ? { body: JSON.stringify({ signIn: { email: { enabled: true, passwordRequired: false } } }) } : {}),
    });
    if (!response.ok) throw new Error(`Authentication config ${method} failed: HTTP ${response.status}. No response payload was logged.`);
    return response.json();
  }
  const before = await config();
  const enabled = data => data.signIn?.email?.enabled === true && data.signIn.email.passwordRequired !== true;
  console.log(`Project: ${project}`);
  console.log(`Anonymous sign-in enabled: ${before.signIn?.anonymous?.enabled === true}`);
  console.log(`Email-link sign-in enabled: ${enabled(before)}`);
  if (command === 'check' || enabled(before)) return;
  if (before.signIn?.anonymous?.enabled !== true) throw new Error('Expected existing anonymous sign-in is not enabled; review manually before changing providers.');
  await config('PATCH');
  const after = await config();
  if (!enabled(after)) throw new Error('Email-link sign-in enablement did not verify.');
  if (unrelated(before) !== unrelated(after)) throw new Error('Unrelated auth configuration changed during verification; inspect Firebase. No configuration payload was logged.');
  console.log('Email-link sign-in enabled and verified; all other authentication settings preserved.');
  console.log('No email was sent. The owner initiates sign-in from the admin panel.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
