import { anthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';
import type { EnergyDay } from '../db/schema.js';
import { fetchEnergy } from '../tools/energy-fetch.js';
import { DEFAULT_REFERENCE_ISO, DEFAULT_TIMEZONE } from '../dates.js';
import { DEFAULT_SUBAGENT_MODEL } from './anthropic.js';
import { fromLanguageModelUsage, type TokenUsageSummary } from '../usage.js';

export type EnergyContextInput = {
  currentHour: number;
  label?: string;
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
  usage: TokenUsageSummary;
};

function buildPayload(day: EnergyDay, currentHour: number): EnergyContextPayload {
  return {
    date: day.date,
    timezone: day.timezone,
    currentHour,
    hours: day.hours,
  };
}

async function summarizeEnergyContext(
  payload: EnergyContextPayload,
): Promise<{ summary: string; usage: TokenUsageSummary }> {
  const response = await generateText({
    model: anthropic(DEFAULT_SUBAGENT_MODEL),
    system:
      'You are an energy curve analyst. Return a compact summary: current level, next peak (time range), next dip (time range), next rebound (time range). Max 60 tokens.',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      },
    ],
  });
  return {
    summary: response.text.trim(),
    usage: fromLanguageModelUsage(response.usage),
  };
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
  const result = await summarizeEnergyContext(payload);

  return {
    summary: result.summary,
    payload,
    usage: result.usage,
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
