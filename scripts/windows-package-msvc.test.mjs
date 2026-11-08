import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const appRoot = join(scriptsDir, '..');
const repoRoot = join(appRoot, '..', '..');
const buildScript = readFileSync(join(scriptsDir, 'windows-package-msvc.ps1'), 'utf8');
const gnuScript = readFileSync(join(scriptsDir, 'windows-build-gnu.ps1'), 'utf8');
const workflow = readFileSync(join(repoRoot, '.github/workflows/release-tauri.yml'), 'utf8');
const config = JSON.parse(readFileSync(join(appRoot, 'src-tauri/tauri.conf.json'), 'utf8'));
const hooks = readFileSync(join(appRoot, 'src-tauri/nsis/openless-ime-hooks.nsh'), 'utf8');

assert.match(buildScript, /--bundles nsis/);
assert.doesNotMatch(buildScript, /windows-ime-build|OPENLESS_IME_DLL|--bundles msi|regsvr32/i);
assert.match(gnuScript, /--bundles nsis/);
assert.doesNotMatch(gnuScript, /windows-ime-build|OPENLESS_IME_DLL|--bundles msi/i);
assert.match(config.bundle.windows.nsis.installerHooks, /openless-ime-hooks\.nsh/);
assert.equal(config.bundle.resources?.['openless-ime-payload'], undefined);
assert.match(hooks, /Software\\Microsoft\\CTF\\TIP/);
assert.match(hooks, /Software\\Classes\\CLSID/);
assert.match(hooks, /Delete .*YanXuIme-/);
assert.doesNotMatch(hooks, /\/REBOOTOK/i);
assert.match(hooks, /NSIS_HOOK_PREINSTALL/);
assert.match(hooks, /NSIS_HOOK_PREUNINSTALL/);
assert.doesNotMatch(hooks, /regsvr32|OPENLESS_IME_DLL|File /i);
assert.match(workflow, /npm run tauri -- build --bundles nsis/);
assert.doesNotMatch(workflow, /Build Windows IME native DLLs|Repair Windows MSI|--bundles msi|InstallerKind msi/i);

console.log('Windows packaging contract: NSIS only; legacy TSF payload/registration removed');
