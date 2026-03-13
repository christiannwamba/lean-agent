import { DEFAULT_REFERENCE_ISO, DEFAULT_TIMEZONE, parseDeadlineText } from '../dates.js';
import { db } from '../db/index.js';
import { tasks, type NewTask, type Task } from '../db/schema.js';
import { sql } from 'drizzle-orm';

export type CreateTaskInput = {
  title: string;
  effort: 'low' | 'medium' | 'high';
  priority: 'low' | 'medium' | 'high' | 'critical';
  deadlineRaw?: string;
  durationMinutes: number;
  category?: 'deep_work' | 'admin' | 'communication' | 'creative';
  timezone?: string;
  referenceInstant?: Date;
};

export function createTask(input: CreateTaskInput): Task {
  const parsedDeadline = input.deadlineRaw
    ? parseDeadlineText(input.deadlineRaw, {
        referenceInstant: input.referenceInstant ?? new Date(DEFAULT_REFERENCE_ISO),
        timezone: input.timezone ?? DEFAULT_TIMEZONE,
      })
    : null;

  const values: NewTask = {
    title: input.title,
    effort: input.effort,
    priority: input.priority,
    deadlineAt: parsedDeadline?.deadlineAt ?? null,
    deadlineTimezone: parsedDeadline?.deadlineTimezone ?? null,
    deadlineRaw: parsedDeadline?.deadlineRaw ?? null,
    durationMinutes: input.durationMinutes,
    status: 'todo',
    category: input.category ?? null,
  };

  db.insert(tasks).values(values).run();

  const result = db.select().from(tasks).where(sql`${tasks.id} = last_insert_rowid()`).get();
  if (!result) {
    throw new Error('Failed to create task');
  }

  return result;
}
