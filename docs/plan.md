# Implementation Plan

## Tech Stack

| Layer | Tool | Why |
|-------|------|-----|
| Runtime | `Bun` | Bun-first CLI runtime with native SQLite support and fast local execution. |
| LLM | `ai` + `@ai-sdk/anthropic` | Vercel AI SDK. `generateText` with `prepareStep` for step-level tool activation and system prompt injection. Better fit for the Next.js / Vercel-native audience. |
| Database | `bun:sqlite` + `drizzle-orm/bun-sqlite` | Clean Bun-native SQLite path for a local demo. |
| Date parsing | `chrono-node` | Parse natural-language deadlines into normalized timestamps. GB-biased (`en.GB`), `Europe/London` default. |
| Scenario picker | `@clack/prompts` | Minimal, modern terminal UI for scenario selection and ongoing chat input. |
| CLI output | `chalk` + `cli-markdown` | Colored log lines plus terminal-friendly Markdown rendering for assistant output. |
| CLI commands | `commander` | Zero-dependency arg parser. Flags for `--energy`, `--tasks`, `--hour`, `--tz`, `--ref`, `--trace-agent`. |
| Spinner | `@clack/prompts` spinner | Loading state while the assistant turn is in progress. |
| Evals | `vitest-evals` | Vitest-native eval runner from Sentry. Custom Anthropic-based scorers so eval infra matches the runtime provider. |
| Validation | `zod` + `zod-to-json-schema` | Schema validation for tool inputs and type derivation. Zod 3 schemas are converted to JSON Schema before handing to the AI SDK. |

---

## Project Structure

```
lean-agent/
├── src/
│   ├── index.ts                 # CLI entry point (commander)
│   ├── chat.ts                  # Chat loop (clack prompts + markdown rendering)
│   ├── agent.ts                 # Main agent (generateText + prepareStep, tool definitions, step orchestration)
│   ├── usage.ts                 # Token usage tracking and aggregation
│   ├── dates.ts                 # Deadline parsing + ISO normalization helpers
│   ├── skills.ts                # Skill discovery + loadSkill
│   ├── subagents/
│   │   ├── energy-context.ts    # Energy subagent — compact curve summary
│   │   ├── task-context.ts      # Task subagent — compact urgency/effort grouping
│   │   └── task-list.ts         # Task-list subagent — concise user-facing list
│   ├── tools/
│   │   ├── task-create.ts       # Insert task row
│   │   ├── task-resolve.ts      # Find a task by natural-language reference
│   │   ├── task-update.ts       # Update task row
│   │   ├── task-delete.ts       # Delete task row
│   │   ├── task-fetch.ts        # Internal task query helper (not exposed to agent)
│   │   └── energy-fetch.ts      # Internal energy query helper (not exposed to agent)
│   ├── ui/
│   │   └── render.ts            # Markdown-to-terminal rendering
│   └── db/
│       ├── index.ts             # Database connection
│       ├── schema.ts            # Drizzle table definitions
│       └── seed.ts              # Scenario seeder
├── skills/
│   ├── task-create/
│   │   └── SKILL.md
│   ├── task-update-delete/
│   │   └── SKILL.md
│   ├── task-prioritise/
│   │   └── SKILL.md
│   ├── energy-check/
│   │   └── SKILL.md
│   └── task-fetch/
│       └── SKILL.md
├── evals/
│   ├── vitest.evals.config.ts   # Eval-specific vitest config
│   ├── skill-routing.eval.ts    # Deterministic routing tests
│   ├── task-resolution.eval.ts  # Safe mutation / ambiguity tests
│   └── output-quality.eval.ts   # LLM-as-judge quality tests
├── drizzle.config.ts
├── package.json
└── tsconfig.json
```

---

## Database Schema

### `tasks` table

```typescript
export const effortEnum = ['low', 'medium', 'high'] as const;
export const priorityEnum = ['low', 'medium', 'high', 'critical'] as const;
export const statusEnum = ['todo', 'in_progress', 'done'] as const;
export const categoryEnum = ['deep_work', 'admin', 'communication', 'creative'] as const;

export const tasks = sqliteTable('tasks', {
  id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
  title: text().notNull(),
  effort: text({ enum: effortEnum }).notNull(),
  priority: text({ enum: priorityEnum }).notNull(),
  deadline_at: text(), // ISO 8601 UTC string when parsed
  deadline_timezone: text(), // original timezone context used for parsing
  deadline_raw: text(), // raw user phrasing, e.g. "tomorrow at 4"
  duration_minutes: integer().notNull(),
  status: text({ enum: statusEnum }).notNull().default('todo'),
  category: text({ enum: categoryEnum }),
  created_at: text().notNull().default(sql`(current_timestamp)`),
});
```

### `energy_days` table

```typescript
export const energyDays = sqliteTable('energy_days', {
  id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
  label: text().notNull().unique(),
  date: text().notNull(), // ISO local date for the seeded scenario
  timezone: text().notNull(),
  hours: text({ mode: 'json' }).notNull().$type<number[]>(),
});
```

Schema sync: `drizzle-kit push`. No migrations.

### Time handling rules

- All parsed task deadlines are stored as normalized ISO timestamps in `deadline_at`.
- The original user phrase is preserved in `deadline_raw` for explainability.
- Urgency bucketing (`within 8h`, `within 24h`, overdue, no deadline) always uses parsed `deadline_at`, never fuzzy string comparisons.
- Deadline parsing uses `chrono-node` `en.GB` with `Europe/London` as the default timezone and a fixed reference instant (`2026-03-13T09:00:00.000Z`) for reproducible demos and evals.
- Seeded demo scenarios use deterministic fixed timestamps anchored to the same reference instant.

---

## Orchestration Model

The main agent uses Vercel AI SDK's `generateText` with `prepareStep` for step-level control. This replaces the earlier Anthropic SDK `toolRunner` approach.

### Why `prepareStep`

`prepareStep` fires before each model step, receiving the full step history. It returns overrides for `activeTools`, `system`, and `messages`. This gives us:

- **Step-scoped tool activation** without code-based intent classification — the model loads a skill, then searches for tools, and `prepareStep` reads the latest tool results to decide what's available next.
- **System prompt injection** per step — skill instructions are layered onto the base prompt only when active, without polluting the message transcript.
- **Message pruning** between steps — consumed orchestration messages (`load_skill`, `search_tools` calls from before the latest message) are pruned to save tokens.

### Two-tier tool architecture

Tools are split into **meta tools** and **functional tools**.

**Meta tools** are always available:

| Tool | Purpose |
|------|---------|
| `load_skill` | Returns `{ name }`. Full skill instructions are loaded locally and injected into the next step's system prompt. |
| `search_tools` | Returns `{ tools: FunctionalToolName[] }`. Activates functional tools for the next step. |

**Functional tools** are step-scoped — only available after `search_tools` activates them:

| Tool | Purpose |
|------|---------|
| `create_task` | Insert task row with normalized deadline fields. |
| `resolve_task` | Match natural-language task reference to exact or candidate list. |
| `update_task` | Update task row (blocked unless `resolve_task` succeeded this turn). |
| `delete_task` | Delete task row (blocked unless `resolve_task` succeeded this turn). |
| `get_energy_context` | Subagent — compact energy curve summary. |
| `get_task_context` | Subagent — compact task urgency/effort grouping. |
| `get_task_list` | Subagent — concise markdown task list for display. |

This separation means the model's first step always sees only 2 tools (load_skill, search_tools). Functional tools appear only after the model has chosen a direction. This saves tokens on tool definitions in early steps.

### Skill → tool activation flow

1. Model calls `load_skill({ name: "task-create" })` → returns `{ name: "task-create" }`.
2. Model calls `search_tools({ skillName: "task-create" })` → returns `{ tools: ["create_task", "get_task_context", "get_energy_context"] }`.
3. `prepareStep` reads the latest `load_skill` and `search_tools` results from step history.
4. Next step gets: active skill instructions in the system prompt, activated functional tools, pruned orchestration messages.

### `search_tools` routing

Exact-first, fuzzy fallback:

- If `skillName` maps to a known key in `SKILL_TOOL_MAP`, return exactly those tools. No fuzzy expansion.
- Otherwise, tokenize the `query` and score each functional tool's metadata (description, skills, keywords) by token overlap. Return top matches.

The exact map:

```typescript
const SKILL_TOOL_MAP: Record<string, FunctionalToolName[]> = {
  'energy-check': ['get_energy_context'],
  'task-create': ['create_task', 'get_task_context', 'get_energy_context'],
  'task-fetch': ['get_task_list'],
  'task-prioritise': ['get_task_context', 'get_energy_context'],
  'task-update-delete': ['resolve_task', 'update_task', 'delete_task', 'get_task_context', 'get_energy_context'],
};
```

**Why `task-create` includes both context tools:** Task creation should be schedule-aware. The agent calls `get_energy_context` and `get_task_context` to understand where a new task fits in the day, and can suggest optimal timing or auto-schedule when the user doesn't provide a time.

**Why `task-update-delete` includes both context tools:** After a mutation, the agent may reason about reshuffling remaining tasks into freed or shifted windows. Context tools give it the landscape to make those recommendations.

### Step state selection

`selectStepState` inspects all completed steps to find:
- The latest `load_skill` result → determines `activeSkillName`
- The latest `search_tools` result → determines `functionalTools`
- If `search_tools` is more recent than `load_skill`, use its tool list. Otherwise, only meta tools are active.

Meta tools are always appended, so the model can re-anchor by loading a different skill at any point.

### Message pruning

`pruneConsumedOrchestrationMessages` uses AI SDK's `pruneMessages` to strip `load_skill` and `search_tools` tool call/result pairs from before the latest message. This is a step-level token control mechanism, separate from tool activation. It prevents orchestration chatter from accumulating across steps within a turn.

---

## System Prompt Design

### Base prompt (every step)

The base system prompt is preserved across all steps. It contains:

- Core assistant behavior (concise, practical, tool-dependent, never invent data)
- Mutation safety rules ("before `update_task` or `delete_task`, call `resolve_task`")
- Session context (current hour, timezone, reference instant)
- Full skill summary (name + description for all discovered skills)

**Conscious tradeoff:** Including the skill summary in every step costs tokens but ensures the model can always discover and re-anchor to any skill. Without it, the model loses the ability to change direction after an initial skill load. This is load-bearing for trajectory correction.

### Active skill layer (step-scoped)

When `load_skill` has been called, the next step's system prompt appends:

```
## Active Skill
Current skill: task-prioritise
[full SKILL.md body]
```

This replaces the old skill on each step — not by deleting a message from the transcript, but by rebuilding the system prompt. The previous skill's instructions simply disappear from the next step's context.

### What is NOT in the prompt

Seed scenario labels are intentionally not injected. The agent should reason from time, tools, and returned data — not cheat from metadata about which scenario was selected.

---

## Skills — Progressive Disclosure

Skills follow a three-phase lifecycle: discover, activate, execute.

### Phase 1: Discovery (startup)

Scan `skills/` directory. Parse frontmatter (`name`, `description`) from each `SKILL.md`. Build a summary for the base system prompt:

```
## Skills

Use the `load_skill` tool to load specialized instructions before acting on a task.

Available skills:
- task-create: Extract task details from natural language input and insert a new task.
- task-update-delete: Find, confirm, and update or delete an existing task.
- task-prioritise: Produce a temporal schedule matching tasks to energy windows.
- energy-check: Summarise the user's current energy level and upcoming windows.
- task-fetch: List all open tasks grouped by priority.
```

### Phase 2: Activation (on demand)

`load_skill` returns only `{ name }` to the model. The full `SKILL.md` body is loaded locally by `loadSkill(name)` and injected into the next step's system prompt by `buildStepSystemPrompt`. The instructions never enter the message transcript as a `tool_result`.

This is a key token-saving decision. The skill instructions appear in the system prompt for the steps that need them, then vanish when the system prompt is rebuilt without them.

### Phase 3: Execution

After loading instructions, the model calls `search_tools` to activate functional tools, then uses those tools to act on the database.

### SKILL.md format

```markdown
---
name: task-prioritise
description: Produce a temporal schedule matching tasks to energy windows.
---

# Task Prioritise

## Reasoning chain

1. Identify current hour index in the energy array.
2. Scan forward to identify upcoming windows:
   - Peak: sustained run >= 0.7
   - Dip: sustained run <= 0.4
   - Rebound: rise of >= 0.2 after a dip
3. Classify each task by required energy window:
   - high effort → needs a peak
   - medium effort → works in a rebound, not a dip
   - low effort → fits in a dip or rebound
...
```

Each `SKILL.md` contains the full reasoning chain, rules, and output format from the brief.

---

## Subagents

Three subagents exposed as functional tools. Each calls `generateText` with `anthropic(...)` internally — using the same AI SDK as the main agent for consistent usage accounting. The main agent never sees the subagent's full context; only the compact summary string enters the main agent's context as a tool result.

The point of subagents is deliberate context compression. As task volume grows, passing the raw task table or verbose energy reasoning into the main agent becomes noisy. Each subagent fetches narrow structured data, summarizes only decision-relevant points, and returns a bounded result.

### Energy subagent (`get_energy_context`)

- **Input:** 24-value energy array + current hour
- **System prompt:** Compact energy curve analyst. Returns current level, next peak, next dip, next rebound.
- **Pre-trim:** Only the 24-value curve, date, timezone, and current hour are forwarded. No scenario labels or chat history.
- **Returns:** Summary text + usage stats.

### Task subagent (`get_task_context`)

- **Input:** Open task list only, trimmed to `id`, `title`, `effort`, `priority`, `durationMinutes`, `deadlineAt`, `status`
- **System prompt:** Groups tasks by deadline urgency (overdue, within 8h, 24h, later, no deadline) and effort level.
- **Pre-trim:** Strips unused columns and excludes done tasks before the subagent call.
- **Returns:** Summary text + usage stats.

### Task-list subagent (`get_task_list`)

- **Input:** Open task list, same trimmed columns as task context.
- **System prompt:** Formats tasks as compact markdown grouped by priority. One bullet per task with id, title, effort, duration, deadline.
- **Returns:** Markdown text + usage stats.

### Read boundary rule

Raw database fetch helpers (`fetchTasks`, `fetchEnergy`) are internal to the app. The main agent reads exclusively through subagents. This is the "context compression first" architecture — the agent never sees raw rows.

### Scaling rule

For small seeded scenarios, subagents are still used so the architecture matches the intended scaling pattern. If task volume grows, only the subagent payload grows; the main agent still receives the same bounded summaries.

---

## Mutation Safety

Mutation safety is enforced in code, not just prompted.

### Turn-local resolution guard

A `resolvedTaskIds` Set is created fresh for each turn inside `buildTools`. When `resolve_task` returns an exact match, the task's `id` is added to the set. `update_task` and `delete_task` check this set before executing — if the id hasn't been resolved in the current turn, the tool throws.

This is an invariant: no mutation without prior exact resolution in the same turn.

### Task resolution algorithm

`resolve_task` uses lexical matching with specific thresholds:

- Stop-word filtering (`task`, `todo`, `item`, `the`, `a`, `an`)
- Exact title match → score 100
- Substring match → score 90
- Reverse substring → score 80
- Token overlap → 12 points per full match, 6 per partial
- Single result with score ≥ 90 → `exact` match, proceed with mutation
- Multiple candidates → `ambiguous`, assistant asks for clarification
- No matches → `none`

### Mutation workflow

1. User says "mark the report task as done"
2. Agent calls `resolve_task({ query: "report" })`
3. If exact → `resolvedTaskIds.add(id)`, then `update_task({ id, fields: { status: "done" } })`
4. If ambiguous → agent asks "Did you mean X or Y?" — no mutation
5. If none → agent reports no match found

---

## Conversation History

History keeps only user and assistant text messages. All tool call/result pairs, orchestration messages, and subagent exchanges are excluded from the persisted history between turns.

```typescript
return {
  history: [...params.history, userMessage, assistantMessage],
  assistantText,
  usage: { main, subagents, total },
};
```

Where `userMessage` and `assistantMessage` contain only `[{ type: 'text', text: '...' }]` content blocks.

**Why:** Context growth is linear and incremental — each turn adds one user message and one assistant response. Tool history from the previous turn is consumed and discarded. This keeps the message array lean without needing summarization or compaction.

---

## Token Usage Accounting

Token accounting is a first-class product behavior, not a background budget.

### Per-turn display

After each turn, the CLI displays:

```
[tokens: turn 4,231 | session 12,847 | main 3,102 | subagents 1,129]
```

- **turn** — total tokens for this user turn (main + subagents)
- **session** — cumulative sum across all turns in this chat session
- **main** — main agent steps only (from `result.totalUsage`)
- **subagents** — separate subagent calls only (tracked via `trackSubagentUsage` callback)

### Why this matters

Most token cost comes from repeated input (system prompt + message history sent on every step), not output. The main/subagent split makes this visible. The session total tracks cumulative cost across the demo.

### No compaction

The earlier plan specified a 10,000-token budget with compaction at 8,000. This is no longer implemented. History growth is linear (text-only, no tool history), so compaction is not needed for the demo scope. If session length grows to require it, it can be added later without architectural changes.

---

## Step Tracing

`--trace-agent` writes one JSONL record per model step to `traces/agent-trace-<timestamp>.jsonl`. Each record includes:

- `turnIndex`, `userInput`, `stepNumber`
- `activeSkillName`, `activeTools`
- `system` (full system prompt for this step)
- `messages` (message array as sent to the model)
- `toolCalls`, `toolResults`
- `usage` (tokens for this step)
- `text`, `finishReason`

This is the primary debugging tool for token optimization decisions. It shows exactly what the model saw at each step — which tools were active, what the system prompt contained, how messages were pruned.

---

## CLI Behaviour

### Entry point

```
lean-agent chat [--energy <label>] [--tasks <label>] [--hour <0-23>] [--tz <timezone>] [--ref <iso>] [--trace-agent]
lean-agent seed --energy <label> --tasks <label>
```

### Startup flow

1. Parse flags via `commander`.
2. If `--energy` or `--tasks` not provided, prompt interactively using `@clack/prompts` `select()`.
3. Default to the current local hour in the configured timezone unless `--hour` is explicitly provided.
4. Run seed for selected scenarios (destructive: clear + insert). Intentionally destructive because this is a throwaway demo, not a persistent task manager.
5. Enter chat loop.

### Chat loop

1. `@clack/prompts` `text()` prompts for input.
2. On input:
   - Start spinner (`Thinking...`).
   - Call `runChatTurn` with config, history, input, and a terminal logger.
3. During the turn:
   - On tool events → clear spinner, log `[skill: ...]` / `[tool: ...]` / `[subagent: ...]` in chalk dim, resume spinner (`Waiting...`).
   - Log lines appear immediately as tools fire.
4. After turn completes:
   - Stop spinner.
   - Render assistant output as terminal-friendly Markdown via `cli-markdown`.
   - Display token usage line.
   - Return to step 1.

### Output rendering

Assistant output is rendered after the turn completes, not streamed token-by-token. This is a deliberate UX tradeoff: clean terminal Markdown over raw streaming. Tool/subagent log lines still appear in real time during the turn, so the user sees activity before the final rendered response.

### Spinner policy

- Spinner starts on user input (`Thinking...`).
- Clears (not stops) before each log line so the line appears cleanly.
- Resumes after each log line (`Waiting...`).
- Stops when the turn completes, before rendering output.

---

## Seed Data

### Energy scenarios (5 rows)

Stored in the seed script as literal arrays. Labels: `well_rested`, `poor_sleep`, `evening_person`, `fragmented`, `burnout`. Values per the brief. All anchored to a fixed reference date and timezone for reproducibility.

### Task scenarios (5 sets)

Each scenario is a named set of task rows. Labels: `deadline_pressure`, `overloaded_queue`, `light_day`, `mismatched_priorities`, `recovery_day`. Deadline parsing uses the fixed reference instant so seeded deadlines are deterministic.

### Seed script

```
lean-agent seed --energy well_rested --tasks deadline_pressure
```

Or interactively at startup. The seed script:
1. Deletes all rows from `tasks` and `energy_days`.
2. Inserts the selected energy scenario.
3. Inserts the selected task set.

Energy and task scenarios are independent — any combination works.

---

## Evals

### Config

```typescript
// vitest.evals.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['evals/**/*.eval.ts'],
  },
});
```

Run with: `vitest --config vitest.evals.config.ts`

### Eval 1: Skill routing (deterministic)

Tests whether Claude calls `load_skill` with the correct skill name for a given input.

```typescript
describeEval('skill routing', {
  data: async () => [
    { input: 'add a task to write the report', expectedTools: [{ name: 'load_skill', arguments: { name: 'task-create' } }] },
    { input: 'what should I work on next?', expectedTools: [{ name: 'load_skill', arguments: { name: 'task-prioritise' } }] },
    { input: "how's my energy right now?", expectedTools: [{ name: 'load_skill', arguments: { name: 'energy-check' } }] },
    { input: 'mark the report task as done', expectedTools: [{ name: 'load_skill', arguments: { name: 'task-update-delete' } }] },
    { input: 'show me my tasks', expectedTools: [{ name: 'load_skill', arguments: { name: 'task-fetch' } }] },
    // Ambiguous cases
    { input: 'what now?', expectedTools: [{ name: 'load_skill', arguments: { name: 'task-prioritise' } }] },
  ],
  task: async (input) => {
    return await getRoutedSkillName(input);
  },
  scorers: [ToolCallScorer({ requireAll: false, allowExtras: true })],
  threshold: 0.8,
});
```

### Eval 2: Task resolution safety

Tests whether update/delete requests resolve the correct task and ask for clarification on ambiguous references.

```typescript
describeEval('task resolution safety', {
  data: async () => [
    { input: 'mark the report task as done', expectedTools: [{ name: 'resolve_task' }, { name: 'update_task' }] },
    { input: 'delete the planning task', expectedTools: [{ name: 'resolve_task' }, { name: 'delete_task' }] },
    { input: 'mark the task as done', expectedTools: [{ name: 'resolve_task' }] }, // ambiguous, should not mutate
  ],
  task: async (input) => {
    return await runMutationScenario(input);
  },
  scorers: [ToolCallScorer({ allowExtras: true })],
  threshold: 0.8,
});
```

### Eval 3: Output quality (LLM-as-judge)

Tests whether prioritisation output is energy-aware, deadline-sensitive, and actionable.

```typescript
describeEval('prioritisation quality', {
  data: async () => [
    { input: { tasks: 'deadline_pressure', energy: 'poor_sleep', hour: 9 } },
    { input: { tasks: 'overloaded_queue', energy: 'well_rested', hour: 10 } },
    { input: { tasks: 'mismatched_priorities', energy: 'fragmented', hour: 14 } },
    { input: { tasks: 'light_day', energy: 'evening_person', hour: 8 } },
    { input: { tasks: 'recovery_day', energy: 'burnout', hour: 11 } },
  ],
  task: async (input) => {
    return await runPrioritiseScenario(input);
  },
  scorers: [prioritisationJudge],
  threshold: 0.6,
});
```

The `prioritisationJudge` is a custom scorer that calls Claude as a grader:

```typescript
async function prioritisationJudge({ input, output }) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    system: `You are an eval grader. Score the following prioritisation output 1-5.
Criteria:
1. Did it identify correct upcoming energy windows?
2. Did it assign tasks to appropriate windows based on effort?
3. Did it flag deadline conflicts?
4. Does it say WHEN to do things, not just WHAT?
5. Would the recommendation differ for a different energy scenario?
Return JSON: { "score": <1-5>, "reasoning": "<why>" }`,
    messages: [{ role: 'user', content: `Scenario: ${JSON.stringify(input)}\n\nOutput:\n${output}` }],
  });

  const text = response.content.find(b => b.type === 'text')?.text ?? '{}';
  const { score, reasoning } = JSON.parse(text);
  return { score: score / 5, metadata: { rawScore: score, reasoning } };
}
```

### Scenario matrix

| Tasks | Energy | What it tests |
|-------|--------|---------------|
| `deadline_pressure` | `poor_sleep` | Ruthless triage under low energy |
| `overloaded_queue` | `well_rested` | Filtering — defer what can't fit |
| `mismatched_priorities` | `fragmented` | Deadline proximity over priority label |
| `light_day` | `evening_person` | Don't recommend morning peak for a night owl |
| `recovery_day` | `burnout` | Protect the user, don't just schedule them |

---

## Build Order

### Phase 1: Foundation

1. Project init — `package.json`, `tsconfig.json`, dependencies.
2. Database — schema, connection, `drizzle-kit push`.
3. Seed script — all 5 energy scenarios, all 5 task scenarios, interactive selection.
4. Date parsing helpers — `chrono-node` with GB bias, fixed reference instant.

### Phase 2: Agent core

5. Skill files — write all 5 `SKILL.md` files with frontmatter, reasoning chains, output formats.
6. Skill discovery — scan, parse frontmatter, build summary prompt, `loadSkill`.
7. Tool definitions — meta tools (`load_skill`, `search_tools`) + functional tools + subagent wrappers.
8. Subagents — energy context, task context, task list with pre-trimmed payloads.
9. Agent loop — `generateText` + `prepareStep`, step state selection, message pruning, system prompt assembly.

### Phase 3: CLI

10. Chat loop — Clack prompts, spinner, immediate log lines, markdown rendering.
11. Token usage display — per-turn and per-session accounting.
12. CLI entry point — `commander` with flags, interactive fallback.
13. Step tracing — `--trace-agent` JSONL output.

### Phase 4: Evals

14. Skill routing eval — deterministic, all 5 skills + ambiguous cases.
15. Task resolution safety eval — mutation only after successful resolution.
16. Output quality eval — LLM-as-judge, all 5 scenario pairs.

### Phase 5: Polish

17. Error handling — API failures, malformed tool inputs, ambiguous task matches, empty scenarios.
18. Demo walkthrough — verify all log lines appear, subagent logs visible, markdown renders cleanly.

---

## Implementation Checkpoints

Work proceeds bundle by bundle. Stop after each bundle, run the listed verification steps, and only continue after confirming the results.

### Bundle A: Runtime + Database Foundation

Scope:

1. Project bootstrap — `package.json`, `tsconfig.json`, Bun runtime, base scripts.
2. Database foundation — Drizzle config, SQLite connection, schema for `tasks` and `energy_days`, `data/` directory.

Verification:

```bash
bun install
bun run typecheck
bun run db:push
sqlite3 data/lean-agent.db "select name from sqlite_master where type='table' order by name;"
sqlite3 data/lean-agent.db "pragma table_info(tasks);"
sqlite3 data/lean-agent.db "pragma table_info(energy_days);"
```

Expected: install succeeds, typecheck passes, `tasks` contains `deadline_at`/`deadline_timezone`/`deadline_raw`, `energy_days` contains `timezone`.

### Bundle B: Seed Data + Deadline Parsing

Scope:

3. Seed system — 5 energy scenarios, 5 task scenarios, destructive reset + insert.
4. Date parsing — natural-language deadline parsing, ISO normalization, fixed reference instant.

Verification:

```bash
bun run typecheck
bun run seed -- --list
bun run parse-date -- "tomorrow at 4pm" --ref 2026-03-13T09:00:00.000Z --tz Europe/London
bun run seed -- --energy well_rested --tasks deadline_pressure
bun run seed -- --energy poor_sleep --tasks overloaded_queue
```

Expected: parser returns normalized deadline fields, seeding replaces prior dataset.

### Bundle C: Operation Tools + Task Resolution

Scope:

5. Core operation tools — `create_task`, `update_task`, `delete_task`.
6. Task resolution — `resolve_task` with exact/ambiguous/none thresholds.

Verification:

```bash
bun run typecheck
bun run seed -- --energy well_rested --tasks deadline_pressure
bun run tools -- resolve-task --query "investor memo"
bun run tools -- create-task --title "Write the report" --effort medium --priority high --duration 90 --deadline "tomorrow at 4pm" --category deep_work
bun run tools -- resolve-task --query "report"
bun run tools -- update-task --id <id> --status done
bun run tools -- delete-task --id <id>
```

Expected: resolve finds real task references, CRUD persists correctly, mutation guard blocks unresolved ids.

### Bundle D: Skills + Subagent Wrappers

Scope:

7. Skill discovery and loader — scan `skills/`, parse frontmatter, `load_skill`.
8. Context wrappers — `get_energy_context`, `get_task_context`, `get_task_list` with trimmed payloads.

Verification:

```bash
bun run seed -- --energy well_rested --tasks deadline_pressure
bun run tools list-skills
bun run tools load-skill --name task-prioritise
bun run tools get-energy-context --hour 9 --include-payload
bun run tools get-task-context --include-payload
bun run tools get-task-list --include-payload
```

Expected: skill discovery returns all 5 skills, subagent payloads are trimmed, summaries are compact.

### Bundle E: Main Agent + CLI

Scope:

9. Main agent — `generateText` + `prepareStep`, Zod tool schemas via `zod-to-json-schema`, step state selection, message pruning.
10. CLI shell — Clack input, spinner, immediate log lines, markdown rendering, token usage display, `--trace-agent`.

Verification:

```bash
bun run typecheck
bun run chat --help
printf "%s\n%s\n" "show me my tasks" "quit" | bun run chat --energy well_rested --tasks deadline_pressure --hour 9
printf "%s\n%s\n" "how's my energy right now?" "quit" | bun run chat --energy well_rested --tasks deadline_pressure --hour 9
```

Expected: log lines (`[skill: ...]`, `[tool: ...]`, `[subagent: ...]`) appear, markdown renders, token usage displays. Run sequentially — startup reseeds the same database.

### Bundle F: Safe Mutation Flow

Scope:

11. Integrate `resolve_task` into conversational update/delete. Turn-local mutation guard enforced in code.

Verification: ask to update/delete clearly matching and ambiguous tasks. Confirm exact matches mutate, ambiguous ones prompt for clarification.

### Bundle G: Evals

Scope:

12. Deterministic architecture tests
    - skill routing (`load_skill`)
    - exact-vs-fuzzy tool search behavior
    - turn-local mutation guard
    - cross-turn referential follow-ups from prior assistant text
13. Token / usage regression tests
    - per-turn usage aggregation (`turn`, `session`, `main`, `subagents`)
    - assert no explicit `max_tokens` / `maxTokens` arguments remain in runtime calls
    - trace-driven step assertions for active tool narrowing
14. Quality evals
    - output quality for prioritisation and task listing
    - scenario-based evaluation over seeded task + energy pairs
15. Trace harness
    - reuse `--trace-agent` JSONL structure in tests
    - assert which tools were active at each step
    - assert orchestration messages are pruned after consumption

Implementation plan:

1. Add eval config and shared helpers
   - `evals/vitest.evals.config.ts`
   - helpers for seeding, running `runChatTurn`, and collecting tool/step traces
2. Add deterministic routing tests
   - `show me my tasks` -> `load_skill(task-fetch)` then `search_tools` -> exact `get_task_list`
   - `how's my energy right now?` -> `load_skill(energy-check)` then exact `get_energy_context`
   - `what should I work on next?` -> `load_skill(task-prioritise)` then exact `get_task_context` + `get_energy_context`
3. Add mutation safety tests
   - exact match mutates only after `resolve_task`
   - ambiguous match asks for clarification and does not mutate
   - follow-up references like `complete the first one` resolve from the prior assistant message structure
4. Add usage / trace regression tests
   - verify `runChatTurn()` returns aggregated `main`, `subagents`, and `total` usage
   - verify `search_tools` for known skills returns exact mapped tools only
   - verify later executor steps only activate `load_skill`, `search_tools`, and the exact functional tools selected for that skill
   - verify traces record `system`, `messages`, `activeTools`, `toolCalls`, `toolResults`, and `usage`
5. Add LLM-judge quality evals
   - prioritisation quality
   - task-list usefulness / clarity

Verification:

```bash
bun run typecheck
bun run vitest --config evals/vitest.evals.config.ts evals/skill-routing.eval.ts
bun run vitest --config evals/vitest.evals.config.ts evals/task-resolution.eval.ts
bun run vitest --config evals/vitest.evals.config.ts evals/usage-regression.eval.ts
bun run vitest --config evals/vitest.evals.config.ts evals/output-quality.eval.ts
bun run vitest --config evals/vitest.evals.config.ts
```

Expected:
- known skills activate exact mapped tools, not broad fuzzy expansions
- ambiguous mutation requests never mutate
- token usage accounting is internally consistent
- step traces expose enough information to explain high-cost turns
- quality evals clear the chosen threshold on seeded scenarios

### Bundle H: Error Handling + Polish

Scope:

13. Malformed tool input, API failure, empty-state handling, final demo walkthrough.

Verification: trigger invalid inputs, confirm controlled failures, run full demo path end to end.

## Commit Plan

Commit each bundle immediately after verification:

- `bundle-a: bootstrap bun runtime and database foundation`
- `bundle-b: add deterministic seed data and deadline parsing`
- `bundle-c: add task and energy operation tools`
- `bundle-d: add skill loading and subagent wrappers`
- `bundle-e: add main agent and chat cli`
- `bundle-f: add safe conversational mutation flow`
- `bundle-g: add evals`
- `bundle-h: add error handling and polish`
