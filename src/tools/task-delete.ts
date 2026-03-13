import { eq } from 'drizzle-orm';

import { db } from '../db/index.js';
import { tasks, type Task } from '../db/schema.js';

export function deleteTask(id: number): Task {
  const existing = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!existing) {
    throw new Error(`Task ${id} not found`);
  }

  db.delete(tasks).where(eq(tasks.id, id)).run();
  return existing;
}
