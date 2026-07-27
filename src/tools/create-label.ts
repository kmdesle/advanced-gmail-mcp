import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createLabel } from '../gmail/client.js';

export const createLabelParams = {
  name: z.string().describe('Label name, e.g. "Receipts" or "Newsletters/Substack". Use "/" for nested labels.'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

export function registerCreateLabel(server: McpServer): void {
  server.tool(
    'create_label',
    'Create a new Gmail label (folder). Check get_labels first to avoid creating a duplicate of an existing one.',
    createLabelParams,
    async ({ name, account }) => {
      try {
        const result = await createLabel({ name, account: account ?? undefined });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
