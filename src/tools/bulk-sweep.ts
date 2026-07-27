import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { previewBulkQuery, bulkModifyByQuery } from '../gmail/client.js';

export const bulkPreviewParams = {
  query: z.string().describe('Gmail search query (e.g. "category:promotions older_than:1y", "from:notifications@example.com")'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
  sample_size: z.number().optional().describe('How many sample messages to fetch for review (default 15, max 50). Does not fetch metadata for the full match set — use estimated_count for scale.'),
};

export function registerBulkPreview(server: McpServer): void {
  server.tool(
    'bulk_preview',
    'Preview a bulk query before acting on it: returns a real total count (via cheap ID-only pagination, capped at 20,000 — check count_is_capped), a small sample of matching messages, and a sample-based top-senders breakdown. Always call this before bulk_execute — never guess at scale.',
    bulkPreviewParams,
    async ({ query, account, sample_size }) => {
      try {
        const result = await previewBulkQuery({
          query,
          account: account ?? undefined,
          sampleSize: sample_size ?? undefined,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}

export const bulkExecuteParams = {
  query: z.string().describe('Gmail search query — same query that was just previewed with bulk_preview.'),
  action: z.enum(['archive', 'label']).describe('archive removes INBOX; label adds/removes labels without archiving (pass add_labels/remove_labels).'),
  add_labels: z.array(z.string()).optional().describe('Label IDs to add (label action, or combined with archive to also file into a folder).'),
  remove_labels: z.array(z.string()).optional().describe('Label IDs to remove (label action).'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
  confirmed: z.boolean().describe('Must be explicitly true. This is a safety interlock — the caller must have shown the user a bulk_preview result and gotten explicit approval before setting this.'),
  max_messages: z.number().optional().describe('Safety cap on how many messages this call will touch (default 50000).'),
};

export function registerBulkExecute(server: McpServer): void {
  server.tool(
    'bulk_execute',
    'Execute a bulk action (archive, or add/remove labels) against every message matching a query, in batches of 1000. Requires confirmed=true — never call this without first calling bulk_preview and getting the user\'s explicit go-ahead on what it showed.',
    bulkExecuteParams,
    async ({ query, action, add_labels, remove_labels, account, confirmed, max_messages }) => {
      try {
        if (!confirmed) {
          return {
            content: [{ type: 'text' as const, text: 'Error: confirmed must be true. Call bulk_preview first, show the user the result, and only pass confirmed=true after they explicitly approve.' }],
            isError: true,
          };
        }

        const addLabelIds = action === 'archive'
          ? [...(add_labels ?? [])]
          : (add_labels ?? undefined);
        const removeLabelIds = action === 'archive'
          ? ['INBOX', ...(remove_labels ?? [])]
          : (remove_labels ?? undefined);

        const result = await bulkModifyByQuery({
          query,
          account: account ?? undefined,
          addLabelIds,
          removeLabelIds,
          maxMessages: max_messages ?? undefined,
        });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true, query, action, ...result }, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
