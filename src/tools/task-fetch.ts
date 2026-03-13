import { and, eq, ne } from 'drizzle-orm';

import { db } from '../db/index.js';
import { tasks, type Task } from '../db/schema.js';

export type FetchTasksInput = {
  status?: 'todo' | 'in_progress' | 'done';
};

export function fetchTasks(input: FetchTasksInput = {}): Task[] {
  if (input.status) {
    return db.select().from(tasks).where(eq(tasks.status, input.status)).all();
  }

  return db.select().from(tasks).where(ne(tasks.status, 'done')).all();
}

export function fetchTaskById(id: number): Task | undefined {
  return db.select().from(tasks).where(eq(tasks.id, id)).get();
}

export function fetchTaskByTitle(title: string): Task | undefined {
  return db.select().from(tasks).where(and(eq(tasks.title, title), ne(tasks.status, 'done'))).get();
}
