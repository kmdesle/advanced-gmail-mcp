import assert from 'node:assert/strict';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it, mock } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  startMcpHttpServer,
  type RunningMcpHttpServer,
} from '../src/server.js';

const TOKEN = 'integration-test-token';
const RESPONSE_MARKER = 'mock-gmail-label-response';
const REQUEST_MARKER = 'mock-gmail-account-request';

interface HttpResponse {
  status: number;
  body: string;
}

function get(
  port: number,
  headers: Record<string, string> = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/health',
      method: 'GET',
      headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });

    req.on('error', reject);
    req.end();
  });
}

describe('authenticated Streamable HTTP server', { concurrency: false }, () => {
  let tempDirectory: string;
  let tokenFile: string;
  let service: RunningMcpHttpServer;
  const requestLogs: string[] = [];
  const listLabels = mock.fn(async (account?: string) => [{
    id: 'MOCK_LABEL',
    name: `${RESPONSE_MARKER}:${account ?? 'default'}`,
  }]);

  before(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'gmail-mcp-http-test-'));
    tokenFile = join(tempDirectory, 'token.txt');
    await writeFile(tokenFile, TOKEN, 'utf8');

    service = await startMcpHttpServer({
      port: 0,
      tokenFile,
      logRequest: (line) => requestLogs.push(line),
      createMcpServer: () => {
        const server = new McpServer({ name: 'gmail-mcp-test', version: '1.0.0' });
        server.tool(
          'get_labels',
          'Return labels from the mocked Gmail API layer.',
          { account: z.string().optional() },
          async ({ account }) => {
            const labels = await listLabels(account);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(labels) }],
            };
          },
        );
        return server;
      },
    });
  });

  after(async () => {
    await service.close();
    await unlink(tokenFile);
    await rmdir(tempDirectory);
  });

  it('returns 401 when Authorization is missing', async () => {
    const response = await get(service.port);
    assert.equal(response.status, 401);
  });

  it('returns 401 when the bearer token is wrong', async () => {
    const response = await get(service.port, {
      Authorization: 'Bearer wrong-token',
    });
    assert.equal(response.status, 401);
  });

  it('returns 403 when Host is not the exact loopback authority', async () => {
    const response = await get(service.port, {
      Authorization: `Bearer ${TOKEN}`,
      Host: `localhost:${service.port}`,
    });
    assert.equal(response.status, 403);
  });

  it('returns 403 when any Origin header is present', async () => {
    const response = await get(service.port, {
      Authorization: `Bearer ${TOKEN}`,
      Origin: 'http://127.0.0.1',
    });
    assert.equal(response.status, 403);
  });

  it('allows valid health and MCP tool requests to reach the mocked Gmail layer', async () => {
    const health = await get(service.port, {
      Authorization: `Bearer ${TOKEN}`,
    });
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true });

    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${service.port}/mcp`),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${TOKEN}` },
        },
      },
    );
    const client = new Client({ name: 'gmail-mcp-test-client', version: '1.0.0' });

    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: 'get_labels',
        arguments: { account: REQUEST_MARKER },
      });

      assert.equal(listLabels.mock.callCount(), 1);
      assert.match(JSON.stringify(result.content), new RegExp(RESPONSE_MARKER));
      await transport.terminateSession();
    } finally {
      await client.close();
    }

    assert.ok(requestLogs.length >= 8);
    for (const line of requestLogs) {
      assert.match(
        line,
        /^\d{4}-\d{2}-\d{2}T[^ ]+ method=[A-Z]+ path=\/[^ ]* status=\d{3} duration_ms=\d+\.\d{3}$/,
      );
      assert.doesNotMatch(line, new RegExp(TOKEN));
      assert.doesNotMatch(line, new RegExp(REQUEST_MARKER));
      assert.doesNotMatch(line, new RegExp(RESPONSE_MARKER));
      assert.doesNotMatch(line, /authorization|origin|host/i);
    }
  });
});
