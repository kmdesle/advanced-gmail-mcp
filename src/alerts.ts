#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { getAccounts } from './config.js';
import { getGmailClient } from './gmail/client.js';
import { AccountWatcher, parseRules } from './alerts/watcher.js';

async function main() {
  const rules = parseRules(JSON.parse(await readFile(join(homedir(), '.config/gmail-alerts/rules.json'), 'utf8')));
  const accounts = getAccounts();
  const watchers = [...new Set(rules.map(rule => rule.account))].map(alias => {
    const account = accounts.find(account => account.alias === alias);
    if (!account) throw new Error(`Unknown watched account alias: ${alias}`);
    return new AccountWatcher(alias, rules, join(homedir(), '.local/state/gmail-alerts'), () => getGmailClient(account));
  });
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  try {
    await Promise.all(watchers.map(async watcher => {
      while (!controller.signal.aborted) {
        const started = Date.now();
        await watcher.poll();
        try {
          await setTimeout(Math.max(0, 60_000 - (Date.now() - started)), undefined, { signal: controller.signal });
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        }
      }
    }));
  } finally {
    // A fatal state-write failure must stop all loops so systemd can restart us.
    controller.abort();
  }
}

main().catch(() => {
  console.error('Gmail alerts stopped. Check rules, account aliases, state permissions, and authentication.');
  process.exitCode = 1;
});
