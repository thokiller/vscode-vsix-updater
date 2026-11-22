'use strict';

const test = require('node:test');
const assert = require('node:assert');
const state = require('../lib/state');

test('skip bookkeeping is per repo and version, case-insensitive repo', () => {
  let skips = {};
  skips = state.addSkip(skips, 'Owner/Repo', '1.0.0');
  assert.strictEqual(state.isSkipped(skips, 'owner/repo', '1.0.0'), true);
  assert.strictEqual(state.isSkipped(skips, 'owner/repo', '1.1.0'), false);
  assert.strictEqual(state.isSkipped(skips, 'other/repo', '1.0.0'), false);
  skips = state.addSkip(skips, 'owner/repo', '1.1.0');
  assert.strictEqual(state.isSkipped(skips, 'owner/repo', '1.0.0'), true);
  assert.strictEqual(state.isSkipped(skips, 'owner/repo', '1.1.0'), true);
});

test('nextLocalMidnight is the start of the next local day', () => {
  const now = new Date(2026, 10, 22, 10, 30, 0).getTime();
  const midnight = state.nextLocalMidnight(now);
  const date = new Date(midnight);
  assert.deepStrictEqual(
    [date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes()],
    [2026, 10, 23, 0, 0]
  );
});

test('reminders defer until due, then stop deferring', () => {
  const now = new Date(2026, 10, 22, 10, 0, 0).getTime();
  let reminders = state.setReminder({}, 'owner/repo', '1.0.0', now);
  assert.strictEqual(state.isDeferred(reminders, 'owner/repo', '1.0.0', now), true);
  assert.strictEqual(state.isDeferred(reminders, 'owner/repo', '1.0.0', now + 60 * 1000), true);
  // Not deferred for a different (newer) version.
  assert.strictEqual(state.isDeferred(reminders, 'owner/repo', '1.1.0', now), false);
  // Due the next day.
  const tomorrow = new Date(2026, 10, 23, 0, 1, 0).getTime();
  assert.strictEqual(state.isDeferred(reminders, 'owner/repo', '1.0.0', tomorrow), false);
  assert.deepStrictEqual(state.getDueReminders(reminders, tomorrow), [{ repo: 'owner/repo', version: '1.0.0' }]);
  assert.deepStrictEqual(state.getDueReminders(reminders, now), []);
  reminders = state.clearReminder(reminders, 'OWNER/REPO');
  assert.deepStrictEqual(reminders, {});
});
