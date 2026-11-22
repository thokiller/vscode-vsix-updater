'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { normalizeSource } = require('../lib/sources');
const { validateConfig, loadConfig, ensureConfigFile, addSourceToFile } = require('../lib/config');

test('normalizes owner/repo inputs and github URLs', () => {
  assert.deepStrictEqual(normalizeSource('owner/repo'), { repo: 'owner/repo' });
  assert.deepStrictEqual(normalizeSource('  owner/repo.git '), { repo: 'owner/repo' });
  assert.deepStrictEqual(normalizeSource('https://github.com/owner/repo'), { repo: 'owner/repo' });
  assert.deepStrictEqual(normalizeSource('https://github.com/owner/repo.git'), { repo: 'owner/repo' });
  assert.deepStrictEqual(normalizeSource('github.com/owner/repo/releases/latest'), { repo: 'owner/repo' });
  assert.deepStrictEqual(normalizeSource('https://www.github.com/owner/repo/'), { repo: 'owner/repo' });
});

test('rejects invalid sources', () => {
  assert.ok(normalizeSource('').error);
  assert.ok(normalizeSource('just-a-name').error);
  assert.ok(normalizeSource('https://gitlab.com/owner/repo').error);
  assert.ok(normalizeSource('owner/re po').error);
  assert.ok(normalizeSource(42).error);
});

test('validateConfig applies defaults and keeps valid parts', () => {
  const { config, errors } = validateConfig({});
  assert.deepStrictEqual(config, { sources: [], token: '', checkOnStartup: true, periodicCheckHours: 0 });
  assert.deepStrictEqual(errors, []);
});

test('validateConfig normalizes sources, flags duplicates and bad entries', () => {
  const { config, errors } = validateConfig({
    sources: [
      'owner/repo',
      { repo: 'https://github.com/other/thing', asset: 'thing-windows.vsix' },
      'OWNER/REPO',
      'not valid',
      { asset: 'x.vsix' },
      7
    ]
  });
  assert.deepStrictEqual(config.sources, [
    { repo: 'owner/repo', asset: '' },
    { repo: 'other/thing', asset: 'thing-windows.vsix' }
  ]);
  assert.strictEqual(errors.length, 4);
});

test('validateConfig reports wrong types without dropping the rest', () => {
  const { config, errors } = validateConfig({
    sources: ['a/b'],
    token: 123,
    checkOnStartup: 'yes',
    periodicCheckHours: -4,
    extra: true
  });
  assert.deepStrictEqual(config.sources, [{ repo: 'a/b', asset: '' }]);
  assert.strictEqual(config.token, '');
  assert.strictEqual(config.checkOnStartup, true);
  assert.strictEqual(config.periodicCheckHours, 0);
  assert.strictEqual(errors.length, 4);
});

test('loadConfig handles missing, invalid, and valid files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vsix-updater-config-'));
  try {
    const configPath = path.join(dir, 'config.json');
    const missing = await loadConfig(configPath);
    assert.strictEqual(missing.missing, true);
    assert.deepStrictEqual(missing.errors, []);

    await fs.writeFile(configPath, '{ not json');
    const invalid = await loadConfig(configPath);
    assert.strictEqual(invalid.missing, false);
    assert.strictEqual(invalid.errors.length, 1);
    // The invalid file must be left untouched.
    assert.strictEqual(await fs.readFile(configPath, 'utf8'), '{ not json');

    await fs.writeFile(configPath, JSON.stringify({ sources: ['a/b'], token: 't', periodicCheckHours: 2 }));
    const valid = await loadConfig(configPath);
    assert.deepStrictEqual(valid.errors, []);
    assert.deepStrictEqual(valid.config, {
      sources: [{ repo: 'a/b', asset: '' }],
      token: 't',
      checkOnStartup: true,
      periodicCheckHours: 2
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('ensureConfigFile creates once and never overwrites', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vsix-updater-ensure-'));
  try {
    const configPath = path.join(dir, 'nested', 'config.json');
    assert.strictEqual(await ensureConfigFile(configPath), true);
    const template = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.deepStrictEqual(template, { sources: [], token: '', checkOnStartup: true, periodicCheckHours: 0 });
    await fs.writeFile(configPath, '{"sources":["keep/me"]}');
    assert.strictEqual(await ensureConfigFile(configPath), false);
    assert.strictEqual(await fs.readFile(configPath, 'utf8'), '{"sources":["keep/me"]}');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('addSourceToFile validates, dedupes, and preserves other settings', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vsix-updater-add-'));
  try {
    const configPath = path.join(dir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({ sources: ['a/b'], token: 'secret', periodicCheckHours: 3 }));
    const added = await addSourceToFile(configPath, 'https://github.com/c/d');
    assert.strictEqual(added.added, 'c/d');
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.deepStrictEqual(raw.sources, ['a/b', 'c/d']);
    assert.strictEqual(raw.token, 'secret');
    assert.strictEqual(raw.periodicCheckHours, 3);

    const duplicate = await addSourceToFile(configPath, 'A/B');
    assert.ok(duplicate.error.includes('already configured'));
    const bad = await addSourceToFile(configPath, 'nope');
    assert.ok(bad.error);

    await fs.writeFile(configPath, '{ broken');
    const broken = await addSourceToFile(configPath, 'x/y');
    assert.ok(broken.error.includes('not valid JSON'));
    assert.strictEqual(await fs.readFile(configPath, 'utf8'), '{ broken');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
