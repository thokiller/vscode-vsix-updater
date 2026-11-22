'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vsix-updater-extension-'));
  try {
    // Each VS Code version gets its own profile and extensions dir so one
    // run's installed extensions and state cannot leak into the other.
    for (const version of ['1.90.2', 'stable']) {
      const extensionsDir = path.join(root, version, 'extensions');
      await fs.mkdir(extensionsDir, { recursive: true });
      await runTests({
        version,
        vscodeExecutablePath: version === 'stable' ? process.env.VSCODE_EXECUTABLE_PATH : undefined,
        extensionDevelopmentPath: path.resolve(__dirname, '..'),
        extensionTestsPath: path.join(__dirname, 'extensionHostTests.js'),
        launchArgs: [
          '--disable-extensions', '--disable-workspace-trust',
          '--user-data-dir', path.join(root, version, 'profile'),
          '--extensions-dir', extensionsDir,
          '--skip-welcome', '--skip-release-notes'
        ],
        extensionTestsEnv: {
          VSIX_UPDATER_TEST: '1',
          VSIX_UPDATER_STARTUP_DELAY_MS: '600000',
          VSIX_UPDATER_TEST_EXTENSIONS_DIR: extensionsDir
        }
      });
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
