import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const effortEnum = ['low', 'medium', 'high'] as const;
export const priorityEnum = ['low', 'medium', 'high', 'critical'] as const;
export const statusEnum = ['todo', 'in_progress', 'done'] as const;
export const categoryEnum = ['deep_work', 'admin', 'communication', 'creative'] as const;

export const tasks = sqliteTable('tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  effort: text('effort', { enum: effortEnum }).notNull(),
  priority: text('priority', { enum: priorityEnum }).notNull(),
  deadlineAt: text('deadline_at'),
  deadlineTimezone: text('deadline_timezone'),
  deadlineRaw: text('deadline_raw'),
  durationMinutes: integer('duration_minutes').notNull(),
  status: text('status', { enum: statusEnum }).notNull().default('todo'),
  category: text('category', { enum: categoryEnum }),
  createdAt: text('created_at').notNull().default(sql`(current_timestamp)`),
});

export const energyDays = sqliteTable('energy_days', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  label: text('label').notNull().unique(),
  date: text('date').notNull(),
  timezone: text('timezone').notNull(),
  hours: text('hours', { mode: 'json' }).notNull().$type<number[]>(),
});

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type EnergyDay = typeof energyDays.$inferSelect;
export type NewEnergyDay = typeof energyDays.$inferInsert;
