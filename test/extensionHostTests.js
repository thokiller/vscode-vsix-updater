'use strict';

const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { makeVsix, startFakeGitHub } = require('./fixtures');

const SELF_ID = 'local.vsix-updater';
const DUMMY_REPO = 'tester/dummy-ext';
const DUMMY_ID = 'local.dummy-ext';

function serveDummy(fake, version) {
  fake.served.repos.set(DUMMY_REPO, {
    tagName: `v${version}`,
    packageJson: { publisher: 'local', name: 'dummy-ext', version, displayName: 'Dummy Extension' },
    assets: [{ name: `dummy-ext-${version}.vsix`, vsix: makeVsix({ version }) }]
  });
}

async function dummyInstalled() {
  if (vscode.extensions.getExtension(DUMMY_ID)) return true;
  const entries = await fs.readdir(process.env.VSIX_UPDATER_TEST_EXTENSIONS_DIR).catch(() => []);
  return entries.some((entry) => entry.toLowerCase().startsWith('local.dummy-ext-'));
}

async function run() {
  const extension = vscode.extensions.getExtension(SELF_ID);
  assert.ok(extension, 'updater extension not found in the test host');
  const api = await extension.activate();
  assert.ok(api && api._test, 'test API not exposed');
  const testApi = api._test;

  const fake = await startFakeGitHub();
  try {
    process.env.VSIX_UPDATER_API_BASE = fake.baseUrl;
    await testApi.clearState();

    // The self repo is served as up to date so self-checks succeed quietly.
    const selfVersion = extension.packageJSON.version;
    fake.served.repos.set('thokiller/vscode-vsix-updater', {
      tagName: `v${selfVersion}`,
      packageJson: { publisher: 'local', name: 'vsix-updater', version: selfVersion, displayName: 'VSIX Updater' },
      assets: [{ name: 'vsix-updater.vsix', vsix: makeVsix({ name: 'vsix-updater', version: selfVersion }) }]
    });
    serveDummy(fake, '1.0.0');

    await fs.writeFile(testApi.getConfigPath(), JSON.stringify({
      sources: [DUMMY_REPO],
      token: '',
      checkOnStartup: false,
      periodicCheckHours: 0
    }, null, 2));

    const prompts = [];
    let answer = () => undefined;
    testApi.setNotifier(async (message, buttons) => {
      prompts.push({ message, buttons });
      console.log(`[itest] notification: ${message} [${buttons.join(', ')}]`);
      return answer(message, buttons);
    });
    const promptSummary = () => JSON.stringify(prompts.map((prompt) => prompt.message));

    // Scenario A: missing extension is offered and installed on approval.
    answer = (message, buttons) => (buttons.includes('Install') ? 'Install' : undefined);
    await testApi.runCheck({ manual: true });
    const installPrompt = prompts.find((prompt) => prompt.buttons.includes('Install'));
    assert.ok(installPrompt, 'expected an install notification');
    assert.match(installPrompt.message, /Dummy Extension 1\.0\.0/);
    assert.ok(prompts.some((prompt) => prompt.buttons.includes('Reload Window')), 'expected a reload prompt after install');
    assert.ok(await dummyInstalled(), 'dummy extension was not installed');

    // Scenario B: skip suppresses automatic checks but not manual ones.
    serveDummy(fake, '1.1.0');
    testApi.resetSession();
    prompts.length = 0;
    answer = (message, buttons) => (buttons.includes('Install') || buttons.includes('Update') ? 'Skip This Version' : undefined);
    await testApi.runCheck({ manual: false });
    assert.strictEqual(prompts.filter((prompt) => prompt.buttons.includes('Skip This Version')).length, 1,
      'expected exactly one offer to skip');
    assert.ok(Object.values(testApi.getState().skips).some((list) => list.includes('1.1.0')), 'skip was not persisted');

    testApi.resetSession();
    prompts.length = 0;
    answer = () => undefined;
    await testApi.runCheck({ manual: false });
    assert.strictEqual(prompts.length, 0, 'skipped version must not re-prompt automatically, got ' + promptSummary());

    prompts.length = 0;
    await testApi.runCheck({ manual: true });
    assert.strictEqual(prompts.filter((prompt) => prompt.buttons.includes('Skip This Version')).length, 1,
      'manual check must still offer the skipped version');

    // Scenario C: remind me tomorrow defers automatic prompts until due.
    serveDummy(fake, '1.2.0');
    testApi.resetSession();
    prompts.length = 0;
    answer = (message, buttons) => (buttons.includes('Remind Me Tomorrow') && !buttons.includes('Reload Window') ? 'Remind Me Tomorrow' : undefined);
    await testApi.runCheck({ manual: false });
    assert.strictEqual(prompts.length, 1, 'expected one offer before the reminder, got ' + promptSummary());
    const reminder = Object.values(testApi.getState().reminders)[0];
    assert.ok(reminder && reminder.version === '1.2.0' && reminder.remindAfter > Date.now(), 'reminder was not persisted');

    testApi.resetSession();
    prompts.length = 0;
    answer = () => undefined;
    await testApi.runCheck({ manual: false });
    assert.strictEqual(prompts.length, 0, 'reminded version must not re-prompt the same day, got ' + promptSummary());

    prompts.length = 0;
    await testApi.runCheck({ manual: true });
    assert.strictEqual(prompts.length, 1, 'manual check must still offer the deferred version, got ' + promptSummary());

    // Scenario D: an unreachable server stays quiet on background checks.
    process.env.VSIX_UPDATER_API_BASE = 'http://127.0.0.1:9';
    testApi.resetSession();
    prompts.length = 0;
    const result = await testApi.runCheck({ manual: false });
    assert.strictEqual(prompts.length, 0, 'background errors must not notify, got ' + promptSummary());
    assert.ok(result.results.every((entry) => entry.status === 'error'), 'expected all sources to fail');
  } finally {
    await fake.close();
  }
}

module.exports = { run };
