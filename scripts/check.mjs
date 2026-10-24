// Static checks: JS syntax, JSON validity, manifest references.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const js = ['background.js', 'common/streams.js', 'content/content.js', 'content/page-hook.js', 'popup/popup.js'];
for (const f of js) execFileSync(process.execPath, ['--check', path.join(EXT, f)], { stdio: 'inherit' });

const manifest = JSON.parse(readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
for (const loc of ['en', 'ru']) {
  const m = JSON.parse(readFileSync(path.join(EXT, '_locales', loc, 'messages.json'), 'utf8'));
  if (!m.extName || !m.extDescription) throw new Error('locale ' + loc + ' missing name/description');
}
const refs = [
  ...Object.values(manifest.icons || {}),
  ...Object.values((manifest.action && manifest.action.default_icon) || {}),
  manifest.action && manifest.action.default_popup,
  manifest.background && manifest.background.service_worker,
  ...(manifest.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])]),
  ...(manifest.web_accessible_resources || []).flatMap((w) => w.resources || []),
].filter(Boolean);
for (const r of refs) if (!existsSync(path.join(EXT, r))) throw new Error('manifest references missing file: ' + r);
console.log('check: ok (' + js.length + ' scripts, ' + refs.length + ' manifest references)');
