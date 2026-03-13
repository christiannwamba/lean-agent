import type { EnergyDay } from '../db/schema.js';
import { fetchEnergy } from '../tools/energy-fetch.js';
import { DEFAULT_REFERENCE_ISO, DEFAULT_TIMEZONE } from '../dates.js';
import { DEFAULT_SUBAGENT_MODEL, getAnthropicClient } from './anthropic.js';

export type SubagentMode = 'auto' | 'local' | 'live';

export type EnergyContextInput = {
  currentHour: number;
  label?: string;
  mode?: SubagentMode;
};

export type EnergyContextPayload = {
  date: string;
  timezone: string;
  currentHour: number;
  hours: number[];
};

export type EnergyContextResult = {
  summary: string;
  payload: EnergyContextPayload;
  mode: 'local' | 'live';
};

type WindowMatch = {
  start: number;
  end: number;
};

function formatHour(hour: number): string {
  const normalized = ((hour % 24) + 24) % 24;
  return `${String(normalized).padStart(2, '0')}:00`;
}

function formatWindow(window: WindowMatch | null): string {
  if (!window) {
    return 'none';
  }

  return `${formatHour(window.start)}-${formatHour(window.end + 1)}`;
}

function classifyEnergy(value: number): 'low' | 'moderate' | 'high' {
  if (value >= 0.7) return 'high';
  if (value <= 0.4) return 'low';
  return 'moderate';
}

function findNextRun(
  hours: number[],
  startHour: number,
  predicate: (value: number) => boolean,
): WindowMatch | null {
  for (let hour = startHour; hour < hours.length; hour += 1) {
    if (!predicate(hours[hour]!)) {
      continue;
    }

    let end = hour;
    while (end + 1 < hours.length && predicate(hours[end + 1]!)) {
      end += 1;
    }

    return { start: hour, end };
  }

  return null;
}

function findNextRebound(hours: number[], startHour: number): WindowMatch | null {
  for (let hour = startHour; hour < hours.length - 1; hour += 1) {
    const current = hours[hour]!;
    const next = hours[hour + 1]!;
    if (current > 0.4 || next - current < 0.2) {
      continue;
    }

    let end = hour + 1;
    while (end + 1 < hours.length && hours[end + 1]! >= hours[end]!) {
      end += 1;
    }

    return { start: hour + 1, end };
  }

  return null;
}

function buildPayload(day: EnergyDay, currentHour: number): EnergyContextPayload {
  return {
    date: day.date,
    timezone: day.timezone,
    currentHour,
    hours: day.hours,
  };
}

function buildLocalSummary(payload: EnergyContextPayload): string {
  const currentValue = payload.hours[payload.currentHour] ?? 0;
  const currentLevel = classifyEnergy(currentValue);
  const nextPeak = findNextRun(payload.hours, payload.currentHour, (value) => value >= 0.7);
  const nextDip = findNextRun(payload.hours, payload.currentHour, (value) => value <= 0.4);
  const nextRebound = findNextRebound(payload.hours, payload.currentHour);

  return [
    `now ${formatHour(payload.currentHour)} ${currentLevel} (${currentValue.toFixed(2)})`,
    `peak ${formatWindow(nextPeak)}`,
    `dip ${formatWindow(nextDip)}`,
    `rebound ${formatWindow(nextRebound)}`,
  ].join('; ');
}

async function buildLiveSummary(payload: EnergyContextPayload): Promise<string> {
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: DEFAULT_SUBAGENT_MODEL,
    max_tokens: 120,
    system:
      'You are an energy curve analyst. Return a compact summary: current level, next peak (time range), next dip (time range), next rebound (time range). Max 60 tokens.',
    messages: [
      {
        role: 'user',
        content: JSON.stringify(payload),
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  return textBlock?.text.trim() ?? '';
}

export async function getEnergyContext(input: EnergyContextInput): Promise<EnergyContextResult> {
  const day = fetchEnergy(input.label ? { label: input.label } : {});
  if (!day) {
    throw new Error('No energy scenario found. Seed the database first.');
  }

  if (input.currentHour < 0 || input.currentHour > 23) {
    throw new Error('currentHour must be between 0 and 23');
  }

  const payload = buildPayload(day, input.currentHour);
  const requestedMode = input.mode ?? 'auto';
  const resolvedMode =
    requestedMode === 'auto' ? (process.env.ANTHROPIC_API_KEY ? 'live' : 'local') : requestedMode;

  const summary =
    resolvedMode === 'live' ? await buildLiveSummary(payload) : buildLocalSummary(payload);

  return {
    summary,
    payload,
    mode: resolvedMode,
  };
}

export function currentHourFromReference(referenceIso = DEFAULT_REFERENCE_ISO, timezone = DEFAULT_TIMEZONE): number {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric',
    hour12: false,
    timeZone: timezone,
  });

  return Number(formatter.format(new Date(referenceIso)));
}
