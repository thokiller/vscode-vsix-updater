'use strict';

// Pure bookkeeping for "Skip This Version" and "Remind Me Tomorrow".
// State shapes (persisted in the extension's globalState):
//   skips:     { "<owner/repo>": ["<version>", ...] }
//   reminders: { "<owner/repo>": { version: "<version>", remindAfter: <epoch ms> } }
// Repo keys are stored lowercase so lookups are case-insensitive.

function repoKey(repo) {
  return String(repo).toLowerCase();
}

function isSkipped(skips, repo, version) {
  const list = (skips || {})[repoKey(repo)];
  return Array.isArray(list) && list.includes(version);
}

function addSkip(skips, repo, version) {
  const next = { ...(skips || {}) };
  const key = repoKey(repo);
  const list = Array.isArray(next[key]) ? next[key] : [];
  if (!list.includes(version)) next[key] = [...list, version];
  return next;
}

// Start of the next local calendar day.
function nextLocalMidnight(now) {
  const date = new Date(now);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}

function setReminder(reminders, repo, version, now) {
  return { ...(reminders || {}), [repoKey(repo)]: { version, remindAfter: nextLocalMidnight(now) } };
}

function clearReminder(reminders, repo) {
  const next = { ...(reminders || {}) };
  delete next[repoKey(repo)];
  return next;
}

// A reminder defers automatic prompts for that version until it is due.
function isDeferred(reminders, repo, version, now) {
  const entry = (reminders || {})[repoKey(repo)];
  return Boolean(entry && entry.version === version && now < entry.remindAfter);
}

// Repos whose reminders are due; callers revalidate availability before prompting.
function getDueReminders(reminders, now) {
  return Object.entries(reminders || {})
    .filter(([, entry]) => entry && now >= entry.remindAfter)
    .map(([repo, entry]) => ({ repo, version: entry.version }));
}

module.exports = { isSkipped, addSkip, nextLocalMidnight, setReminder, clearReminder, isDeferred, getDueReminders };
