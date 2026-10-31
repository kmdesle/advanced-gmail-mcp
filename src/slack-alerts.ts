#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createSlackClient, parseOverrides, SlackWatcher } from './slack/watcher.js';

async function main() {
  const token = process.env.SLACK_ALERTS_BOT_TOKEN;
  if (!token) throw new Error('SLACK_ALERTS_BOT_TOKEN is not set');
  const args = process.argv.slice(2);
  let backfillDays: number | undefined;
  if (args.length) {
    backfillDays = args[0] === '--backfill' && args.length === 2 && /^\d+(\.\d+)?$/.test(args[1]) ? Number(args[1]) : NaN;
    if (!(backfillDays > 0)) throw new Error('Usage: slack-alerts [--backfill <days>]');
  }
  let overrides;
  try {
    overrides = parseOverrides(JSON.parse(await readFile(join(homedir(), '.config/slack-alerts/channels.json'), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const watcher = new SlackWatcher(createSlackClient(token), join(homedir(), '.local/state/slack-alerts'), overrides);

  if (backfillDays !== undefined) {
    console.log(`Wrote ${join(homedir(), '.local/state/slack-alerts', await watcher.backfill(backfillDays))}`);
    return;
  }
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  try {
    while (!controller.signal.aborted) {
      const started = Date.now();
      await watcher.poll();
      try {
        await setTimeout(Math.max(0, 60_000 - (Date.now() - started)), undefined, { signal: controller.signal });
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      }
    }
  } finally {
    controller.abort();
  }
}

main().catch(() => {
  // Never print the error object: keep the token and request details out of logs.
  console.error('Slack alerts stopped. Check SLACK_ALERTS_BOT_TOKEN, channels.json, arguments, and state permissions.');
  process.exitCode = 1;
});
