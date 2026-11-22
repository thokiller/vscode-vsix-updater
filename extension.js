'use strict';

const vscode = require('vscode');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { CONFIG_FILE_NAME, loadConfig, ensureConfigFile, addSourceToFile } = require('./lib/config');
const { GitHubClient, DEFAULT_API_BASE } = require('./lib/github');
const { checkSource, parseRepositoryField } = require('./lib/updater');
const { readVsixManifest } = require('./lib/vsix');
const state = require('./lib/state');

const SKIPS_KEY = 'vsixUpdater.skips';
const REMINDERS_KEY = 'vsixUpdater.reminders';
const MAX_TIMEOUT = 2147483647;
const DEFAULT_STARTUP_DELAY_MS = 10000;

function activate(context) {
  const output = vscode.window.createOutputChannel('VSIX Updater');
  context.subscriptions.push(output);
  const log = (message) => output.appendLine(`[${new Date().toISOString()}] ${message}`);

  const configPath = path.join(context.globalStorageUri.fsPath, CONFIG_FILE_NAME);
  const selfRepo = parseRepositoryField(context.extension.packageJSON.repository);
  if (!selfRepo) log('Self-update unavailable: package.json has no valid github.com repository.');

  // Seam so integration tests can answer notifications programmatically.
  let notifier = async (message, buttons) => vscode.window.showInformationMessage(message, ...buttons);

  const notifiedThisSession = new Set();
  let busy = false;
  let periodicTimer = null;
  let reminderTimer = null;
  let startupTimer = null;

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
  statusBar.text = '$(cloud-download) VSIX Updates';
  statusBar.tooltip = 'Check for extension updates from GitHub';
  statusBar.command = 'vsixUpdater.checkForUpdates';
  statusBar.show();
  context.subscriptions.push(statusBar);

  function getInstalledVersion(id) {
    const extension = vscode.extensions.getExtension(id);
    return extension ? extension.packageJSON.version : undefined;
  }

  function getSkips() { return context.globalState.get(SKIPS_KEY, {}); }
  function getReminders() { return context.globalState.get(REMINDERS_KEY, {}); }

  async function readConfigForUse({ manual }) {
    const result = await loadConfig(configPath);
    for (const error of result.errors) log(`Configuration: ${error}`);
    if (result.errors.length > 0 && manual) {
      vscode.window.showErrorMessage(`VSIX Updater configuration problems: ${result.errors.join(' ')}`, 'Open Configuration')
        .then((choice) => { if (choice === 'Open Configuration') openConfig(); });
    }
    return result.config;
  }

  async function installUpdate(update, client) {
    const label = `${update.displayName} ${update.availableVersion}`;
    const tempPath = path.join(os.tmpdir(), `vsix-updater-${Date.now()}-${Math.random().toString(36).slice(2)}.vsix`);
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `VSIX Updater: installing ${label}`, cancellable: false },
        async (progress) => {
          progress.report({ message: 'downloading...' });
          let lastPercent = 0;
          await client.downloadAsset(update.asset.url, tempPath, (received, total) => {
            if (total > 0) {
              const percent = Math.floor((received / total) * 100);
              if (percent > lastPercent) {
                progress.report({ increment: percent - lastPercent, message: `downloading... ${percent}%` });
                lastPercent = percent;
              }
            }
          });
          const manifest = await readVsixManifest(tempPath);
          if (manifest.id.toLowerCase() !== update.id.toLowerCase()) {
            throw new Error(`Downloaded VSIX is "${manifest.id}" but "${update.id}" was expected; not installing.`);
          }
          if (manifest.version !== update.availableVersion) {
            throw new Error(`Downloaded VSIX is version ${manifest.version} but ${update.availableVersion} was expected; not installing.`);
          }
          progress.report({ message: 'installing...' });
          await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(tempPath));
        }
      );
      await context.globalState.update(REMINDERS_KEY, state.clearReminder(getReminders(), update.repo));
      log(`Installed ${update.id} ${update.availableVersion} from ${update.repo}.`);
      const choice = await notifier(`Installed ${label}. Reload the window to activate it.`, ['Reload Window']);
      if (choice === 'Reload Window') await vscode.commands.executeCommand('workbench.action.reloadWindow');
      return true;
    } catch (error) {
      log(`Install of ${update.id} failed: ${error.message}`);
      vscode.window.showErrorMessage(`VSIX Updater could not install ${label}: ${error.message}`);
      return false;
    } finally {
      await fsp.rm(tempPath, { force: true });
    }
  }

  async function promptUpdate(update, client) {
    const key = `${update.repo.toLowerCase()}@${update.availableVersion}`;
    notifiedThisSession.add(key);
    const reminders = getReminders();
    const entry = reminders[update.repo.toLowerCase()];
    if (entry && entry.version === update.availableVersion && Date.now() >= entry.remindAfter) {
      await context.globalState.update(REMINDERS_KEY, state.clearReminder(reminders, update.repo));
    }
    const installing = update.installedVersion === undefined;
    const action = installing ? 'Install' : 'Update';
    const message = installing
      ? `${update.displayName} ${update.availableVersion} is available to install (${update.repo}).`
      : `${update.displayName} ${update.availableVersion} is available (installed ${update.installedVersion}).`;
    for (;;) {
      const choice = await notifier(message, [action, 'Remind Me Tomorrow', 'Skip This Version', 'Release Notes']);
      if (choice === action) {
        await installUpdate(update, client);
      } else if (choice === 'Remind Me Tomorrow') {
        await context.globalState.update(REMINDERS_KEY, state.setReminder(getReminders(), update.repo, update.availableVersion, Date.now()));
        log(`${update.repo}: reminding about ${update.availableVersion} tomorrow.`);
        scheduleReminderTimer();
      } else if (choice === 'Skip This Version') {
        await context.globalState.update(SKIPS_KEY, state.addSkip(getSkips(), update.repo, update.availableVersion));
        log(`${update.repo}: version ${update.availableVersion} skipped.`);
      } else if (choice === 'Release Notes') {
        if (update.releaseUrl) await vscode.env.openExternal(vscode.Uri.parse(update.releaseUrl));
        continue; // re-offer the same choices after opening release notes
      }
      return;
    }
  }

  async function runCheck({ manual }) {
    if (busy) {
      if (manual) vscode.window.showInformationMessage('VSIX Updater is already checking for updates.');
      return { results: [], skippedWhileBusy: true };
    }
    busy = true;
    try {
      const config = await readConfigForUse({ manual });
      const sourceList = [...config.sources];
      if (selfRepo && !sourceList.some((source) => source.repo.toLowerCase() === selfRepo.toLowerCase())) {
        sourceList.push({ repo: selfRepo, asset: '' });
      }
      if (sourceList.length === 0) {
        log('No sources configured and self-update is unavailable.');
        if (manual) {
          const choice = await vscode.window.showInformationMessage(
            'VSIX Updater has no repositories configured.', 'Add GitHub Repository');
          if (choice === 'Add GitHub Repository') vscode.commands.executeCommand('vsixUpdater.addRepository');
        }
        return { results: [] };
      }
      const apiBase = process.env.VSIX_UPDATER_API_BASE || DEFAULT_API_BASE;
      const client = new GitHubClient({ apiBase, token: config.token });
      log(`Checking ${sourceList.length} source(s)${manual ? ' (manual)' : ''}...`);
      const results = [];
      for (const source of sourceList) {
        results.push(await checkSource(client, source, { getInstalledVersion }));
      }
      const errors = results.filter((result) => result.status === 'error');
      for (const result of errors) log(`Check failed: ${result.error}`);
      const offers = [];
      const skips = getSkips();
      const reminders = getReminders();
      const now = Date.now();
      for (const result of results) {
        if (result.status !== 'install' && result.status !== 'update') continue;
        const { update } = result;
        if (!manual) {
          const key = `${update.repo.toLowerCase()}@${update.availableVersion}`;
          if (state.isSkipped(skips, update.repo, update.availableVersion)) continue;
          if (state.isDeferred(reminders, update.repo, update.availableVersion, now)) continue;
          if (notifiedThisSession.has(key)) continue;
        }
        offers.push(update);
      }
      if (manual) {
        if (offers.length === 0 && errors.length === 0) {
          vscode.window.showInformationMessage('VSIX Updater: everything is up to date.');
        } else if (errors.length > 0) {
          vscode.window.showWarningMessage(
            `VSIX Updater: ${errors.length} source(s) failed. ${errors.map((result) => result.error).join(' ')}`);
        }
      }
      // Sequential prompts, one notification each, never a modal queue.
      for (const update of offers) await promptUpdate(update, client);
      return { results };
    } catch (error) {
      log(`Check failed unexpectedly: ${error.message}`);
      if (manual) vscode.window.showErrorMessage(`VSIX Updater check failed: ${error.message}`);
      return { results: [] };
    } finally {
      busy = false;
    }
  }

  async function openConfig() {
    try {
      await ensureConfigFile(configPath);
      const document = await vscode.workspace.openTextDocument(configPath);
      await vscode.window.showTextDocument(document);
    } catch (error) {
      vscode.window.showErrorMessage(`VSIX Updater could not open the configuration file: ${error.message}`);
    }
  }

  async function addRepository() {
    const input = await vscode.window.showInputBox({
      prompt: 'GitHub repository to watch for VSIX releases',
      placeHolder: 'owner/repo or https://github.com/owner/repo',
      ignoreFocusOut: true
    });
    if (input === undefined || input.trim() === '') return;
    try {
      const result = await addSourceToFile(configPath, input);
      if (result.error) {
        vscode.window.showErrorMessage(`VSIX Updater: ${result.error}`);
        return;
      }
      log(`Added source ${result.added}.`);
      const choice = await vscode.window.showInformationMessage(
        `VSIX Updater now watches ${result.added}.`, 'Check Now');
      if (choice === 'Check Now') runCheck({ manual: true });
    } catch (error) {
      vscode.window.showErrorMessage(`VSIX Updater could not update the configuration file: ${error.message}`);
    }
  }

  function schedulePeriodic(config) {
    if (periodicTimer) { clearInterval(periodicTimer); periodicTimer = null; }
    if (config.periodicCheckHours > 0) {
      const interval = Math.min(config.periodicCheckHours * 3600 * 1000, MAX_TIMEOUT);
      periodicTimer = setInterval(() => { runCheck({ manual: false }); }, interval);
      log(`Periodic checks every ${config.periodicCheckHours} hour(s).`);
    }
  }

  // Fires an automatic check when the earliest reminder becomes due, so
  // reminders work even with periodic checks disabled.
  function scheduleReminderTimer() {
    if (reminderTimer) { clearTimeout(reminderTimer); reminderTimer = null; }
    const times = Object.values(getReminders())
      .map((entry) => entry && entry.remindAfter)
      .filter((time) => typeof time === 'number');
    if (times.length === 0) return;
    const delay = Math.min(Math.max(Math.min(...times) - Date.now(), 0) + 1000, MAX_TIMEOUT);
    reminderTimer = setTimeout(() => {
      reminderTimer = null;
      runCheck({ manual: false }).then(() => scheduleReminderTimer());
    }, delay);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('vsixUpdater.checkForUpdates', () => runCheck({ manual: true })),
    vscode.commands.registerCommand('vsixUpdater.addRepository', addRepository),
    vscode.commands.registerCommand('vsixUpdater.openConfig', openConfig),
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      if (path.resolve(document.uri.fsPath).toLowerCase() !== path.resolve(configPath).toLowerCase()) return;
      const result = await loadConfig(configPath);
      if (result.errors.length > 0) {
        vscode.window.showWarningMessage(`VSIX Updater configuration problems: ${result.errors.join(' ')}`);
      }
      schedulePeriodic(result.config);
      log('Configuration reloaded.');
    }),
    { dispose: () => { for (const timer of [periodicTimer, reminderTimer, startupTimer]) if (timer) clearTimeout(timer); } }
  );

  (async () => {
    try {
      if (await ensureConfigFile(configPath)) log(`Created configuration file at ${configPath}.`);
    } catch (error) {
      log(`Could not create the configuration file: ${error.message}`);
    }
    const result = await loadConfig(configPath);
    for (const error of result.errors) log(`Configuration: ${error}`);
    schedulePeriodic(result.config);
    scheduleReminderTimer();
    const dueReminders = state.getDueReminders(getReminders(), Date.now()).length > 0;
    if (result.config.checkOnStartup || dueReminders) {
      const delay = process.env.VSIX_UPDATER_STARTUP_DELAY_MS !== undefined
        ? Number(process.env.VSIX_UPDATER_STARTUP_DELAY_MS)
        : DEFAULT_STARTUP_DELAY_MS;
      startupTimer = setTimeout(() => { startupTimer = null; runCheck({ manual: false }); }, delay);
    }
  })();

  if (process.env.VSIX_UPDATER_TEST === '1') {
    return {
      _test: {
        runCheck,
        setNotifier: (fn) => { notifier = fn; },
        getConfigPath: () => configPath,
        getState: () => ({ skips: getSkips(), reminders: getReminders() }),
        resetSession: () => notifiedThisSession.clear(),
        clearState: async () => {
          await context.globalState.update(SKIPS_KEY, undefined);
          await context.globalState.update(REMINDERS_KEY, undefined);
          notifiedThisSession.clear();
        }
      }
    };
  }
  return undefined;
}

function deactivate() {}

module.exports = { activate, deactivate };
