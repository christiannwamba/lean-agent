import { en } from 'chrono-node';

export const DEFAULT_TIMEZONE = 'Europe/London';
export const DEFAULT_REFERENCE_ISO = '2026-03-13T09:00:00.000Z';

export type ParsedDeadline = {
  deadlineAt: string;
  deadlineTimezone: string;
  deadlineRaw: string;
};

type ParseDeadlineOptions = {
  referenceInstant?: Date;
  timezone?: string;
  forwardDate?: boolean;
};

function parseOffsetLabel(label: string): number {
  const normalized = label.replace('GMT', '').replace('UTC', '');
  if (!normalized) return 0;

  const match = normalized.match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) {
    throw new Error(`Unsupported timezone offset label: ${label}`);
  }

  const [, sign, hours, minutes = '00'] = match;
  const totalMinutes = Number(hours) * 60 + Number(minutes);
  return sign === '-' ? -totalMinutes : totalMinutes;
}

export function timezoneOffsetForInstant(timezone: string, instant: Date): number {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    timeZoneName: 'shortOffset',
    hour: '2-digit',
    minute: '2-digit',
  });

  const zoneName = formatter.formatToParts(instant).find((part) => part.type === 'timeZoneName')?.value;
  if (!zoneName) {
    throw new Error(`Unable to resolve timezone offset for ${timezone}`);
  }

  return parseOffsetLabel(zoneName);
}

export function parseDeadlineText(text: string, options: ParseDeadlineOptions = {}): ParsedDeadline | null {
  const referenceInstant = options.referenceInstant ?? new Date(DEFAULT_REFERENCE_ISO);
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;
  const timezoneOffset = timezoneOffsetForInstant(timezone, referenceInstant);

  const parsedDate = en.GB.parseDate(
    text,
    { instant: referenceInstant, timezone: timezoneOffset },
    { forwardDate: options.forwardDate ?? true },
  );

  if (!parsedDate) {
    return null;
  }

  return {
    deadlineAt: parsedDate.toISOString(),
    deadlineTimezone: timezone,
    deadlineRaw: text,
  };
}
