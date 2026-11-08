import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const workflow = readFileSync(
  fileURLToPath(new URL('../../../.github/workflows/release-tauri.yml', import.meta.url)),
  'utf8',
);
const windowsBuild = workflow.match(/- name: Build \(Windows\)[\s\S]*?(?=      - name: Disambiguate macOS updater bundle filename)/)?.[0];
assert.ok(windowsBuild, 'Windows release build step should exist');
assert.match(windowsBuild, /--bundles nsis/);
assert.doesNotMatch(workflow, /Build Windows IME native DLLs|Repair Windows MSI|windows-ime-install-smoke|--bundles msi/i);
assert.doesNotMatch(windowsBuild, /OPENLESS_IME_DLL|OpenLessIme\.dll|regsvr32/i);

console.log('Windows release contract: NSIS build does not ship/register the in-process TSF module');
