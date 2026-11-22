'use strict';

// Semver-style version handling without a library. Supports an optional
// leading "v", dotted numeric segments of any length, prerelease identifiers
// after "-", and ignores build metadata after "+".

function parseVersion(raw) {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (/^[vV]/.test(text)) text = text.slice(1);
  const plus = text.indexOf('+');
  if (plus !== -1) text = text.slice(0, plus);
  const dash = text.indexOf('-');
  const mainText = dash === -1 ? text : text.slice(0, dash);
  const preText = dash === -1 ? '' : text.slice(dash + 1);
  if (!/^\d+(\.\d+)*$/.test(mainText)) return null;
  const main = mainText.split('.').map(Number);
  let pre = [];
  if (preText !== '') {
    if (!/^[0-9A-Za-z.-]+$/.test(preText) || preText.split('.').some((part) => part === '')) return null;
    pre = preText.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  }
  return { main, pre };
}

function compareIdentifiers(a, b) {
  const aNum = typeof a === 'number';
  const bNum = typeof b === 'number';
  if (aNum && bNum) return a === b ? 0 : (a < b ? -1 : 1);
  if (aNum) return -1; // numeric identifiers sort before alphanumeric
  if (bNum) return 1;
  return a === b ? 0 : (a < b ? -1 : 1);
}

// Returns -1, 0, or 1. Throws on unparseable versions.
function compareVersions(rawA, rawB) {
  const a = parseVersion(rawA);
  const b = parseVersion(rawB);
  if (!a || !b) throw new Error(`Cannot compare versions "${rawA}" and "${rawB}"`);
  const mainLength = Math.max(a.main.length, b.main.length);
  for (let i = 0; i < mainLength; i++) {
    const left = a.main[i] || 0;
    const right = b.main[i] || 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1; // release > prerelease
  if (b.pre.length === 0) return -1;
  const preLength = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < preLength; i++) {
    if (i >= a.pre.length) return -1; // shorter prerelease sorts first
    if (i >= b.pre.length) return 1;
    const result = compareIdentifiers(a.pre[i], b.pre[i]);
    if (result !== 0) return result;
  }
  return 0;
}

function isNewerVersion(candidate, installed) {
  return compareVersions(candidate, installed) > 0;
}

module.exports = { parseVersion, compareVersions, isNewerVersion };
