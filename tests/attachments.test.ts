import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it, mock } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gmailDeps } from '../src/gmail/client.js';
import { registerAllTools } from '../src/tools/index.js';

const CONTENT = Buffer.from('mock attachment bytes');
const TOO_LARGE = Buffer.alloc(25 * 1024 * 1024 + 1).toString('base64url');
const account = { email: 'test@example.com', alias: 'test' };

function part(filename: string, attachmentId: string, size = CONTENT.length) {
  return { filename, mimeType: 'application/pdf', partId: `part-${attachmentId}`, body: { attachmentId, size } };
}

function resultText(result: { content?: unknown }): string {
  return (Array.isArray(result.content) ? result.content : [])
    .map(item => item && typeof item === 'object' && 'text' in item ? String(item.text) : '').join('\n');
}

describe('download_attachment', { concurrency: false }, () => {
  let tempDirectory: string;
  let client: Client;
  let server: McpServer;
  let attachmentPayload = part('statement.pdf', 'att-1');
  let attachmentData = CONTENT.toString('base64url');
  let installed: ReturnType<typeof mock.method>;
  let messageInstalled: ReturnType<typeof mock.method>;

  before(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'gmail-attachment-test-'));
    const gmail = { users: { messages: {
      get: mock.fn(async () => ({ data: { id: 'msg-1', payload: { mimeType: 'multipart/mixed', body: {}, parts: [attachmentPayload] } } })),
      attachments: { get: mock.fn(async () => ({ data: { data: attachmentData } })) },
    } } };
    installed = mock.method(gmailDeps, 'getGmailClient', async () => gmail as never);
    messageInstalled = mock.method(gmailDeps, 'getMessage', async () => ({
      id: 'msg-1', threadId: 'thread-1', from: '', to: '', cc: '', bcc: '', subject: '', date: '',
      body_text: '', body_html: '', labels: [],
      attachments: [{ filename: 'ids.pdf', mimeType: 'application/pdf', size: CONTENT.length, attachment_id: 'att-id-check', part_id: 'part-att-id-check' }],
    }));
    server = new McpServer({ name: 'gmail-attachment-test', version: '1.0.0' }, { capabilities: { tools: {} } });
    registerAllTools(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'gmail-attachment-client', version: '1.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  after(async () => {
    await client.close();
    await server.close();
    installed.mock.restore();
    messageInstalled.mock.restore();
    await rm(tempDirectory, { recursive: true, force: true });
  });

  async function call(args: Record<string, unknown>) {
    return client.callTool({ name: 'download_attachment', arguments: { message_id: 'msg-1', dest_dir: tempDirectory, ...args } });
  }

  it('downloads by attachment id with metadata only and mode 0600', async () => {
    const result = await call({ attachment_id: 'att-1' });
    assert.notEqual(result.isError, true, resultText(result));
    const value = JSON.parse(resultText(result));
    assert.equal(value.size, CONTENT.length);
    assert.equal(value.mimeType, 'application/pdf');
    assert.match(value.sha256, /^[a-f0-9]{64}$/);
    assert.equal(await readFile(value.path, 'utf8'), CONTENT.toString());
    assert.equal((await stat(value.path)).mode & 0o777, 0o600);
    assert.doesNotMatch(resultText(result), /mock attachment bytes/);
  });

  it('read_email includes attachment_id and part_id', async () => {
    attachmentPayload = part('ids.pdf', 'att-id-check');
    const result = await client.callTool({ name: 'read_email', arguments: { message_id: 'msg-1' } });
    assert.notEqual(result.isError, true, resultText(result));
    const value = JSON.parse(resultText(result));
    assert.equal(value.attachments[0].attachment_id, 'att-id-check');
    assert.equal(value.attachments[0].part_id, 'part-att-id-check');
  });

  it('downloads by a unique exact filename', async () => {
    attachmentPayload = part('by-name.pdf', 'att-name');
    const result = await call({ filename: 'by-name.pdf' });
    assert.notEqual(result.isError, true);
    assert.match(resultText(result), /by-name\.pdf/);
  });

  it('rejects ambiguous and missing matches', async () => {
    attachmentPayload = { ...part('duplicate.pdf', 'att-a'), parts: [part('duplicate.pdf', 'att-b')] };
    const ambiguous = await call({ filename: 'duplicate.pdf' });
    assert.equal(ambiguous.isError, true);
    assert.match(resultText(ambiguous), /ambiguous/i);
    const missing = await call({ attachment_id: 'nope' });
    assert.equal(missing.isError, true);
    assert.match(resultText(missing), /not found/i);
  });

  it('rejects traversal filenames', async () => {
    attachmentPayload = part('../escape.txt', 'att-traversal');
    const result = await call({ attachment_id: 'att-traversal' });
    assert.equal(result.isError, true);
    assert.match(resultText(result), /traversal/i);
    assert.equal((await readdir(tempDirectory)).some(name => name === 'escape.txt'), false);
  });

  it('uses a numeric suffix rather than overwriting an existing file', async () => {
    attachmentPayload = part('statement.pdf', 'att-existing');
    await writeFile(join(tempDirectory, 'statement.pdf'), 'keep me');
    const result = await call({ attachment_id: 'att-existing' });
    assert.notEqual(result.isError, true);
    assert.match(resultText(result), /statement \(1\)\.pdf/);
    assert.equal(await readFile(join(tempDirectory, 'statement.pdf'), 'utf8'), 'keep me');
  });

  it('rejects metadata or downloaded content over 25 MB', async () => {
    attachmentPayload = part('huge.bin', 'att-huge', 25 * 1024 * 1024 + 1);
    const result = await call({ attachment_id: 'att-huge' });
    assert.equal(result.isError, true);
    assert.match(resultText(result), /25 MB/);
    attachmentPayload = part('huge.bin', 'att-huge-bytes', CONTENT.length);
    attachmentData = TOO_LARGE;
    const contentResult = await call({ attachment_id: 'att-huge-bytes' });
    assert.equal(contentResult.isError, true);
    assert.match(resultText(contentResult), /25 MB/);
    attachmentData = CONTENT.toString('base64url');
  });
});

