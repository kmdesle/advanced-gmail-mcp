import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  createServer as createNodeHttpServer,
  type IncomingMessage,
  type Server as NodeHttpServer,
  type ServerResponse,
} from 'node:http';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { registerAllTools } from './tools/index.js';

const LOOPBACK_HOST = '127.0.0.1';
const MCP_PATH = '/mcp';
const HEALTH_PATH = '/health';

type RequestLogger = (line: string) => void;
type McpServerFactory = () => McpServer;

interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export interface StartMcpHttpServerOptions {
  port: number;
  tokenFile: string;
  createMcpServer?: McpServerFactory;
  logRequest?: RequestLogger;
}

export interface RunningMcpHttpServer {
  readonly port: number;
  close(): Promise<void>;
}

function createGmailMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: 'gmail-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  registerAllTools(server);
  return server;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function requestPath(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`).pathname;
  } catch {
    return '/';
  }
}

function attachRequestLog(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  logRequest: RequestLogger,
): void {
  const startedAt = process.hrtime.bigint();
  let logged = false;

  const log = (): void => {
    if (logged) return;
    logged = true;
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    logRequest(
      `${new Date().toISOString()} method=${req.method ?? 'UNKNOWN'} path=${path} ` +
      `status=${res.statusCode} duration_ms=${durationMs.toFixed(3)}`,
    );
  };

  res.once('finish', log);
  res.once('close', log);
}

function authorizeRequest(
  req: IncomingMessage,
  expectedTokenHash: Buffer,
  expectedHost: string,
): 401 | 403 | null {
  const authorization = req.headers.authorization;
  const bearerMatch = typeof authorization === 'string'
    ? /^Bearer ([^\s]+)$/.exec(authorization)
    : null;

  if (!bearerMatch) return 401;

  const providedTokenHash = createHash('sha256').update(bearerMatch[1], 'utf8').digest();
  if (!timingSafeEqual(providedTokenHash, expectedTokenHash)) return 401;

  if (req.headers.host !== expectedHost) return 403;
  if (Object.prototype.hasOwnProperty.call(req.headers, 'origin')) return 403;

  return null;
}

async function readJsonRequest(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function closeNodeServer(server: NodeHttpServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('MCP_HTTP_PORT must be an integer between 1 and 65535.');
  }
}

async function readExpectedTokenHash(tokenFile: string): Promise<Buffer> {
  let expectedToken: string;
  try {
    expectedToken = await readFile(tokenFile, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read MCP_TOKEN_FILE "${tokenFile}": ${message}`);
  }

  if (expectedToken.length === 0) {
    throw new Error(`MCP_TOKEN_FILE "${tokenFile}" is empty.`);
  }

  return createHash('sha256').update(expectedToken, 'utf8').digest();
}

export async function startMcpHttpServer(
  options: StartMcpHttpServerOptions,
): Promise<RunningMcpHttpServer> {
  validatePort(options.port);
  if (!options.tokenFile) throw new Error('MCP_TOKEN_FILE is required.');

  // Read and hash the token once, before the HTTP socket is opened.
  const expectedTokenHash = await readExpectedTokenHash(options.tokenFile);
  const createMcpServer = options.createMcpServer ?? createGmailMcpServer;
  const logRequest = options.logRequest ?? ((line: string) => process.stderr.write(`${line}\n`));
  const sessions = new Map<string, McpSession>();
  let boundPort: number | undefined;
  let closing = false;

  const httpServer = createNodeHttpServer((req, res) => {
    const path = requestPath(req);
    attachRequestLog(req, res, path, logRequest);

    void (async () => {
      try {
        if (boundPort === undefined) {
          writeJson(res, 503, { error: 'Server is starting' });
          return;
        }

        const authStatus = authorizeRequest(
          req,
          expectedTokenHash,
          `${LOOPBACK_HOST}:${boundPort}`,
        );
        if (authStatus !== null) {
          if (authStatus === 401) res.setHeader('WWW-Authenticate', 'Bearer');
          writeJson(res, authStatus, { error: authStatus === 401 ? 'Unauthorized' : 'Forbidden' });
          return;
        }

        if (path === HEALTH_PATH && req.method === 'GET') {
          writeJson(res, 200, { ok: true });
          return;
        }

        if (path !== MCP_PATH) {
          writeJson(res, 404, { error: 'Not found' });
          return;
        }

        const sessionIdHeader = req.headers['mcp-session-id'];
        const sessionId = typeof sessionIdHeader === 'string' ? sessionIdHeader : undefined;
        if (sessionId) {
          const session = sessions.get(sessionId);
          if (!session) {
            writeJson(res, 404, {
              jsonrpc: '2.0',
              error: { code: -32001, message: 'Session not found' },
              id: null,
            });
            return;
          }

          await session.transport.handleRequest(req, res);
          return;
        }

        if (req.method !== 'POST') {
          writeJson(res, 400, {
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Missing MCP session ID' },
            id: null,
          });
          return;
        }

        let body: unknown;
        try {
          body = await readJsonRequest(req);
        } catch {
          writeJson(res, 400, {
            jsonrpc: '2.0',
            error: { code: -32700, message: 'Invalid JSON' },
            id: null,
          });
          return;
        }

        if (!isInitializeRequest(body)) {
          writeJson(res, 400, {
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Expected an initialize request' },
            id: null,
          });
          return;
        }

        let mcpServer: McpServer;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (initializedSessionId) => {
            sessions.set(initializedSessionId, { server: mcpServer, transport });
          },
        });

        transport.onclose = () => {
          const closedSessionId = transport.sessionId;
          if (closedSessionId) sessions.delete(closedSessionId);
        };

        mcpServer = createMcpServer();
        await mcpServer.connect(transport);
        try {
          await transport.handleRequest(req, res, body);
        } finally {
          if (!transport.sessionId) await mcpServer.close();
        }
      } catch {
        if (!res.headersSent) {
          writeJson(res, 500, {
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          });
        } else if (!res.writableEnded) {
          res.destroy();
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    httpServer.once('error', onError);
    httpServer.listen(options.port, LOOPBACK_HOST, () => {
      httpServer.off('error', onError);
      const address = httpServer.address();
      if (!address || typeof address === 'string') {
        reject(new Error('HTTP server did not bind to a TCP port.'));
        return;
      }
      boundPort = address.port;
      resolve();
    });
  });

  return {
    get port(): number {
      return boundPort!;
    },
    async close(): Promise<void> {
      if (closing) return;
      closing = true;

      await Promise.allSettled(
        Array.from(sessions.values(), ({ server }) => server.close()),
      );
      sessions.clear();
      await closeNodeServer(httpServer);
    },
  };
}

function requiredEnvironmentVariable(name: 'MCP_HTTP_PORT' | 'MCP_TOKEN_FILE'): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parseEnvironmentPort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error('MCP_HTTP_PORT must be an integer between 1 and 65535.');
  }

  const port = Number(value);
  if (port < 1 || port > 65_535) {
    throw new Error('MCP_HTTP_PORT must be an integer between 1 and 65535.');
  }
  return port;
}

async function main(): Promise<void> {
  const port = parseEnvironmentPort(requiredEnvironmentVariable('MCP_HTTP_PORT'));
  const tokenFile = requiredEnvironmentVariable('MCP_TOKEN_FILE');
  await startMcpHttpServer({ port, tokenFile });
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Failed to start gmail-mcp server: ${message}\n`);
    process.exitCode = 1;
  });
}
