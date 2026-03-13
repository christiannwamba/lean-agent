import { eq } from 'drizzle-orm';

import { DEFAULT_REFERENCE_ISO, DEFAULT_TIMEZONE, parseDeadlineText } from '../dates.js';
import { db } from '../db/index.js';
import { tasks, type Task } from '../db/schema.js';

export type UpdateTaskFields = Partial<{
  title: string;
  effort: 'low' | 'medium' | 'high';
  priority: 'low' | 'medium' | 'high' | 'critical';
  deadlineRaw: string | null;
  durationMinutes: number;
  status: 'todo' | 'in_progress' | 'done';
  category: 'deep_work' | 'admin' | 'communication' | 'creative' | null;
}>;

export type UpdateTaskInput = {
  id: number;
  fields: UpdateTaskFields;
  timezone?: string;
  referenceInstant?: Date;
};

export function updateTask(input: UpdateTaskInput): Task {
  const existing = db.select().from(tasks).where(eq(tasks.id, input.id)).get();
  if (!existing) {
    throw new Error(`Task ${input.id} not found`);
  }

  const updates: Record<string, unknown> = {};

  if (input.fields.title !== undefined) updates.title = input.fields.title;
  if (input.fields.effort !== undefined) updates.effort = input.fields.effort;
  if (input.fields.priority !== undefined) updates.priority = input.fields.priority;
  if (input.fields.durationMinutes !== undefined) updates.durationMinutes = input.fields.durationMinutes;
  if (input.fields.status !== undefined) updates.status = input.fields.status;
  if (input.fields.category !== undefined) updates.category = input.fields.category;

  if (input.fields.deadlineRaw !== undefined) {
    if (input.fields.deadlineRaw === null) {
      updates.deadlineAt = null;
      updates.deadlineTimezone = null;
      updates.deadlineRaw = null;
    } else {
      const parsedDeadline = parseDeadlineText(input.fields.deadlineRaw, {
        referenceInstant: input.referenceInstant ?? new Date(DEFAULT_REFERENCE_ISO),
        timezone: input.timezone ?? DEFAULT_TIMEZONE,
      });

      if (!parsedDeadline) {
        throw new Error(`Failed to parse deadline: ${input.fields.deadlineRaw}`);
      }

      updates.deadlineAt = parsedDeadline.deadlineAt;
      updates.deadlineTimezone = parsedDeadline.deadlineTimezone;
      updates.deadlineRaw = parsedDeadline.deadlineRaw;
    }
  }

  db.update(tasks).set(updates).where(eq(tasks.id, input.id)).run();

  const result = db.select().from(tasks).where(eq(tasks.id, input.id)).get();
  if (!result) {
    throw new Error(`Task ${input.id} disappeared after update`);
  }

  return result;
}
