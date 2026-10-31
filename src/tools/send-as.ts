import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listSendAs } from '../gmail/client.js';

export const listSendAsParams = {
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

export function registerListSendAs(server: McpServer): void {
  server.tool(
    'list_send_as',
    'List verified send-as aliases for an account. Wraps users.settings.sendAs.list and returns sendAsEmail, displayName, isDefault, and verificationStatus.',
    listSendAsParams,
    async ({ account }) => {
      try {
        const results = await listSendAs({
          account: account ?? undefined,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(results, null, 2),
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
