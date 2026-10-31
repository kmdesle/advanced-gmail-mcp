import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';
import type { Auth } from 'googleapis';
import { createHash } from 'node:crypto';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import { type AccountConfig, resolveAccount } from '../config.js';
import { getAuthClient } from './auth.js';
import type {
  EmailSummary,
  EmailFull,
  AttachmentInfo,
  ThreadInfo,
  ThreadMessage,
  LabelInfo,
  SendResult,
  DraftResult,
  ModifyResult,
  BatchResult,
  SendAsAlias,
} from './types.js';

// ---------------------------------------------------------------------------
// Client cache: OAuth2Client per account with 50-min TTL
// ---------------------------------------------------------------------------

interface CachedClient {
  client: Auth.OAuth2Client;
  gmail: gmail_v1.Gmail;
  expiresAt: number;
}

const CLIENT_CACHE = new Map<string, CachedClient>();
const CLIENT_TTL_MS = 50 * 60 * 1000; // 50 minutes

/** Test seam for operations; tests replace this without loading credentials. */
export const gmailDeps = {
  resolveAccount,
  getGmailClient,
  async getMessage(opts: { messageId: string; account?: string; format?: 'full' | 'metadata' | 'minimal'; headers?: string[]; authSummary?: boolean }) {
    return getMessage(opts);
  },
  async listSendAs(opts?: { account?: string | AccountConfig }) {
    return listSendAs(opts);
  },
};

/**
 * Load the cached Gmail client and the OAuth2 client it was built with.
 * Calendar uses the same OAuth2 client instead of a second token refresh.
 */
async function loadCachedClient(account?: string | AccountConfig): Promise<CachedClient> {
  const resolved = typeof account === 'string' || account === undefined
    ? resolveAccount(account)
    : account;

  const cacheKey = resolved.email;
  const cached = CLIENT_CACHE.get(cacheKey);

  if (cached && Date.now() < cached.expiresAt) {
    return cached;
  }

  const authClient = await getAuthClient(resolved);
  const gmail = google.gmail({ version: 'v1', auth: authClient });

  const entry: CachedClient = {
    client: authClient,
    gmail,
    expiresAt: Date.now() + CLIENT_TTL_MS,
  };
  CLIENT_CACHE.set(cacheKey, entry);
  return entry;
}

/**
 * Get an authenticated Gmail API client for an account.
 * Caches OAuth2Client per account with 50-min TTL.
 */
export async function getGmailClient(account?: string | AccountConfig): Promise<gmail_v1.Gmail> {
  return (await loadCachedClient(account)).gmail;
}

/**
 * OAuth2 client shared with Gmail tools for this account (same cache entry).
 */
export async function getSharedAuthClient(account?: string | AccountConfig): Promise<Auth.OAuth2Client> {
  return (await loadCachedClient(account)).client;
}

// ---------------------------------------------------------------------------
// Retry helper for rate limits
// ---------------------------------------------------------------------------

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      const status = (err as any)?.code || (err as any)?.response?.status;

      // Auth errors: give clear re-auth instructions, don't retry
      if (status === 401 || status === 403) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Authentication error (${status}): ${message}\n\n` +
          `Re-authenticate with: npx tsx src/auth.ts <account-alias>`
        );
      }

      // Rate limit: retry with exponential backoff
      if (status === 429 && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // Other errors: pass through
      if (status !== 429) {
        throw err;
      }
    }
  }
  throw lastError;
}

/**
 * Run `fn` over `items` with at most `limit` in flight at once.
 * listMessages/searchMessages need one `.get()` per matched message — doing
 * that sequentially made any non-trivial query take tens of seconds to
 * minutes (diagnosed 2026-08-29 chasing an Ask Wisp "hang" that turned out
 * to just be this). 10 concurrent requests stays well under Gmail API's
 * per-user quota for the metadata-only `.get()` calls these are used for.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const METADATA_FETCH_CONCURRENCY = 10;

// ---------------------------------------------------------------------------
// Header / body extraction helpers
// ---------------------------------------------------------------------------

function extractHeader(
  headers: Array<{ name?: string | null; value?: string | null }>,
  name: string,
): string {
  const header = headers.find(h => h.name?.toLowerCase() === name.toLowerCase());
  return header?.value || '';
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

/**
 * Recursively extract HTML and plain-text body from a MIME payload.
 */
function extractBody(payload: gmail_v1.Schema$MessagePart): { html: string; text: string } {
  let html = '';
  let text = '';

  if (payload.mimeType === 'text/html' && payload.body?.data) {
    html = decodeBase64Url(payload.body.data);
  } else if (payload.mimeType === 'text/plain' && payload.body?.data) {
    text = decodeBase64Url(payload.body.data);
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      const result = extractBody(part);
      if (result.html) html = result.html;
      if (result.text) text = result.text;
    }
  }

  return { html, text };
}

/**
 * Extract attachment metadata from message parts (no content download).
 */
function extractAttachments(payload: gmail_v1.Schema$MessagePart): AttachmentInfo[] {
  const attachments: AttachmentInfo[] = [];

  if (payload.filename && payload.filename.length > 0 && payload.body?.attachmentId) {
    attachments.push({
      filename: payload.filename,
      mimeType: payload.mimeType || 'application/octet-stream',
      size: payload.body.size || 0,
      attachment_id: payload.body.attachmentId,
      part_id: payload.partId || '',
    });
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      attachments.push(...extractAttachments(part));
    }
  }

  return attachments;
}

/**
 * Parse a Gmail API message into an EmailSummary.
 */
function toEmailSummary(msg: gmail_v1.Schema$Message): EmailSummary {
  const headers = msg.payload?.headers || [];
  return {
    id: msg.id || '',
    threadId: msg.threadId || '',
    from: extractHeader(headers, 'From'),
    to: extractHeader(headers, 'To'),
    subject: extractHeader(headers, 'Subject'),
    date: extractHeader(headers, 'Date'),
    snippet: msg.snippet || '',
    labels: msg.labelIds || [],
    isUnread: (msg.labelIds || []).includes('UNREAD'),
  };
}

/**
 * Parse a Gmail API message into an EmailFull.
 */
function toEmailFull(msg: gmail_v1.Schema$Message): EmailFull {
  const headers = msg.payload?.headers || [];
  const { html, text } = msg.payload ? extractBody(msg.payload) : { html: '', text: '' };
  const attachments = msg.payload ? extractAttachments(msg.payload) : [];

  return {
    id: msg.id || '',
    threadId: msg.threadId || '',
    from: extractHeader(headers, 'From'),
    to: extractHeader(headers, 'To'),
    cc: extractHeader(headers, 'Cc'),
    bcc: extractHeader(headers, 'Bcc'),
    subject: extractHeader(headers, 'Subject'),
    date: extractHeader(headers, 'Date'),
    body_text: text,
    body_html: html,
    labels: msg.labelIds || [],
    attachments,
  };
}

/**
 * Parse a Gmail API message into a ThreadMessage (lighter than EmailFull).
 */
function toThreadMessage(msg: gmail_v1.Schema$Message): ThreadMessage {
  const headers = msg.payload?.headers || [];
  const { text } = msg.payload ? extractBody(msg.payload) : { text: '' };

  return {
    id: msg.id || '',
    from: extractHeader(headers, 'From'),
    to: extractHeader(headers, 'To'),
    cc: extractHeader(headers, 'Cc'),
    subject: extractHeader(headers, 'Subject'),
    date: extractHeader(headers, 'Date'),
    body_text: text,
    snippet: msg.snippet || '',
    labels: msg.labelIds || [],
  };
}

// ---------------------------------------------------------------------------
// MIME construction
// ---------------------------------------------------------------------------

interface MimeOptions {
  to: string;
  subject: string;
  body: string;
  from?: string;
  cc?: string;
  bcc?: string;
  is_html?: boolean;
  in_reply_to?: string;
  references?: string;
}

/**
 * RFC 2822 headers are 7-bit ASCII only — any non-ASCII character (emoji,
 * accents, etc.) must be RFC 2047 "encoded word" wrapped, or mail clients
 * interpret the raw UTF-8 bytes as Latin-1/cp1252 and render mojibake
 * (e.g. 📬 becomes "ðŸ“¬"). Only Subject is encoded here since To/Cc/Bcc are
 * plain addr-specs in this codebase (no display names to encode).
 */
function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf-8').toString('base64')}?=`;
}

/**
 * Build an RFC 2822 message and encode as base64url for the Gmail API.
 */
function buildRawMessage(opts: MimeOptions): string {
  const lines: string[] = [];

  if (opts.from) lines.push(`From: ${opts.from}`);
  lines.push(`To: ${opts.to}`);
  if (opts.cc) lines.push(`Cc: ${opts.cc}`);
  if (opts.bcc) lines.push(`Bcc: ${opts.bcc}`);
  lines.push(`Subject: ${encodeHeaderValue(opts.subject)}`);
  if (opts.in_reply_to) lines.push(`In-Reply-To: ${opts.in_reply_to}`);
  if (opts.references) lines.push(`References: ${opts.references}`);
  lines.push(`MIME-Version: 1.0`);
  lines.push(`Content-Type: ${opts.is_html ? 'text/html' : 'text/plain'}; charset="UTF-8"`);
  lines.push(''); // blank line separates headers from body
  lines.push(opts.body);

  const raw = lines.join('\r\n');
  return Buffer.from(raw).toString('base64url');
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * List messages in a mailbox.
 * Paginates through all results up to maxResults (default 500, hard cap 1000).
 */
export async function listMessages(opts: {
  account?: string;
  label?: string;
  maxResults?: number;
  query?: string;
}): Promise<EmailSummary[]> {
  const gmail = await getGmailClient(opts.account);
  const labelIds = opts.label ? [opts.label] : ['INBOX'];
  const maxResults = Math.min(opts.maxResults ?? 500, 1000);

  // Paginate through messages.list to collect all message IDs
  const allMessageRefs: Array<{ id: string }> = [];
  let pageToken: string | undefined;

  while (allMessageRefs.length < maxResults) {
    const pageSize = Math.min(maxResults - allMessageRefs.length, 500);
    const response = await withRetry(() =>
      gmail.users.messages.list({
        userId: 'me',
        labelIds,
        maxResults: pageSize,
        q: opts.query || undefined,
        pageToken,
      })
    );

    const messages = response.data.messages || [];
    for (const msg of messages) {
      if (msg.id) allMessageRefs.push({ id: msg.id });
    }

    pageToken = response.data.nextPageToken ?? undefined;
    if (!pageToken || messages.length === 0) break;
  }

  if (allMessageRefs.length === 0) return [];

  // Fetch metadata for each message, up to METADATA_FETCH_CONCURRENCY at once
  return mapWithConcurrency(allMessageRefs, METADATA_FETCH_CONCURRENCY, async (msg) => {
    const full = await withRetry(() =>
      gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      })
    );
    return toEmailSummary(full.data);
  });
}

/**
 * Get a single message by ID.
 */
export async function getMessage(opts: {
  messageId: string;
  account?: string;
  format?: 'full' | 'metadata' | 'minimal';
  headers?: string[];
  authSummary?: boolean;
}): Promise<EmailFull | (EmailFull & { headers?: Record<string, string[]>; auth_summary?: { spf: string; dkim: string[]; dkim_domains: string[]; dmarc: string; list_unsubscribe: string[]; list_unsubscribe_post: string[] } })> {
  const gmail = await gmailDeps.getGmailClient(opts.account);
  const format = opts.format ?? 'full';
  const metadataHeaders = opts.headers || opts.authSummary
    ? [...new Set([...(opts.headers || []), ...(opts.authSummary ? ['Authentication-Results', 'ARC-Authentication-Results', 'List-Unsubscribe', 'List-Unsubscribe-Post'] : [])])]
    : undefined;
  const requestFormat = metadataHeaders && format === 'minimal' ? 'metadata' : format;

  const response = await withRetry(() =>
    gmail.users.messages.get({
      userId: 'me',
      id: opts.messageId,
      format: requestFormat,
      ...(metadataHeaders && requestFormat === 'metadata' ? { metadataHeaders } : {}),
    })
  );

  const email = toEmailFull(response.data);
  if (!opts.headers && !opts.authSummary) return email;
  const rawHeaders = response.data.payload?.headers || [];
  const select = (names: string[]) => Object.fromEntries(names.map(name => [
    name.toLowerCase(), rawHeaders.filter(h => h.name?.toLowerCase() === name.toLowerCase()).map(h => h.value || ''),
  ]));
  const result: EmailFull & { headers?: Record<string, string[]>; auth_summary?: { spf: string; dkim: string[]; dkim_domains: string[]; dmarc: string; list_unsubscribe: string[]; list_unsubscribe_post: string[] } } = { ...email };
  if (opts.headers) result.headers = select(opts.headers);
  if (opts.authSummary) {
    const auth = rawHeaders.find(h => h.name?.toLowerCase() === 'authentication-results')?.value
      || rawHeaders.find(h => h.name?.toLowerCase() === 'arc-authentication-results')?.value || '';
    const results = (method: string) => [...auth.matchAll(new RegExp(`(?:^|[;\\s])${method}=([\\w-]+)([^;]*)`, 'gi'))];
    const spf = results('spf')[0]?.[1]?.toLowerCase() || 'none';
    const dkimResults = results('dkim');
    const dkimDomains = dkimResults.map(match => match[2].match(/\bd=([\w.-]+)/i)?.[1]).filter((value): value is string => Boolean(value));
    const dmarc = results('dmarc')[0]?.[1]?.toLowerCase() || 'none';
    const values = (name: string) => rawHeaders.filter(h => h.name?.toLowerCase() === name.toLowerCase()).map(h => h.value || '');
    result.auth_summary = { spf, dkim: dkimResults.map(match => match[1].toLowerCase()), dkim_domains: dkimDomains, dmarc, list_unsubscribe: values('List-Unsubscribe'), list_unsubscribe_post: values('List-Unsubscribe-Post') };
  }
  return result;
}

const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;

export interface DownloadAttachmentResult {
  path: string;
  size: number;
  mimeType: string;
  sha256: string;
}

function safeFilename(filename: string): string {
  if (filename.includes('/') || filename.includes('\\') || filename === '.' || filename === '..') {
    throw new Error('Attachment filename must not contain path traversal.');
  }
  const sanitized = basename(filename).replace(/[\0-\x1f<>:"|?*]/g, '_').trim();
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new Error('Attachment filename is invalid.');
  }
  return sanitized;
}

/** Save a message attachment locally and return metadata only. */
export async function downloadAttachment(opts: {
  messageId: string;
  attachmentId?: string;
  filename?: string;
  destDir: string;
  account?: string;
}): Promise<DownloadAttachmentResult> {
  if (!opts.attachmentId && !opts.filename) {
    throw new Error('Provide attachment_id or filename.');
  }
  if (!opts.destDir || !resolve(opts.destDir).startsWith(sep) || !opts.destDir.startsWith(sep)) {
    throw new Error('dest_dir must be an absolute path to an existing directory.');
  }
  if ((await lstat(opts.destDir)).isSymbolicLink()) throw new Error('dest_dir must not be a symlink.');
  const destination = await realpath(opts.destDir);
  const destinationStat = await stat(destination);
  if (!destinationStat.isDirectory()) throw new Error('dest_dir must be an existing directory.');

  const gmail = await gmailDeps.getGmailClient(opts.account);
  const message = await withRetry(() => gmail.users.messages.get({
    userId: 'me', id: opts.messageId, format: 'full',
  }));
  const attachments = message.data.payload ? extractAttachments(message.data.payload) : [];
  const matches = opts.attachmentId
    ? attachments.filter(item => item.attachment_id === opts.attachmentId)
    : attachments.filter(item => item.filename === opts.filename);
  if (!matches.length) throw new Error('Attachment not found in message.');
  if (matches.length > 1) throw new Error('Attachment match is ambiguous.');
  const attachment = matches[0];
  if (attachment.size > MAX_ATTACHMENT_SIZE) throw new Error('Attachment exceeds the 25 MB size limit.');
  const filename = safeFilename(attachment.filename);
  const response = await withRetry(() => gmail.users.messages.attachments.get({
    userId: 'me', messageId: opts.messageId, id: attachment.attachment_id,
  }));
  const encoded = response.data.data;
  if (!encoded) throw new Error('Attachment content is missing.');
  const bytes = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (bytes.byteLength > MAX_ATTACHMENT_SIZE) throw new Error('Attachment exceeds the 25 MB size limit.');

  const ext = extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  let path = join(destination, filename);
  for (let suffix = 1; ; suffix++) {
    const resolvedPath = resolve(path);
    if (!resolvedPath.startsWith(destination + sep)) throw new Error('Resolved attachment path escapes dest_dir.');
    try {
      const file = await open(path, 'wx', 0o600);
      try {
        await file.writeFile(bytes);
      } finally {
        await file.close();
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      path = join(destination, `${stem} (${suffix})${ext}`);
    }
  }
  return {
    path,
    size: bytes.byteLength,
    mimeType: attachment.mimeType,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/**
 * Search messages using Gmail query syntax.
 * Paginates through all results up to maxResults (default 500, hard cap 1000).
 */
export async function searchMessages(opts: {
  query: string;
  account?: string;
  maxResults?: number;
}): Promise<EmailSummary[]> {
  const gmail = await getGmailClient(opts.account);
  const maxResults = Math.min(opts.maxResults ?? 500, 1000);

  // Paginate through messages.list to collect all message IDs
  const allMessageRefs: Array<{ id: string }> = [];
  let pageToken: string | undefined;

  while (allMessageRefs.length < maxResults) {
    const pageSize = Math.min(maxResults - allMessageRefs.length, 500);
    const response = await withRetry(() =>
      gmail.users.messages.list({
        userId: 'me',
        q: opts.query,
        maxResults: pageSize,
        pageToken,
      })
    );

    const messages = response.data.messages || [];
    for (const msg of messages) {
      if (msg.id) allMessageRefs.push({ id: msg.id });
    }

    pageToken = response.data.nextPageToken ?? undefined;
    if (!pageToken || messages.length === 0) break;
  }

  if (allMessageRefs.length === 0) return [];

  // Fetch metadata for each message, up to METADATA_FETCH_CONCURRENCY at once
  return mapWithConcurrency(allMessageRefs, METADATA_FETCH_CONCURRENCY, async (msg) => {
    const full = await withRetry(() =>
      gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      })
    );
    return toEmailSummary(full.data);
  });
}

/**
 * List all send-as aliases for an account.
 * Wraps users.settings.sendAs.list.
 */
export async function listSendAs(opts?: {
  account?: string | AccountConfig;
}): Promise<SendAsAlias[]> {
  const resolved = typeof opts?.account === 'object' && opts.account !== null && 'email' in opts.account
    ? opts.account
    : gmailDeps.resolveAccount(opts?.account);
  const gmail = await gmailDeps.getGmailClient(resolved);

  const response = await withRetry(() =>
    gmail.users.settings.sendAs.list({ userId: 'me' })
  );

  return (response.data.sendAs || []).map((sa) => ({
    sendAsEmail: sa.sendAsEmail || '',
    displayName: sa.displayName || '',
    isDefault: sa.isDefault ?? false,
    verificationStatus:
      sa.verificationStatus ||
      (sa.isPrimary || (sa.sendAsEmail && sa.sendAsEmail.toLowerCase() === resolved.email.toLowerCase())
        ? 'accepted'
        : ''),
  }));
}

/**
 * Parse an RFC 2822 "From" string into email and optional display name.
 * Handles "Name <email@example.com>", "\"Name\" <email@example.com>", or bare "email@example.com".
 */
export function parseFromAddress(input: string): { email: string; displayName?: string } {
  const match = input.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (match) {
    let displayName = match[1].trim();
    if (displayName.startsWith('"') && displayName.endsWith('"')) {
      displayName = displayName.slice(1, -1).trim();
    }
    return {
      email: match[2].trim(),
      displayName: displayName.length > 0 ? displayName : undefined,
    };
  }
  return {
    email: input.trim(),
    displayName: undefined,
  };
}

/**
 * Validate and format the sender ("From") address.
 *
 * If fromInput is omitted: returns account.email unchanged (exact backwards compatibility).
 * If fromInput is provided:
 * - Must match primary address or a sendAs alias with verificationStatus "accepted".
 * - If invalid: fails closed naming all allowed aliases.
 * - When from is an alias with no display name given, the alias's configured displayName is used.
 */
async function resolveSender(
  resolved: AccountConfig,
  fromInput?: string,
): Promise<string> {
  if (fromInput === undefined) {
    return resolved.email;
  }

  const { email, displayName: customDisplayName } = parseFromAddress(fromInput);
  const normalizedEmail = email.toLowerCase();
  const primaryEmail = resolved.email.toLowerCase();

  const aliases = await gmailDeps.listSendAs({ account: resolved });

  const isPrimary = normalizedEmail === primaryEmail;
  const matchingAlias = aliases.find(
    (a) => a.sendAsEmail.toLowerCase() === normalizedEmail,
  );
  const isVerifiedAlias =
    matchingAlias !== undefined &&
    matchingAlias.verificationStatus.toLowerCase() === 'accepted';

  if (!isPrimary && !isVerifiedAlias) {
    const allowed = new Set<string>();
    allowed.add(resolved.email);
    for (const a of aliases) {
      if (
        a.verificationStatus.toLowerCase() === 'accepted' ||
        a.sendAsEmail.toLowerCase() === primaryEmail
      ) {
        allowed.add(a.sendAsEmail);
      }
    }
    const allowedList = Array.from(allowed).join(', ');
    throw new Error(
      `Invalid "from" address: "${email}". Allowed aliases: ${allowedList}`,
    );
  }

  const chosenDisplayName =
    customDisplayName ??
    (matchingAlias?.displayName && matchingAlias.displayName.trim().length > 0
      ? matchingAlias.displayName.trim()
      : undefined);

  if (chosenDisplayName && chosenDisplayName.length > 0) {
    return `${encodeHeaderValue(chosenDisplayName)} <${email}>`;
  }

  return email;
}

/**
 * Send an email.
 */
export async function sendMessage(opts: {
  to: string;
  subject: string;
  body: string;
  account?: string;
  from?: string;
  cc?: string;
  bcc?: string;
  is_html?: boolean;
}): Promise<SendResult> {
  const resolved = gmailDeps.resolveAccount(opts.account);
  const gmail = await gmailDeps.getGmailClient(resolved);
  const from = await resolveSender(resolved, opts.from);

  const raw = buildRawMessage({
    from,
    to: opts.to,
    subject: opts.subject,
    body: opts.body,
    cc: opts.cc,
    bcc: opts.bcc,
    is_html: opts.is_html,
  });

  const response = await withRetry(() =>
    gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    })
  );

  return {
    id: response.data.id || '',
    threadId: response.data.threadId || '',
    labelIds: response.data.labelIds || [],
  };
}

/**
 * Create a draft email.
 */
export async function createDraft(opts: {
  to: string;
  subject: string;
  body: string;
  account?: string;
  from?: string;
  cc?: string;
  bcc?: string;
  is_html?: boolean;
}): Promise<DraftResult> {
  const resolved = gmailDeps.resolveAccount(opts.account);
  const gmail = await gmailDeps.getGmailClient(resolved);
  const from = await resolveSender(resolved, opts.from);

  const raw = buildRawMessage({
    from,
    to: opts.to,
    subject: opts.subject,
    body: opts.body,
    cc: opts.cc,
    bcc: opts.bcc,
    is_html: opts.is_html,
  });

  const response = await withRetry(() =>
    gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: { raw },
      },
    })
  );

  return {
    draft_id: response.data.id || '',
    message: {
      id: response.data.message?.id || '',
      threadId: response.data.message?.threadId || '',
    },
  };
}

/**
 * Modify labels on a message (add/remove).
 */
export async function modifyMessage(opts: {
  messageId: string;
  addLabelIds?: string[];
  removeLabelIds?: string[];
  account?: string;
}): Promise<ModifyResult> {
  const gmail = await getGmailClient(opts.account);

  const response = await withRetry(() =>
    gmail.users.messages.modify({
      userId: 'me',
      id: opts.messageId,
      requestBody: {
        addLabelIds: opts.addLabelIds || [],
        removeLabelIds: opts.removeLabelIds || [],
      },
    })
  );

  return {
    success: true,
    id: response.data.id || '',
    labels: response.data.labelIds || [],
  };
}

/**
 * Move a message to trash.
 */
export async function trashMessage(opts: {
  messageId: string;
  account?: string;
}): Promise<ModifyResult> {
  const gmail = await getGmailClient(opts.account);

  const response = await withRetry(() =>
    gmail.users.messages.trash({
      userId: 'me',
      id: opts.messageId,
    })
  );

  return {
    success: true,
    id: response.data.id || '',
  };
}

/**
 * Batch modify messages (add/remove labels).
 */
export async function batchModify(opts: {
  messageIds: string[];
  addLabelIds?: string[];
  removeLabelIds?: string[];
  account?: string;
}): Promise<BatchResult> {
  const gmail = await getGmailClient(opts.account);

  await withRetry(() =>
    gmail.users.messages.batchModify({
      userId: 'me',
      requestBody: {
        ids: opts.messageIds,
        addLabelIds: opts.addLabelIds || [],
        removeLabelIds: opts.removeLabelIds || [],
      },
    })
  );

  return {
    success: true,
    modified_count: opts.messageIds.length,
    message_ids: opts.messageIds,
  };
}

/**
 * List message IDs matching a query, cheaply — no per-message metadata fetch.
 * Used by bulk operations where fetching full metadata for every match would
 * be far too slow (listMessages/searchMessages do one `.get()` per result,
 * which doesn't scale past a few hundred messages).
 */
async function listMessageIdsByQuery(opts: {
  query: string;
  account?: string;
  maxIds?: number;
}): Promise<{ ids: string[]; estimatedTotal: number }> {
  const gmail = await getGmailClient(opts.account);
  const maxIds = opts.maxIds ?? 50_000;

  const ids: string[] = [];
  let pageToken: string | undefined;
  let estimatedTotal = 0;
  let firstPage = true;

  while (ids.length < maxIds) {
    // Always request a full page (Gmail's max) even if the caller only wants
    // a handful of IDs back — resultSizeEstimate is unreliable when the page
    // size itself is small (it tends to just reflect the requested page size
    // rather than the query's true match count). We still only keep/return
    // up to maxIds below.
    const response = await withRetry(() =>
      gmail.users.messages.list({
        userId: 'me',
        q: opts.query,
        maxResults: 500,
        pageToken,
      })
    );

    if (firstPage) {
      estimatedTotal = response.data.resultSizeEstimate ?? 0;
      firstPage = false;
    }

    const messages = response.data.messages || [];
    for (const msg of messages) {
      if (msg.id && ids.length < maxIds) ids.push(msg.id);
    }

    pageToken = response.data.nextPageToken ?? undefined;
    if (!pageToken || messages.length === 0 || ids.length >= maxIds) break;
  }

  return { ids, estimatedTotal };
}

const PREVIEW_COUNT_CAP = 20_000;

/**
 * Cheap preview of a bulk query: a real count (via full ID-only pagination,
 * not Gmail's resultSizeEstimate — that field turned out to just reflect the
 * requested page size rather than the true match count, verified empirically:
 * five completely different queries all "estimated" exactly 501 when paged at
 * 500) plus a small sample of real messages (with metadata) so the user can
 * sanity-check what would be touched before anything is modified. Counting
 * is still cheap — it's ID-only pagination, ~1 request per 500 matches, no
 * per-message metadata fetch — capped at PREVIEW_COUNT_CAP so an enormous
 * bucket doesn't turn a "preview" into a multi-minute call.
 */
export async function previewBulkQuery(opts: {
  query: string;
  account?: string;
  sampleSize?: number;
}): Promise<import('./types.js').BulkPreviewResult> {
  const sampleSize = Math.min(opts.sampleSize ?? 15, 50);
  const gmail = await getGmailClient(opts.account);

  const { ids } = await listMessageIdsByQuery({
    query: opts.query,
    account: opts.account,
    maxIds: PREVIEW_COUNT_CAP,
  });

  const sampleIds = ids.slice(0, sampleSize);
  const sample: EmailSummary[] = [];
  const senderCounts = new Map<string, number>();

  for (const id of sampleIds) {
    const full = await withRetry(() =>
      gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      })
    );
    const summary = toEmailSummary(full.data);
    sample.push(summary);
    senderCounts.set(summary.from, (senderCounts.get(summary.from) || 0) + 1);
  }

  const top_senders = [...senderCounts.entries()]
    .map(([from, count]) => ({ from, count }))
    .sort((a, b) => b.count - a.count);

  return {
    query: opts.query,
    estimated_count: ids.length,
    count_is_capped: ids.length >= PREVIEW_COUNT_CAP,
    sample,
    top_senders,
  };
}

/**
 * Execute a bulk action (archive, or add/remove labels) against every message
 * matching a query. Paginates message IDs cheaply, then batchModifies in
 * chunks of 1000 (Gmail API's per-call limit). Capped at maxMessages as a
 * safety backstop against an unexpectedly broad query.
 */
export async function bulkModifyByQuery(opts: {
  query: string;
  account?: string;
  addLabelIds?: string[];
  removeLabelIds?: string[];
  maxMessages?: number;
}): Promise<{ modified_count: number; batches: number; truncated: boolean }> {
  const maxMessages = opts.maxMessages ?? 50_000;
  const { ids, estimatedTotal } = await listMessageIdsByQuery({
    query: opts.query,
    account: opts.account,
    maxIds: maxMessages,
  });

  let modified_count = 0;
  let batches = 0;
  const CHUNK = 1000;

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    await batchModify({
      messageIds: chunk,
      addLabelIds: opts.addLabelIds,
      removeLabelIds: opts.removeLabelIds,
      account: opts.account,
    });
    modified_count += chunk.length;
    batches += 1;
  }

  return { modified_count, batches, truncated: estimatedTotal > ids.length };
}

/**
 * Create a new Gmail label.
 */
export async function createLabel(opts: {
  name: string;
  account?: string;
}): Promise<LabelInfo> {
  const gmail = await getGmailClient(opts.account);

  const response = await withRetry(() =>
    gmail.users.labels.create({
      userId: 'me',
      requestBody: {
        name: opts.name,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      },
    })
  );

  return {
    id: response.data.id || '',
    name: response.data.name || '',
    type: response.data.type || 'user',
    messagesTotal: 0,
    messagesUnread: 0,
  };
}

/**
 * Create a Gmail filter (server-side rule applied to future incoming mail).
 * Requires the gmail.settings.basic scope — accounts authenticated before
 * that scope was added must re-run `npx tsx src/auth.ts <alias>`.
 */
export async function createFilter(opts: {
  criteria: import('./types.js').FilterCriteria;
  action: import('./types.js').FilterAction;
  account?: string;
}): Promise<import('./types.js').FilterInfo> {
  const gmail = await getGmailClient(opts.account);

  const response = await withRetry(() =>
    gmail.users.settings.filters.create({
      userId: 'me',
      requestBody: {
        criteria: {
          from: opts.criteria.from,
          to: opts.criteria.to,
          subject: opts.criteria.subject,
          query: opts.criteria.query,
          hasAttachment: opts.criteria.hasAttachment,
          excludeChats: opts.criteria.excludeChats,
          size: opts.criteria.size,
          sizeComparison: opts.criteria.sizeComparison,
        },
        action: {
          addLabelIds: opts.action.addLabelIds,
          removeLabelIds: opts.action.removeLabelIds,
          forward: opts.action.forward,
        },
      },
    })
  );

  return {
    id: response.data.id || '',
    criteria: opts.criteria,
    action: opts.action,
  };
}

/**
 * List all Gmail filters (rules) for an account.
 */
export async function listFilters(opts?: {
  account?: string;
}): Promise<import('./types.js').FilterInfo[]> {
  const gmail = await getGmailClient(opts?.account);

  const response = await withRetry(() =>
    gmail.users.settings.filters.list({ userId: 'me' })
  );

  return (response.data.filter || []).map(f => ({
    id: f.id || '',
    criteria: f.criteria || {},
    action: f.action || {},
  }));
}

/**
 * List all labels for an account.
 */
export async function listLabels(opts?: {
  account?: string;
}): Promise<LabelInfo[]> {
  const gmail = await getGmailClient(opts?.account);

  const response = await withRetry(() =>
    gmail.users.labels.list({ userId: 'me' })
  );

  const labels = response.data.labels || [];

  return labels.map(label => ({
    id: label.id || '',
    name: label.name || '',
    type: label.type || '',
    messagesTotal: label.messagesTotal || 0,
    messagesUnread: label.messagesUnread || 0,
  }));
}

/**
 * Get a thread with all its messages.
 */
export async function getThread(opts: {
  threadId: string;
  account?: string;
}): Promise<ThreadInfo> {
  const gmail = await getGmailClient(opts.account);

  const response = await withRetry(() =>
    gmail.users.threads.get({
      userId: 'me',
      id: opts.threadId,
      format: 'full',
    })
  );

  const messages = (response.data.messages || []).map(toThreadMessage);

  return {
    id: response.data.id || '',
    messages,
  };
}

/**
 * Send a reply to an existing message.
 * Fetches the original to get threadId, Message-ID, Subject, and From for proper threading.
 */
export async function replyToMessage(opts: {
  messageId: string;
  body: string;
  account?: string;
  from?: string;
  is_html?: boolean;
  reply_all?: boolean;
  cc?: string;
  bcc?: string;
}): Promise<SendResult> {
  const resolved = gmailDeps.resolveAccount(opts.account);
  const gmail = await gmailDeps.getGmailClient(resolved);
  const from = await resolveSender(resolved, opts.from);

  // Fetch the original message to get threading headers
  const original = await withRetry(() =>
    gmail.users.messages.get({
      userId: 'me',
      id: opts.messageId,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Message-ID', 'References'],
    })
  );

  const headers = original.data.payload?.headers || [];
  const originalFrom = extractHeader(headers, 'From');
  const originalTo = extractHeader(headers, 'To');
  const originalCc = extractHeader(headers, 'Cc');
  const originalSubject = extractHeader(headers, 'Subject');
  const originalMessageId = extractHeader(headers, 'Message-ID');
  const originalReferences = extractHeader(headers, 'References');

  // Build "Re:" subject if not already present
  const subject = originalSubject.startsWith('Re:')
    ? originalSubject
    : `Re: ${originalSubject}`;

  // Reply-to goes to the original sender
  let to = originalFrom;

  // Extract bare email from "Name <email>" or plain "email"
  const extractEmail = (addr: string): string => {
    const match = addr.match(/<([^>]+)>/);
    return (match ? match[1] : addr).trim().toLowerCase();
  };

  // Build CC: merge reply-all recipients + user-provided cc, deduplicated
  const ccParts: string[] = [];
  const seen = new Set<string>();
  seen.add(resolved.email.toLowerCase()); // exclude self
  if (opts.from) {
    const parsed = parseFromAddress(opts.from);
    seen.add(parsed.email.toLowerCase());
  }

  if (opts.reply_all) {
    for (const addr of [originalTo, originalCc].filter(Boolean).join(', ').split(',').map(a => a.trim()).filter(a => a.length > 0)) {
      const email = extractEmail(addr);
      if (!seen.has(email)) {
        seen.add(email);
        ccParts.push(addr);
      }
    }
  }

  if (opts.cc) {
    for (const addr of opts.cc.split(',').map(a => a.trim()).filter(a => a.length > 0)) {
      const email = extractEmail(addr);
      if (!seen.has(email)) {
        seen.add(email);
        ccParts.push(addr);
      }
    }
  }

  const cc = ccParts.length > 0 ? ccParts.join(', ') : undefined;

  // Build References header: append original Message-ID
  const references = originalReferences
    ? `${originalReferences} ${originalMessageId}`
    : originalMessageId;

  const raw = buildRawMessage({
    from,
    to,
    cc,
    bcc: opts.bcc,
    subject,
    body: opts.body,
    is_html: opts.is_html,
    in_reply_to: originalMessageId,
    references,
  });

  const response = await withRetry(() =>
    gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw,
        threadId: original.data.threadId || undefined,
      },
    })
  );

  return {
    id: response.data.id || '',
    threadId: response.data.threadId || '',
    labelIds: response.data.labelIds || [],
  };
}

/**
 * Create a draft reply to an existing message.
 * Same threading logic as replyToMessage, but creates a draft instead of sending.
 * The draft appears in Gmail for user review before sending.
 */
export async function createDraftReply(opts: {
  messageId: string;
  body: string;
  account?: string;
  from?: string;
  is_html?: boolean;
  reply_all?: boolean;
  cc?: string;
  bcc?: string;
}): Promise<DraftResult> {
  const resolved = gmailDeps.resolveAccount(opts.account);
  const gmail = await gmailDeps.getGmailClient(resolved);
  const from = await resolveSender(resolved, opts.from);

  // Fetch the original message to get threading headers
  const original = await withRetry(() =>
    gmail.users.messages.get({
      userId: 'me',
      id: opts.messageId,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Message-ID', 'References'],
    })
  );

  const headers = original.data.payload?.headers || [];
  const originalFrom = extractHeader(headers, 'From');
  const originalTo = extractHeader(headers, 'To');
  const originalCc = extractHeader(headers, 'Cc');
  const originalSubject = extractHeader(headers, 'Subject');
  const originalMessageId = extractHeader(headers, 'Message-ID');
  const originalReferences = extractHeader(headers, 'References');

  const subject = originalSubject.startsWith('Re:')
    ? originalSubject
    : `Re: ${originalSubject}`;

  const to = originalFrom;

  const extractEmail = (addr: string): string => {
    const match = addr.match(/<([^>]+)>/);
    return (match ? match[1] : addr).trim().toLowerCase();
  };

  const ccParts: string[] = [];
  const seen = new Set<string>();
  seen.add(resolved.email.toLowerCase());
  if (opts.from) {
    const parsed = parseFromAddress(opts.from);
    seen.add(parsed.email.toLowerCase());
  }

  if (opts.reply_all) {
    for (const addr of [originalTo, originalCc].filter(Boolean).join(', ').split(',').map(a => a.trim()).filter(a => a.length > 0)) {
      const email = extractEmail(addr);
      if (!seen.has(email)) {
        seen.add(email);
        ccParts.push(addr);
      }
    }
  }

  if (opts.cc) {
    for (const addr of opts.cc.split(',').map(a => a.trim()).filter(a => a.length > 0)) {
      const email = extractEmail(addr);
      if (!seen.has(email)) {
        seen.add(email);
        ccParts.push(addr);
      }
    }
  }

  const cc = ccParts.length > 0 ? ccParts.join(', ') : undefined;

  const references = originalReferences
    ? `${originalReferences} ${originalMessageId}`
    : originalMessageId;

  const raw = buildRawMessage({
    from,
    to,
    cc,
    bcc: opts.bcc,
    subject,
    body: opts.body,
    is_html: opts.is_html,
    in_reply_to: originalMessageId,
    references,
  });

  const response = await withRetry(() =>
    gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: {
          raw,
          threadId: original.data.threadId || undefined,
        },
      },
    })
  );

  return {
    draft_id: response.data.id || '',
    message: {
      id: response.data.message?.id || '',
      threadId: response.data.message?.threadId || '',
    },
  };
}

/**
 * Send an existing draft by its draft ID.
 */
export async function sendDraft(opts: {
  draftId: string;
  account?: string;
}): Promise<SendResult> {
  const gmail = await getGmailClient(opts.account);

  const response = await withRetry(() =>
    gmail.users.drafts.send({
      userId: 'me',
      requestBody: {
        id: opts.draftId,
      },
    })
  );

  return {
    id: response.data.id || '',
    threadId: response.data.threadId || '',
    labelIds: response.data.labelIds || [],
  };
}
