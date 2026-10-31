import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createDraft } from '../gmail/client.js';

export const draftEmailParams = {
  to: z.string().describe('Recipient email address'),
  subject: z.string().describe('Email subject line'),
  body: z.string().describe('Email body content'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
  from: z.string().optional().describe('Sender address (email or "Display Name <email>"). Must match the account or a verified send-as alias.'),
  cc: z.string().optional().describe('CC recipients (comma-separated)'),
  bcc: z.string().optional().describe('BCC recipients (comma-separated)'),
  is_html: z.boolean().optional().describe('Whether the body is HTML (default: false, sends as plain text)'),
};

export function registerDraftEmail(server: McpServer): void {
  server.tool(
    'draft_email',
    'Create a draft email. Returns the draft ID and message info.',
    draftEmailParams,
    async ({ to, subject, body, account, from, cc, bcc, is_html }) => {
      try {
        const result = await createDraft({
          to,
          subject,
          body,
          account: account ?? undefined,
          from: from ?? undefined,
          cc: cc ?? undefined,
          bcc: bcc ?? undefined,
          is_html: is_html ?? undefined,
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
