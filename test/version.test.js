'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseVersion, compareVersions, isNewerVersion } = require('../lib/version');

test('parses plain and v-prefixed versions', () => {
  assert.deepStrictEqual(parseVersion('1.2.3'), { main: [1, 2, 3], pre: [] });
  assert.deepStrictEqual(parseVersion('v0.0.7'), { main: [0, 0, 7], pre: [] });
  assert.deepStrictEqual(parseVersion('1.0.0-beta.2'), { main: [1, 0, 0], pre: ['beta', 2] });
  assert.strictEqual(parseVersion('not-a-version'), null);
  assert.strictEqual(parseVersion(''), null);
  assert.strictEqual(parseVersion('1..2'), null);
});

test('compares versions with unequal segment counts', () => {
  assert.strictEqual(compareVersions('1.0', '1.0.0'), 0);
  assert.strictEqual(compareVersions('1.0.1', '1.0'), 1);
  assert.strictEqual(compareVersions('v2.0.0', '10.0.0'), -1);
  assert.strictEqual(compareVersions('0.0.10', '0.0.9'), 1);
});

test('prerelease sorts before release and by identifier', () => {
  assert.strictEqual(compareVersions('1.0.0-alpha', '1.0.0'), -1);
  assert.strictEqual(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.strictEqual(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.2'), -1);
  assert.strictEqual(compareVersions('1.0.0-alpha.9', '1.0.0-alpha.10'), -1); // numeric compare
  assert.strictEqual(compareVersions('1.0.0-1', '1.0.0-alpha'), -1); // numeric before alphanumeric
  assert.strictEqual(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1); // shorter first
});

test('ignores build metadata', () => {
  assert.strictEqual(compareVersions('1.0.0+build1', '1.0.0+build2'), 0);
});

test('isNewerVersion and errors on garbage', () => {
  assert.strictEqual(isNewerVersion('v1.1.0', '1.0.9'), true);
  assert.strictEqual(isNewerVersion('1.0.0', '1.0.0'), false);
  assert.throws(() => compareVersions('abc', '1.0.0'));
});
