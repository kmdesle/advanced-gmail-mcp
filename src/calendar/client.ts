import { google, type Auth, type calendar_v3 } from 'googleapis';
import type { AccountConfig } from '../config.js';
import { resolveAccount } from '../config.js';
import { getSharedAuthClient } from '../gmail/client.js';

export type CalendarSendUpdates = 'none' | 'all' | 'externalOnly';

const DEFAULT_SEND_UPDATES: CalendarSendUpdates = 'none';

export interface CalendarSummary {
  id: string;
  summary: string;
  description: string;
  primary: boolean;
  accessRole: string;
  timeZone: string;
}

export interface CalendarEventAttendee {
  email: string;
  responseStatus: string;
}

export interface CalendarEventInfo {
  id: string;
  summary: string;
  description: string;
  location: string;
  status: string;
  htmlLink: string;
  start: calendar_v3.Schema$EventDateTime | null;
  end: calendar_v3.Schema$EventDateTime | null;
  attendees: CalendarEventAttendee[];
}

export interface FreeBusyResult {
  timeMin: string;
  timeMax: string;
  calendars: calendar_v3.Schema$FreeBusyResponse['calendars'];
}

/**
 * Test seam. Production uses the shared Gmail OAuth2 client and calendar v3.
 * Tests replace these methods so no token file is read and no request is sent.
 */
export const calendarDeps = {
  resolveAccount,
  getAuthClient(account: AccountConfig): Promise<Auth.OAuth2Client> {
    return getSharedAuthClient(account);
  },
  createCalendar(auth: Auth.OAuth2Client): calendar_v3.Calendar {
    return google.calendar({ version: 'v3', auth });
  },
};

/**
 * Attendees make this a message to other people. Require an explicit
 * sendUpdates so "none" is a choice the caller made, not a silent email.
 * With no attendees, omit sendUpdates and the API is called with "none".
 */
export function resolveSendUpdates(opts: {
  attendees?: string[];
  sendUpdates?: CalendarSendUpdates;
}): CalendarSendUpdates {
  const hasAttendees = (opts.attendees?.length ?? 0) > 0;
  if (hasAttendees && opts.sendUpdates === undefined) {
    throw new Error(
      'sendUpdates is required when attendees are set. Pass "none", "all", or "externalOnly". ' +
      'No default is applied in this case, so guests are not emailed unless you choose a value.',
    );
  }
  return opts.sendUpdates ?? DEFAULT_SEND_UPDATES;
}

export function missingCalendarScopeMessage(account: AccountConfig): string {
  return (
    `Calendar scope is not granted for ${account.email} (${account.alias}). ` +
    `Re-run \`npm run auth\` for that account: npm run auth -- ${account.alias}`
  );
}

function statusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const obj = err as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  for (const candidate of [obj.code, obj.status, obj.response?.status]) {
    if (typeof candidate === 'number') return candidate;
    if (typeof candidate === 'string' && /^\d+$/.test(candidate)) return Number(candidate);
  }
  return undefined;
}

function scopeErrorText(err: unknown): string {
  if (!(typeof err === 'object' && err !== null)) {
    return err instanceof Error ? err.message : String(err);
  }
  const obj = err as {
    message?: unknown;
    errors?: Array<{ reason?: string; message?: string }>;
    response?: {
      data?: {
        error?: {
          message?: string;
          status?: string;
          errors?: Array<{ reason?: string; message?: string }>;
          details?: Array<{ reason?: string }>;
        };
      };
    };
  };
  const parts = [
    err instanceof Error ? err.message : undefined,
    typeof obj.message === 'string' ? obj.message : undefined,
    obj.errors?.[0]?.reason,
    obj.errors?.[0]?.message,
    obj.response?.data?.error?.message,
    obj.response?.data?.error?.status,
    obj.response?.data?.error?.errors?.[0]?.reason,
    obj.response?.data?.error?.errors?.[0]?.message,
    obj.response?.data?.error?.details?.[0]?.reason,
  ];
  return parts.filter((part): part is string => typeof part === 'string').join(' ');
}

/**
 * Google returns 403 insufficientPermissions / ACCESS_TOKEN_SCOPE_INSUFFICIENT
 * when the stored token predates calendar.events. Other 403s (a calendar the
 * account cannot see) stay as themselves.
 */
export function isMissingCalendarScopeError(err: unknown): boolean {
  if (statusOf(err) !== 403) return false;
  const text = scopeErrorText(err).toLowerCase();
  return text.includes('insufficient') || text.includes('scope');
}

async function callCalendar<T>(
  account: string | undefined,
  fn: (calendar: calendar_v3.Calendar) => Promise<T>,
): Promise<T> {
  const resolved = calendarDeps.resolveAccount(account);
  const auth = await calendarDeps.getAuthClient(resolved);
  const calendar = calendarDeps.createCalendar(auth);
  try {
    return await fn(calendar);
  } catch (err) {
    if (isMissingCalendarScopeError(err)) {
      throw new Error(missingCalendarScopeMessage(resolved));
    }
    throw err;
  }
}

function toCalendarSummary(item: calendar_v3.Schema$CalendarListEntry): CalendarSummary {
  return {
    id: item.id || '',
    summary: item.summary || '',
    description: item.description || '',
    primary: item.primary === true,
    accessRole: item.accessRole || '',
    timeZone: item.timeZone || '',
  };
}

function toCalendarEvent(event: calendar_v3.Schema$Event): CalendarEventInfo {
  return {
    id: event.id || '',
    summary: event.summary || '',
    description: event.description || '',
    location: event.location || '',
    status: event.status || '',
    htmlLink: event.htmlLink || '',
    start: event.start ?? null,
    end: event.end ?? null,
    attendees: (event.attendees || []).map(attendee => ({
      email: attendee.email || '',
      responseStatus: attendee.responseStatus || '',
    })),
  };
}

function eventBody(opts: {
  summary?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
  timezone?: string;
  attendees?: string[];
}): calendar_v3.Schema$Event {
  const body: calendar_v3.Schema$Event = {};
  if (opts.summary !== undefined) body.summary = opts.summary;
  if (opts.description !== undefined) body.description = opts.description;
  if (opts.location !== undefined) body.location = opts.location;
  if (opts.start !== undefined) body.start = { dateTime: opts.start, timeZone: opts.timezone };
  if (opts.end !== undefined) body.end = { dateTime: opts.end, timeZone: opts.timezone };
  if (opts.attendees !== undefined) {
    body.attendees = opts.attendees.map(email => ({ email }));
  }
  return body;
}

export async function listCalendars(opts?: {
  account?: string;
}): Promise<CalendarSummary[]> {
  return callCalendar(opts?.account, async calendar => {
    const response = await calendar.calendarList.list({});
    return (response.data.items || []).map(toCalendarSummary);
  });
}

/**
 * List events. Recurrences are expanded (`singleEvents`) so timeMin/timeMax
 * bound instances. One page; pass maxResults to cap it (API default 250).
 */
export async function listEvents(opts: {
  account?: string;
  calendarId?: string;
  timeMin?: string;
  timeMax?: string;
  maxResults?: number;
  query?: string;
}): Promise<CalendarEventInfo[]> {
  return callCalendar(opts.account, async calendar => {
    const response = await calendar.events.list({
      calendarId: opts.calendarId ?? 'primary',
      timeMin: opts.timeMin,
      timeMax: opts.timeMax,
      maxResults: opts.maxResults,
      q: opts.query,
      singleEvents: true,
      orderBy: 'startTime',
    });
    return (response.data.items || []).map(toCalendarEvent);
  });
}

export async function getEvent(opts: {
  eventId: string;
  account?: string;
  calendarId?: string;
}): Promise<CalendarEventInfo> {
  return callCalendar(opts.account, async calendar => {
    const response = await calendar.events.get({
      calendarId: opts.calendarId ?? 'primary',
      eventId: opts.eventId,
    });
    return toCalendarEvent(response.data);
  });
}

export async function queryFreeBusy(opts: {
  timeMin: string;
  timeMax: string;
  calendars: string[];
  account?: string;
}): Promise<FreeBusyResult> {
  return callCalendar(opts.account, async calendar => {
    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin: opts.timeMin,
        timeMax: opts.timeMax,
        items: opts.calendars.map(id => ({ id })),
      },
    });
    return {
      timeMin: response.data.timeMin || opts.timeMin,
      timeMax: response.data.timeMax || opts.timeMax,
      calendars: response.data.calendars ?? {},
    };
  });
}

export async function createEvent(opts: {
  summary: string;
  start: string;
  end: string;
  account?: string;
  calendarId?: string;
  timezone?: string;
  description?: string;
  location?: string;
  attendees?: string[];
  sendUpdates?: CalendarSendUpdates;
}): Promise<CalendarEventInfo> {
  const sendUpdates = resolveSendUpdates(opts);
  return callCalendar(opts.account, async calendar => {
    const response = await calendar.events.insert({
      calendarId: opts.calendarId ?? 'primary',
      sendUpdates,
      requestBody: eventBody(opts),
    });
    return toCalendarEvent(response.data);
  });
}

/**
 * Patch one event. Only fields the caller set are sent.
 */
export async function updateEvent(opts: {
  eventId: string;
  account?: string;
  calendarId?: string;
  summary?: string;
  start?: string;
  end?: string;
  timezone?: string;
  description?: string;
  location?: string;
  attendees?: string[];
  sendUpdates?: CalendarSendUpdates;
}): Promise<CalendarEventInfo> {
  if (opts.timezone !== undefined && opts.start === undefined && opts.end === undefined) {
    throw new Error('timezone is stored on start and end. Pass start and/or end when setting timezone.');
  }
  const sendUpdates = resolveSendUpdates(opts);
  return callCalendar(opts.account, async calendar => {
    const response = await calendar.events.patch({
      calendarId: opts.calendarId ?? 'primary',
      eventId: opts.eventId,
      sendUpdates,
      requestBody: eventBody(opts),
    });
    return toCalendarEvent(response.data);
  });
}
