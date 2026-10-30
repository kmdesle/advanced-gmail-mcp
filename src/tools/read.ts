import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gmailDeps } from '../gmail/client.js';

export const readEmailParams = {
  message_id: z.string().describe('The Gmail message ID to read'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
  format: z.enum(['full', 'metadata', 'minimal']).optional().describe('Response format: full (default), metadata, or minimal'),
};

export function registerReadEmail(server: McpServer): void {
  server.tool(
    'read_email',
    'Read a single email by message ID. Returns full content including body, headers, labels, and attachment metadata.',
    readEmailParams,
    async ({ message_id, account, format }) => {
      try {
        const result = await gmailDeps.getMessage({
          messageId: message_id,
          account: account ?? undefined,
          format: (format as 'full' | 'metadata' | 'minimal') ?? undefined,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
