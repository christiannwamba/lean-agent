import { fetchTasks } from './task-fetch.js';
import type { Task } from '../db/schema.js';

export type ResolveTaskInput = {
  query: string;
  includeDone?: boolean;
  limit?: number;
};

export type ResolveTaskResult =
  | {
      type: 'exact';
      query: string;
      task: Task;
    }
  | {
      type: 'ambiguous';
      query: string;
      candidates: Task[];
    }
  | {
      type: 'none';
      query: string;
      candidates: [];
    };

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const STOP_WORDS = new Set(['task', 'todo', 'item', 'the', 'a', 'an']);

function tokenize(value: string): string[] {
  return normalize(value)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));
}

function scoreCandidate(query: string, title: string): number {
  const normalizedQuery = normalize(query);
  const normalizedTitle = normalize(title);

  if (!normalizedQuery || !normalizedTitle) return 0;
  if (normalizedQuery === normalizedTitle) return 100;
  if (normalizedTitle.includes(normalizedQuery)) return 90;
  if (normalizedQuery.includes(normalizedTitle)) return 80;

  const queryTokens = tokenize(query);
  const titleTokens = tokenize(title);

  const queryWords = new Set(queryTokens);
  const titleWords = new Set(titleTokens);

  let overlap = 0;
  for (const word of queryWords) {
    if (titleWords.has(word)) {
      overlap += 12;
      continue;
    }

    const partialMatch = titleTokens.some((token) => token.includes(word) || word.includes(token));
    if (partialMatch) {
      overlap += 6;
    }
  }

  return overlap;
}

export function resolveTask(input: ResolveTaskInput): ResolveTaskResult {
  const limit = input.limit ?? 5;
  const allTasks = input.includeDone ? fetchTasks({ status: 'done' }).concat(fetchTasks(), fetchTasks({ status: 'in_progress' })) : fetchTasks();
  const scored = allTasks
    .map((task) => ({ task, score: scoreCandidate(input.query, task.title) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.task.id - right.task.id);

  if (scored.length === 0) {
    return { type: 'none', query: input.query, candidates: [] };
  }

  if (scored[0]?.score === 100 && scored[1]?.score !== 100) {
    return { type: 'exact', query: input.query, task: scored[0].task };
  }

  if (scored[0]?.score >= 90 && (scored[1]?.score ?? 0) < scored[0].score) {
    return { type: 'exact', query: input.query, task: scored[0].task };
  }

  return {
    type: 'ambiguous',
    query: input.query,
    candidates: scored.slice(0, limit).map((entry) => entry.task),
  };
}
