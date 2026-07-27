import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createFilter, listFilters } from '../gmail/client.js';

const criteriaSchema = z.object({
  from: z.string().optional().describe('Sender address or domain to match'),
  to: z.string().optional(),
  subject: z.string().optional(),
  query: z.string().optional().describe('Additional Gmail search syntax to match'),
  hasAttachment: z.boolean().optional(),
  excludeChats: z.boolean().optional(),
});

const actionSchema = z.object({
  addLabelIds: z.array(z.string()).optional().describe('Label IDs to apply to matching mail (e.g. archive it out of INBOX by omitting INBOX, or route to a folder label)'),
  removeLabelIds: z.array(z.string()).optional().describe('Label IDs to remove — pass ["INBOX"] here to auto-archive on arrival'),
  forward: z.string().optional(),
});

export const createFilterParams = {
  criteria: criteriaSchema.describe('What incoming mail this filter matches'),
  action: actionSchema.describe('What happens to matching mail'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

export function registerCreateFilter(server: McpServer): void {
  server.tool(
    'create_filter',
    'Create a Gmail filter (server-side rule) that applies automatically to future incoming mail matching the criteria — e.g. auto-archive and label everything from a recurring sender. This is the durable fix for recurring senders, not a one-time archive. Requires the gmail.settings.basic OAuth scope; if this errors with a permission/scope error, the account needs to re-run `npx tsx src/auth.ts <alias>` to re-consent with the updated scope list.',
    createFilterParams,
    async ({ criteria, action, account }) => {
      try {
        const result = await createFilter({ criteria, action, account: account ?? undefined });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}

export const listFiltersParams = {
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

export function registerListFilters(server: McpServer): void {
  server.tool(
    'list_filters',
    'List all existing Gmail filters (rules) for an account. Check this before proposing a new filter to avoid duplicates.',
    listFiltersParams,
    async ({ account }) => {
      try {
        const result = await listFilters({ account: account ?? undefined });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
