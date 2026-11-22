'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { selectVsixAsset, checkSource, parseRepositoryField } = require('../lib/updater');
const { GitHubClient } = require('../lib/github');
const { startFakeGitHub } = require('./fixtures');

test('selects the only vsix asset and ignores other assets', () => {
  const assets = [
    { name: 'checksums.txt' },
    { name: 'ext-1.0.0.vsix' }
  ];
  assert.strictEqual(selectVsixAsset(assets, '').asset.name, 'ext-1.0.0.vsix');
});

test('multiple vsix assets require an explicit configured name', () => {
  const assets = [{ name: 'a.vsix' }, { name: 'b.vsix' }];
  assert.match(selectVsixAsset(assets, '').error, /multiple \.vsix assets/);
  assert.strictEqual(selectVsixAsset(assets, 'b.vsix').asset.name, 'b.vsix');
  assert.match(selectVsixAsset(assets, 'c.vsix').error, /no asset named/);
  assert.match(selectVsixAsset([], '').error, /no \.vsix asset/);
});

test('parseRepositoryField accepts string and object forms', () => {
  assert.strictEqual(parseRepositoryField('https://github.com/o/r'), 'o/r');
  assert.strictEqual(parseRepositoryField({ type: 'git', url: 'https://github.com/o/r.git' }), 'o/r');
  assert.strictEqual(parseRepositoryField('git@github.com:o/r.git'), 'o/r');
  assert.strictEqual(parseRepositoryField(undefined), null);
  assert.strictEqual(parseRepositoryField('https://example.com/o/r'), null);
});

test('checkSource decides install, update, and up-to-date from package.json version', async () => {
  const fake = await startFakeGitHub();
  try {
    fake.served.repos.set('owner/repo', {
      // Tag and package.json version deliberately disagree: package.json wins.
      tagName: 'v9.9.9',
      packageJson: { publisher: 'pub', name: 'ext', version: '1.2.0', displayName: 'Ext' },
      assets: [{ name: 'ext.vsix', vsix: Buffer.from('x') }]
    });
    const client = new GitHubClient({ apiBase: fake.baseUrl });
    const source = { repo: 'owner/repo', asset: '' };

    const notInstalled = await checkSource(client, source, { getInstalledVersion: () => undefined });
    assert.strictEqual(notInstalled.status, 'install');
    assert.strictEqual(notInstalled.update.id, 'pub.ext');
    assert.strictEqual(notInstalled.update.availableVersion, '1.2.0');
    assert.strictEqual(notInstalled.update.tagName, 'v9.9.9');

    const older = await checkSource(client, source, { getInstalledVersion: () => '1.0.0' });
    assert.strictEqual(older.status, 'update');
    assert.strictEqual(older.update.installedVersion, '1.0.0');

    const current = await checkSource(client, source, { getInstalledVersion: () => '1.2.0' });
    assert.strictEqual(current.status, 'up-to-date');

    const newerLocal = await checkSource(client, source, { getInstalledVersion: () => '2.0.0' });
    assert.strictEqual(newerLocal.status, 'up-to-date');
  } finally {
    await fake.close();
  }
});

test('checkSource reports errors instead of throwing', async () => {
  const fake = await startFakeGitHub();
  try {
    const client = new GitHubClient({ apiBase: fake.baseUrl });
    const missing = await checkSource(client, { repo: 'missing/repo', asset: '' }, { getInstalledVersion: () => undefined });
    assert.strictEqual(missing.status, 'error');
    assert.match(missing.error, /not found|no releases|private/);

    fake.served.repos.set('bad/manifest', {
      tagName: 'v1.0.0',
      packageJson: { name: 'only-a-name' },
      assets: [{ name: 'a.vsix', vsix: Buffer.from('x') }]
    });
    const badManifest = await checkSource(client, { repo: 'bad/manifest', asset: '' }, { getInstalledVersion: () => undefined });
    assert.strictEqual(badManifest.status, 'error');
    assert.match(badManifest.error, /missing publisher, name, or version/);

    fake.served.repos.set('no/asset', {
      tagName: 'v1.0.0',
      packageJson: { publisher: 'p', name: 'n', version: '1.0.0' },
      assets: []
    });
    const noAsset = await checkSource(client, { repo: 'no/asset', asset: '' }, { getInstalledVersion: () => undefined });
    assert.strictEqual(noAsset.status, 'error');
    assert.match(noAsset.error, /no \.vsix asset/);

    fake.served.repos.set('bad/version', {
      tagName: 'v1.0.0',
      packageJson: { publisher: 'p', name: 'n', version: 'one-point-oh' },
      assets: [{ name: 'a.vsix', vsix: Buffer.from('x') }]
    });
    const badVersion = await checkSource(client, { repo: 'bad/version', asset: '' }, { getInstalledVersion: () => '1.0.0' });
    assert.strictEqual(badVersion.status, 'error');
    assert.match(badVersion.error, /Cannot compare versions/);

    const offline = new GitHubClient({ apiBase: 'http://127.0.0.1:9' });
    const unreachable = await checkSource(offline, { repo: 'o/r', asset: '' }, { getInstalledVersion: () => undefined });
    assert.strictEqual(unreachable.status, 'error');
  } finally {
    await fake.close();
  }
});
