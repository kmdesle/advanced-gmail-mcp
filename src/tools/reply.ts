import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { replyToMessage } from '../gmail/client.js';

export const replyEmailParams = {
  message_id: z.string().describe('The Gmail message ID to reply to'),
  body: z.string().describe('Reply body content'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
  from: z.string().optional().describe('Sender address (email or "Display Name <email>"). Must match the account or a verified send-as alias.'),
  is_html: z.boolean().optional().describe('Whether the body is HTML (default: false, sends as plain text)'),
  reply_all: z.boolean().optional().describe('Reply to all recipients (default: false, replies only to sender)'),
  cc: z.string().optional().describe('CC recipients (comma-separated). Merged with reply-all CCs if both provided.'),
  bcc: z.string().optional().describe('BCC recipients (comma-separated)'),
};

export function registerReplyEmail(server: McpServer): void {
  server.tool(
    'reply_email',
    'Reply to an existing email. Fetches original message for proper threading (In-Reply-To, References, threadId). Supports reply-all.',
    replyEmailParams,
    async ({ message_id, body, account, from, is_html, reply_all, cc, bcc }) => {
      try {
        const result = await replyToMessage({
          messageId: message_id,
          body,
          account: account ?? undefined,
          from: from ?? undefined,
          is_html: is_html ?? undefined,
          reply_all: reply_all ?? undefined,
          cc: cc ?? undefined,
          bcc: bcc ?? undefined,
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
