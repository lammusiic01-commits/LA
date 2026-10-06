'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const packageJson = require('../package.json');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/windows.yml'), 'utf8');
const installerScript = fs.readFileSync(path.join(root, 'scripts/localis-installer.iss'), 'utf8');
const packageScript = fs.readFileSync(path.join(root, 'scripts/package-windows.ps1'), 'utf8');
const prepareScript = fs.readFileSync(path.join(root, 'scripts/prepare-windows-engine.ps1'), 'utf8');

test('Windows distribution stages LamV1.0 assets before creating one self-contained installer', () => {
  assert.match(packageJson.scripts['dist:win'], /prepare:engine:win/);
  assert.match(packageJson.scripts['dist:win'], /package:win:app/);
  assert.match(packageJson.scripts['dist:win'], /package-windows\.ps1/);
  assert.ok(packageJson.build.extraResources.some((resource) => resource.from === 'release-assets' && resource.to === 'localis-bundle'));
  assert.match(packageJson.build.win.target[0].target, /^dir$/);
  assert.match(installerScript, /Compression=lzma2\/fast/);
  assert.match(installerScript, /DiskSpanning=no/);
  assert.match(installerScript, /AppId=ai\.localis\.desktop/);
  assert.match(packageScript, /Installed LamV1\.0 model SHA-256/);
  assert.match(packageScript, /\$installerSha256 = Get-Sha256Hex \$output/);
  assert.match(packageScript, /WriteAllText\(\$checksumPath/);
  assert.match(workflow, /release\/Localis-Setup-\*\.exe\.sha256/);
  assert.match(prepareScript, /modelSha256/);
  assert.match(prepareScript, /localis-engine\.exe/);
});

test('Windows CI installs a pinned Inno Setup compiler with a verified digest', () => {
  assert.match(workflow, /innosetup-6\.7\.3\.exe/);
  assert.match(workflow, /9c73c3bae7ed48d44112a0f48e66742c00090bdb5bef71d9d3c056c66e97b732/);
  assert.match(workflow, /ISCC_PATH=/);
  assert.match(packageScript, /6\.6\.0/);
});
