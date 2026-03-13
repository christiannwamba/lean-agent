import type { Task } from '../db/schema.js';
import { DEFAULT_REFERENCE_ISO } from '../dates.js';
import { fetchTasks } from '../tools/task-fetch.js';
import { DEFAULT_SUBAGENT_MODEL, getAnthropicClient } from './anthropic.js';
import type { SubagentMode } from './energy-context.js';

export type TaskContextInput = {
  mode?: SubagentMode;
  referenceInstant?: string;
};

export type TaskContextPayload = {
  referenceInstant: string;
  tasks: Array<{
    id: number;
    title: string;
    effort: Task['effort'];
    priority: Task['priority'];
    durationMinutes: number;
    deadlineAt: string | null;
    status: Task['status'];
  }>;
};

export type TaskContextResult = {
  summary: string;
  payload: TaskContextPayload;
  mode: 'local' | 'live';
};

type DeadlineBucket = 'overdue' | 'within_8h' | 'within_24h' | 'later' | 'no_deadline';

function buildPayload(referenceInstant: string): TaskContextPayload {
  const tasks = fetchTasks().map((task) => ({
    id: task.id,
    title: task.title,
    effort: task.effort,
    priority: task.priority,
    durationMinutes: task.durationMinutes,
    deadlineAt: task.deadlineAt,
    status: task.status,
  }));

  return {
    referenceInstant,
    tasks,
  };
}

function deadlineBucket(deadlineAt: string | null, referenceInstant: string): DeadlineBucket {
  if (!deadlineAt) {
    return 'no_deadline';
  }

  const deltaMs = new Date(deadlineAt).getTime() - new Date(referenceInstant).getTime();
  if (deltaMs < 0) return 'overdue';
  if (deltaMs <= 8 * 60 * 60 * 1000) return 'within_8h';
  if (deltaMs <= 24 * 60 * 60 * 1000) return 'within_24h';
  return 'later';
}

function topTitles(tasks: TaskContextPayload['tasks']): string {
  return tasks
    .slice(0, 2)
    .map((task) => task.title)
    .join(', ');
}

function buildLocalSummary(payload: TaskContextPayload): string {
  const buckets: Record<DeadlineBucket, TaskContextPayload['tasks']> = {
    overdue: [],
    within_8h: [],
    within_24h: [],
    later: [],
    no_deadline: [],
  };

  const effortCounts = {
    high: 0,
    medium: 0,
    low: 0,
  };

  for (const task of payload.tasks) {
    buckets[deadlineBucket(task.deadlineAt, payload.referenceInstant)].push(task);
    effortCounts[task.effort] += 1;
  }

  const urgencyParts = [
    `overdue ${buckets.overdue.length}`,
    `8h ${buckets.within_8h.length}`,
    `24h ${buckets.within_24h.length}`,
    `later ${buckets.later.length}`,
    `none ${buckets.no_deadline.length}`,
  ];

  const urgentTitles = [...buckets.overdue, ...buckets.within_8h, ...buckets.within_24h];
  const urgentPart = urgentTitles.length > 0 ? `urgent ${topTitles(urgentTitles)}` : 'urgent none';
  const effortPart = `effort high ${effortCounts.high}, medium ${effortCounts.medium}, low ${effortCounts.low}`;

  return [...urgencyParts, urgentPart, effortPart].join('; ');
}

async function buildLiveSummary(payload: TaskContextPayload): Promise<string> {
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: DEFAULT_SUBAGENT_MODEL,
    max_tokens: 160,
    system:
      'You are a task analyst. Group tasks by deadline urgency (overdue, within 8h, within 24h, later, no deadline) and effort level. Return a compact summary. Max 80 tokens.',
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

export async function getTaskContext(input: TaskContextInput = {}): Promise<TaskContextResult> {
  const payload = buildPayload(input.referenceInstant ?? DEFAULT_REFERENCE_ISO);
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
