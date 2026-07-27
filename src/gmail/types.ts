/**
 * Shared types for the Gmail MCP server.
 */

/** Summary of an email for list/search results. */
export interface EmailSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  labels: string[];
  isUnread: boolean;
}

/** Full email with body content. */
export interface EmailFull {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  date: string;
  body_text: string;
  body_html: string;
  labels: string[];
  attachments: AttachmentInfo[];
}

/** Attachment metadata (no content). */
export interface AttachmentInfo {
  filename: string;
  mimeType: string;
  size: number;
}

/** Thread with its messages. */
export interface ThreadInfo {
  id: string;
  messages: ThreadMessage[];
}

/** A message within a thread (lighter than EmailFull). */
export interface ThreadMessage {
  id: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  body_text: string;
  snippet: string;
  labels: string[];
}

/** Label metadata. */
export interface LabelInfo {
  id: string;
  name: string;
  type: string;
  messagesTotal: number;
  messagesUnread: number;
}

/** Send/draft message input. */
export interface ComposeInput {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  is_html?: boolean;
}

/** Reply message input. */
export interface ReplyInput {
  message_id: string;
  body: string;
  is_html?: boolean;
  reply_all?: boolean;
  cc?: string;
  bcc?: string;
}

/** Result from send/draft operations. */
export interface SendResult {
  id: string;
  threadId: string;
  labelIds: string[];
}

/** Result from draft creation. */
export interface DraftResult {
  draft_id: string;
  message: {
    id: string;
    threadId: string;
  };
}

/** Result from modify operations. */
export interface ModifyResult {
  success: boolean;
  id: string;
  labels?: string[];
}

/** Result from batch operations. */
export interface BatchResult {
  success: boolean;
  modified_count: number;
  message_ids: string[];
}

/**
 * Lightweight preview of a bulk query: a real count (via ID-only pagination,
 * capped) + a small sample. Despite the field name, estimated_count is an
 * exact count up to the cap — Gmail's own resultSizeEstimate was found to be
 * unreliable (it echoed the requested page size, not the true match count).
 */
export interface BulkPreviewResult {
  query: string;
  estimated_count: number;
  count_is_capped: boolean;
  sample: EmailSummary[];
  top_senders: Array<{ from: string; count: number }>;
}

/** Result from a bulk sweep execution. */
export interface BulkExecuteResult {
  success: boolean;
  query: string;
  action: 'archive' | 'label';
  modified_count: number;
  batches: number;
}

/** A Gmail filter's criteria. */
export interface FilterCriteria {
  from?: string | null;
  to?: string | null;
  subject?: string | null;
  query?: string | null;
  hasAttachment?: boolean | null;
  excludeChats?: boolean | null;
  size?: number | null;
  sizeComparison?: string | null;
}

/** A Gmail filter's action. */
export interface FilterAction {
  addLabelIds?: string[] | null;
  removeLabelIds?: string[] | null;
  forward?: string | null;
}

/** A Gmail filter (rule). */
export interface FilterInfo {
  id: string;
  criteria: FilterCriteria;
  action: FilterAction;
}

/** OAuth token shape stored on disk. */
export interface StoredToken {
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: string;
  expiry_date: number;
}
