import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { downloadAttachment } from '../gmail/client.js';

export const downloadAttachmentParams = {
  message_id: z.string().describe('The Gmail message ID containing the attachment'),
  attachment_id: z.string().optional().describe('Gmail attachment ID returned by read_email'),
  filename: z.string().optional().describe('Exact attachment filename; must uniquely match the message'),
  dest_dir: z.string().describe('Absolute path to an existing destination directory'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

export function registerDownloadAttachment(server: McpServer): void {
  server.tool(
    'download_attachment',
    'Save one attachment from a message into an existing local directory. Returns path, size, MIME type, and SHA-256; attachment bytes are not returned.',
    downloadAttachmentParams,
    async ({ message_id, attachment_id, filename, dest_dir, account }) => {
      try {
        const result = await downloadAttachment({
          messageId: message_id,
          attachmentId: attachment_id,
          filename,
          destDir: dest_dir,
          account,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
