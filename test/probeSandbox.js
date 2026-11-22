'use strict';

// Manual end-to-end probe (not part of CI): installs the locally built
// vsix-updater VSIX into a sandboxed VS Code (fresh profile and extensions
// directory), then drives it against the real GitHub API to install a real
// extension release. Run with: npm run test:sandbox
//
// Optionally set SANDBOX_SOURCE_REPO / SANDBOX_EXPECT_ID to probe another
// repository (defaults: thokiller/vcs-renpy-image-helper, local.renpy-image-preview).

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { runTests, downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } = require('@vscode/test-electron');

const SOURCE_REPO = process.env.SANDBOX_SOURCE_REPO || 'thokiller/vcs-renpy-image-helper';
const EXPECT_ID = process.env.SANDBOX_EXPECT_ID || 'local.renpy-image-preview';

const DRIVER_TESTS = `'use strict';
const assert = require('node:assert');
const fs = require('node:fs/promises');
const vscode = require('vscode');

async function run() {
  const updater = vscode.extensions.getExtension('local.vsix-updater');
  assert.ok(updater, 'vsix-updater is not installed in the sandbox');
  console.log('[probe] vsix-updater ' + updater.packageJSON.version + ' is installed from the VSIX');
  const api = await updater.activate();
  assert.ok(api && api._test, 'test API not exposed');
  const testApi = api._test;

  await fs.writeFile(testApi.getConfigPath(), JSON.stringify({
    sources: [process.env.SANDBOX_SOURCE_REPO],
    token: '',
    checkOnStartup: false,
    periodicCheckHours: 0
  }, null, 2));

  const prompts = [];
  testApi.setNotifier(async (message, buttons) => {
    prompts.push({ message, buttons });
    console.log('[probe] notification: ' + message + ' [' + buttons.join(', ') + ']');
    if (buttons.includes('Install') || buttons.includes('Update')) {
      return buttons.includes('Install') ? 'Install' : 'Update';
    }
    return undefined; // dismiss the reload prompt
  });

  console.log('[probe] checking ' + process.env.SANDBOX_SOURCE_REPO + ' against the real GitHub API...');
  await testApi.runCheck({ manual: true });

  assert.ok(prompts.some((prompt) => prompt.buttons.includes('Install') || prompt.buttons.includes('Update')),
    'expected an install/update notification for ' + process.env.SANDBOX_SOURCE_REPO);
  assert.ok(prompts.some((prompt) => prompt.buttons.includes('Reload Window')),
    'expected a reload prompt after a successful install');

  const expectedId = process.env.SANDBOX_EXPECT_ID.toLowerCase();
  const entries = await fs.readdir(process.env.SANDBOX_EXTENSIONS_DIR);
  const installed = entries.find((entry) => entry.toLowerCase().startsWith(expectedId + '-'));
  assert.ok(installed, 'expected ' + expectedId + ' in the sandbox extensions dir, found: ' + entries.join(', '));
  console.log('[probe] SUCCESS: installed ' + installed + ' from the real GitHub release');
}

module.exports = { run };
`;

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const packageJson = require(path.join(projectRoot, 'package.json'));
  const vsixPath = path.join(projectRoot, `${packageJson.name}-${packageJson.version}.vsix`);
  await fs.access(vsixPath).catch(() => {
    throw new Error(`${vsixPath} not found. Run "npm run package" first.`);
  });

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vsix-updater-sandbox-'));
  try {
    const extensionsDir = path.join(root, 'extensions');
    const userDataDir = path.join(root, 'profile');
    await fs.mkdir(extensionsDir, { recursive: true });

    console.log('[probe] resolving VS Code (stable)...');
    const executable = await downloadAndUnzipVSCode('stable');
    const [cliPath, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(executable);

    console.log(`[probe] installing ${path.basename(vsixPath)} into the sandbox via the VS Code CLI...`);
    const install = spawnSync(cliPath, [
      ...cliArgs,
      '--install-extension', vsixPath,
      '--extensions-dir', extensionsDir,
      '--user-data-dir', userDataDir
    ], { encoding: 'utf8', shell: process.platform === 'win32' });
    process.stdout.write(install.stdout || '');
    process.stderr.write(install.stderr || '');
    if (install.status !== 0) throw new Error(`VS Code CLI install failed with exit code ${install.status}`);

    // A minimal driver extension hosts the test module; the updater itself
    // runs as a normally installed extension, exactly like on a friend's machine.
    const driverDir = path.join(root, 'driver');
    await fs.mkdir(driverDir, { recursive: true });
    await fs.writeFile(path.join(driverDir, 'package.json'), JSON.stringify({
      name: 'sandbox-driver',
      publisher: 'local',
      version: '0.0.1',
      engines: { vscode: '^1.90.0' }
    }, null, 2));
    await fs.writeFile(path.join(driverDir, 'driverTests.js'), DRIVER_TESTS);

    await runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: driverDir,
      extensionTestsPath: path.join(driverDir, 'driverTests.js'),
      launchArgs: [
        '--disable-workspace-trust',
        '--user-data-dir', userDataDir,
        '--extensions-dir', extensionsDir,
        '--skip-welcome', '--skip-release-notes'
      ],
      extensionTestsEnv: {
        VSIX_UPDATER_TEST: '1',
        VSIX_UPDATER_STARTUP_DELAY_MS: '600000',
        SANDBOX_EXTENSIONS_DIR: extensionsDir,
        SANDBOX_SOURCE_REPO: SOURCE_REPO,
        SANDBOX_EXPECT_ID: EXPECT_ID
      }
    });
    console.log('[probe] sandbox probe passed.');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
