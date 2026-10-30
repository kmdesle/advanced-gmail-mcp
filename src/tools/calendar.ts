import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  createEvent,
  getEvent,
  listCalendars,
  listEvents,
  queryFreeBusy,
  updateEvent,
  type CalendarSendUpdates,
} from '../calendar/client.js';

const accountParam = z.string().optional().describe('Account alias or email address. Uses default account if not specified.');

const sendUpdatesParam = z.enum(['none', 'all', 'externalOnly']).optional().describe(
  'Who is emailed about this change: "none", "all", or "externalOnly". Defaults to "none" when there are no attendees. Required when attendees is set so guests are not emailed unless you say so.',
);

const calendarIdParam = z.string().optional().describe('Calendar id (default: primary). Use calendar_list_calendars to find ids.');

function ok(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    isError: true,
  };
}

export const calendarListCalendarsParams = {
  account: accountParam,
};

export function registerCalendarListCalendars(server: McpServer): void {
  server.tool(
    'calendar_list_calendars',
    'List calendars the account can see. Returns id, summary, description, primary, access role, and time zone. If this errors because the calendar scope is missing, re-run `npm run auth` for that account.',
    calendarListCalendarsParams,
    async ({ account }) => {
      try {
        const results = await listCalendars({ account: account ?? undefined });
        return ok(results);
      } catch (err) {
        return fail(err);
      }
    },
  );
}

export const calendarListEventsParams = {
  account: accountParam,
  calendar_id: calendarIdParam,
  time_min: z.string().optional().describe('Lower bound (exclusive) for an event end time, RFC3339. Only events ending after this are returned.'),
  time_max: z.string().optional().describe('Upper bound (exclusive) for an event start time, RFC3339.'),
  max_results: z.number().optional().describe('Maximum events on this page (API default 250, max 2500).'),
  query: z.string().optional().describe('Free-text search over summary, description, location, and attendees.'),
};

export function registerCalendarListEvents(server: McpServer): void {
  server.tool(
    'calendar_list_events',
    'List events on a calendar (default primary). Recurring events are expanded into instances. Returns one page of id, summary, start, end, location, and attendees. If the calendar scope is missing, re-run `npm run auth` for that account.',
    calendarListEventsParams,
    async ({ account, calendar_id, time_min, time_max, max_results, query }) => {
      try {
        const results = await listEvents({
          account: account ?? undefined,
          calendarId: calendar_id ?? undefined,
          timeMin: time_min ?? undefined,
          timeMax: time_max ?? undefined,
          maxResults: max_results ?? undefined,
          query: query ?? undefined,
        });
        return ok(results);
      } catch (err) {
        return fail(err);
      }
    },
  );
}

export const calendarGetEventParams = {
  event_id: z.string().describe('Event id'),
  account: accountParam,
  calendar_id: calendarIdParam,
};

export function registerCalendarGetEvent(server: McpServer): void {
  server.tool(
    'calendar_get_event',
    'Get one calendar event by id (calendar default: primary). If the calendar scope is missing, re-run `npm run auth` for that account.',
    calendarGetEventParams,
    async ({ event_id, account, calendar_id }) => {
      try {
        const result = await getEvent({
          eventId: event_id,
          account: account ?? undefined,
          calendarId: calendar_id ?? undefined,
        });
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );
}

export const calendarFreeBusyParams = {
  time_min: z.string().describe('Start of the interval, RFC3339.'),
  time_max: z.string().describe('End of the interval, RFC3339.'),
  calendars: z.array(z.string()).describe('Calendar ids to check, for example ["primary"].'),
  account: accountParam,
};

export function registerCalendarFreeBusy(server: McpServer): void {
  server.tool(
    'calendar_freebusy',
    'Query free/busy for a time range across one or more calendars. Returns busy intervals per calendar id. If the calendar scope is missing, re-run `npm run auth` for that account.',
    calendarFreeBusyParams,
    async ({ time_min, time_max, calendars, account }) => {
      try {
        const result = await queryFreeBusy({
          timeMin: time_min,
          timeMax: time_max,
          calendars,
          account: account ?? undefined,
        });
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );
}

export const calendarCreateEventParams = {
  summary: z.string().describe('Event title'),
  start: z.string().describe('Start time, RFC3339. Include an offset, or pass timezone.'),
  end: z.string().describe('End time, RFC3339. Include an offset, or pass timezone.'),
  timezone: z.string().optional().describe('IANA time zone applied to start and end, for example America/Chicago.'),
  description: z.string().optional().describe('Event description'),
  location: z.string().optional().describe('Event location'),
  attendees: z.array(z.string()).optional().describe('Guest email addresses. If set, send_updates is required.'),
  send_updates: sendUpdatesParam,
  calendar_id: calendarIdParam,
  account: accountParam,
};

export function registerCalendarCreateEvent(server: McpServer): void {
  server.tool(
    'calendar_create_event',
    'Create an event. send_updates defaults to "none" (nobody is emailed). When attendees is set you must pass send_updates yourself ("none", "all", or "externalOnly"). There is no delete tool.',
    calendarCreateEventParams,
    async ({ summary, start, end, timezone, description, location, attendees, send_updates, calendar_id, account }) => {
      try {
        const result = await createEvent({
          summary,
          start,
          end,
          timezone: timezone ?? undefined,
          description: description ?? undefined,
          location: location ?? undefined,
          attendees: attendees ?? undefined,
          sendUpdates: (send_updates ?? undefined) as CalendarSendUpdates | undefined,
          calendarId: calendar_id ?? undefined,
          account: account ?? undefined,
        });
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );
}

export const calendarUpdateEventParams = {
  event_id: z.string().describe('Event id to patch'),
  summary: z.string().optional().describe('Event title'),
  start: z.string().optional().describe('Start time, RFC3339.'),
  end: z.string().optional().describe('End time, RFC3339.'),
  timezone: z.string().optional().describe('IANA time zone applied to start and/or end. Pass start or end with it.'),
  description: z.string().optional().describe('Event description'),
  location: z.string().optional().describe('Event location'),
  attendees: z.array(z.string()).optional().describe('Guest email addresses. Replaces the attendee list. If set, send_updates is required.'),
  send_updates: sendUpdatesParam,
  calendar_id: calendarIdParam,
  account: accountParam,
};

export function registerCalendarUpdateEvent(server: McpServer): void {
  server.tool(
    'calendar_update_event',
    'Patch an event: only fields you pass are changed. send_updates defaults to "none". When attendees is set you must pass send_updates yourself ("none", "all", or "externalOnly"). Events are not deleted by this server.',
    calendarUpdateEventParams,
    async ({ event_id, summary, start, end, timezone, description, location, attendees, send_updates, calendar_id, account }) => {
      try {
        const result = await updateEvent({
          eventId: event_id,
          summary: summary ?? undefined,
          start: start ?? undefined,
          end: end ?? undefined,
          timezone: timezone ?? undefined,
          description: description ?? undefined,
          location: location ?? undefined,
          attendees: attendees ?? undefined,
          sendUpdates: (send_updates ?? undefined) as CalendarSendUpdates | undefined,
          calendarId: calendar_id ?? undefined,
          account: account ?? undefined,
        });
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );
}

/**
 * Register calendar tools. Read + create/update only — no delete tool.
 */
export function registerCalendarTools(server: McpServer): void {
  registerCalendarListCalendars(server);
  registerCalendarListEvents(server);
  registerCalendarGetEvent(server);
  registerCalendarFreeBusy(server);
  registerCalendarCreateEvent(server);
  registerCalendarUpdateEvent(server);
}
