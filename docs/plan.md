# Implementation Plan

## Tech Stack

| Layer | Tool | Why |
|-------|------|-----|
| Runtime | `Node.js 20+` | Required by current `better-sqlite3`. Pin in `package.json` `engines` to avoid install drift. |
| LLM | `@anthropic-ai/sdk` | Direct SDK. Use `anthropic.beta.messages.toolRunner({ stream: true })` for streamed typed tool execution, `betaZodTool` for typed tools, and `beta.messages.countTokens()` for real preflight budget tracking. |
| Database | `better-sqlite3` + `drizzle-orm` | Synchronous SQLite. `drizzle-kit push` for schema sync — no migration files for a demo. |
| Date parsing | `chrono-node` | Parse natural-language deadlines into normalized timestamps for urgency bucketing and scheduling. |
| CLI input | Node `readline` | Built-in. Handles prompt, history, line events. No framework overhead. |
| CLI output | `chalk` | Colored log lines, styled output. Streaming via raw `process.stdout.write()`. |
| CLI commands | `commander` | Zero-dependency arg parser. Subcommands for `chat`, `seed`. Flags for `--hour`, `--energy`. |
| Spinner | `ora` | Loading state between user input and first token. |
| Evals | `vitest-evals` | Vitest-native eval runner from Sentry. Use custom Anthropic-based scorers so eval infra matches the runtime provider. |
| Validation | `zod` | Schema validation for tool inputs. Also powers `betaZodTool` and type derivation. |

---

## Project Structure

```
lean-agent/
├── src/
│   ├── index.ts                 # CLI entry point (commander)
│   ├── chat.ts                  # Chat loop (readline + streaming)
│   ├── agent.ts                 # Main agent (system prompt, tool definitions, message management)
│   ├── context.ts               # Token tracking, compaction logic
│   ├── dates.ts                 # Deadline parsing + ISO normalization helpers
│   ├── skills.ts                # Skill discovery + loadSkill tool
│   ├── tools/
│   │   ├── task-create.ts       # Insert task row
│   │   ├── task-resolve.ts      # Find a task by natural-language reference
│   │   ├── task-update.ts       # Update task row
│   │   ├── task-delete.ts       # Delete task row
│   │   ├── task-fetch.ts        # Query open tasks
│   │   ├── energy-fetch.ts      # Read energy array from DB
│   │   ├── energy-context.ts    # Energy subagent tool — compact curve summary
│   │   └── task-context.ts      # Task subagent tool — compact urgency/effort grouping
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
│   ├── output-quality.eval.ts   # LLM-as-judge quality tests
│   └── compaction.eval.ts       # Context preservation after compaction
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
- Seeded demo scenarios can still use deterministic fixed timestamps.

---

## Skills — Progressive Disclosure

Skills follow a three-phase lifecycle: discover, activate, execute.

### Phase 1: Discovery (startup)

Scan `skills/` directory. Parse frontmatter (`name`, `description`) from each `SKILL.md`. Inject a summary into the system prompt:

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

A `load_skill` tool reads the full `SKILL.md` body and returns it as a `tool_result`. Claude calls this when it decides it needs a skill's reasoning instructions.

```typescript
const loadSkillTool = betaZodTool({
  name: 'load_skill',
  description: 'Load specialized instructions for a skill before performing the task.',
  inputSchema: z.object({
    name: z.string().describe('Skill name to load'),
  }),
  run: async ({ name }) => {
    const skill = discoveredSkills.find(s => s.name === name);
    if (!skill) return `Skill '${name}' not found`;
    const content = readFileSync(skill.path, 'utf-8');
    return stripFrontmatter(content);
  },
});
```

This is turn-scoped by nature — the instructions live in a `tool_result`, not in the system prompt. They do not persist to subsequent turns.

### Phase 3: Execution

After loading instructions, Claude calls the relevant operation tools (`create_task`, `update_task`, etc.) to act on the database.

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

## Tools

Nine tools total: one meta-tool (`load_skill`), six operation tools, two context tools (subagents).

### Operation tools (always available)

| Tool | Input | Effect |
|------|-------|--------|
| `create_task` | `{ title, effort, priority, deadline_raw?, duration_minutes, category? }` | Parse deadline if present, insert row into `tasks`, return the created task with normalized deadline fields. |
| `resolve_task` | `{ query, include_done? }` | Match a natural-language task reference to candidate rows. Returns exact match or a short candidate list for confirmation. |
| `update_task` | `{ id, fields: Partial<Task> }` | Update row. Returns updated task. |
| `delete_task` | `{ id }` | Delete row. Returns confirmation. |
| `fetch_tasks` | `{ status?: string }` | Query tasks. Defaults to non-done. Returns task list. |
| `fetch_energy` | `{ label?: string }` | Query energy scenario. Defaults to today's. Returns the 24-hour array + metadata. |

### Context tools (subagents)

| Tool | Input | Effect |
|------|-------|--------|
| `get_energy_context` | `{ current_hour: number }` | Runs the energy subagent. Returns a compact summary (~60 tokens) of current level, next peak, next dip, next rebound. |
| `get_task_context` | `{}` | Runs the task subagent. Returns a compact summary (~80 tokens) grouping open tasks by deadline urgency and effort. |

These are general-purpose context tools, not tied to any single skill. Claude calls them whenever it needs situational awareness — before prioritising, before creating a task (to know where it fits in the schedule), before deleting (to see what can be reshuffled), before updating (to reason about knock-on effects).

Each tool wraps a standalone `client.messages.create()` call internally. The main agent never sees the subagent's full context — only the compact summary returned as a `tool_result`.

### Task mutation workflow

- Natural-language updates and deletes do not go straight to `update_task` or `delete_task`.
- The agent first calls `resolve_task`.
- If there is one confident match, proceed with the mutation.
- If there are multiple plausible matches, the assistant asks a short clarification question before mutating anything.
- This keeps mutation tools simple while still supporting natural user phrasing like "mark the report task as done".

---

## Subagents

Two subagents exposed as context tools. Each is a standalone `client.messages.create()` call with its own system prompt and constrained output. The main agent calls them whenever it needs situational awareness — not just for prioritisation.

The point of these subagents is deliberate context compression. As task volume grows, passing the raw task table or verbose energy reasoning into the main agent becomes noisy. Each subagent fetches narrow structured data, cleans it up, summarizes only decision-relevant points, and returns a bounded result to the main agent.

### Energy subagent (`get_energy_context`)

- **Input:** 24-value energy array + current hour
- **System prompt:** "You are an energy curve analyst. Return a compact summary: current level, next peak (time range), next dip (time range), next rebound (time range). Max 60 tokens."
- **Output:** ~60 token structured summary
- **Context isolation:** Separate API call. Only the summary string enters the main agent's context.
- **Pre-trim step:** The wrapper sends only the 24-value curve, scenario label, timezone, and current hour. No chat history is forwarded.

### Task subagent (`get_task_context`)

- **Input:** Open task list only, trimmed to `id`, `title`, `effort`, `priority`, `duration_minutes`, `deadline_at`, `status`
- **System prompt:** "You are a task analyst. Group tasks by deadline urgency (overdue, within 8h, within 24h, later, no deadline) and effort level. Return a compact summary. Max 80 tokens."
- **Output:** ~80 token structured summary
- **Context isolation:** Same as above.
- **Pre-trim step:** The wrapper strips unused columns and excludes done tasks before the subagent call.

### When Claude calls them

- **Prioritising:** Calls both in sequence, reasons across the two summaries.
- **Creating a task:** Calls both to understand where the new task fits in the day's schedule and energy curve. Can suggest optimal timing.
- **Updating a task:** Calls `get_task_context` to see the current landscape, may call `get_energy_context` if the change affects scheduling (e.g., bumping effort from low to high).
- **Deleting a task:** Calls `get_task_context` to see what opens up. May recommend reshuffling remaining tasks into freed windows.
- **Energy check:** Calls `get_energy_context` directly — this is the subagent's exact purpose.

Claude decides when to call these based on the situation. The skill instructions in each `SKILL.md` can hint at when context is useful, but the agent is not forced to call them for every operation.

### Scaling rule

- For small seeded scenarios, subagents are still used so the architecture matches the intended scaling pattern.
- If task volume grows, only the subagent payload grows; the main agent still receives the same bounded summaries.
- Keep subagent outputs short and structured so they remain composable.

---

## Context Management

### Token budget

- **Max context:** 10,000 tokens (intentionally low to force compaction during demos)
- **Compaction trigger:** 8,000 tokens
- **Tracking:** Before each main-agent turn, call `client.beta.messages.countTokens()` with the exact payload shape that will be sent next: system prompt, retained messages, and all currently registered tools.
- **Display value:** Show the preflight token count as the running context size after each turn.

### Compaction

When the preflight count crosses 8,000 tokens, a dedicated compaction call fires before the next user turn.

```typescript
async function compact(messages: MessageParam[]): Promise<MessageParam[]> {
  const summary = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 500,
    system: `Compress this conversation history into a structured summary.
Preserve verbatim:
- Today's active energy scenario label
- Any tasks created, updated, or completed this session
- Any explicit user preferences stated this session
- Any unresolved task references awaiting confirmation
Summarise everything else into:
- current objective
- resolved decisions
- open questions
- relevant constraints`,
    messages: [{ role: 'user', content: JSON.stringify(messages) }],
  });

  const summaryText = summary.content.find(b => b.type === 'text')?.text ?? '';
  const recentTurns = messages.slice(-4); // last 2 exchanges

  return [
    { role: 'assistant', content: `[Session summary]\n${summaryText}` },
    ...recentTurns,
  ];
}
```

### Token display

After each turn, log the count:

```
[context: 3,241 / 10,000 tokens]
```

When compaction fires:

```
[compaction fired at 8,012 tokens → compressed to 1,847]
```

---

## CLI Behaviour

### Entry point

```
lean-agent chat [--energy <scenario>] [--hour <0-23>] [--tasks <scenario>]
lean-agent seed --energy <scenario> --tasks <scenario>
```

### Startup flow

1. Parse flags via `commander`.
2. If `--energy` or `--tasks` not provided, prompt interactively using `readline` (list scenarios, let user pick).
3. Run seed for selected scenarios (clear + insert).
   This is intentionally destructive in `chat` mode because this is a throwaway demo / proof of concept, not a persistent personal task manager.
4. Enter chat loop.

### Chat loop

1. `readline` prompts for input.
2. On input:
   - Build messages array (system prompt + conversation history).
   - Preflight with `client.beta.messages.countTokens()`. If >= 8,000, run compaction first, then re-count.
   - Call `client.beta.messages.toolRunner({ stream: true })` with all Zod tools.
3. Stream response:
   - On tool events → log `[skill: task-prioritise]`, `[tool: create_task]`, `[tool: resolve_task]` in chalk dim.
   - On context-tool execution → log `[subagent: energy]` or `[subagent: tasks]`.
   - On `text` deltas → `process.stdout.write(delta)` directly.
   - These interleave naturally because Claude can stream text, call a tool, then continue streaming.
4. After stream completes:
   - Append assistant message to history.
   - Run a new preflight count for the next turn and display `[context: X / 10,000 tokens]`.
   - Return to step 1.

### Streaming + log interleaving

The runner stream produces text and tool events in order. A single response can contain:

```
[text delta] [text delta] ... [tool_use] [tool_result] [text delta] [text delta] ...
```

Handle each event type as it arrives:

- `content_block_start` with `type: 'tool_use'` → log the tool name
- `content_block_delta` with `type: 'text_delta'` → write to stdout
- Between tool calls, the agent may emit text explaining what it's doing — this streams naturally

The log lines (`[skill: ...]`, `[subagent: ...]`, `[context: ...]`) are our additions, printed by the CLI handler, not by Claude.

---

## Seed Data

### Energy scenarios (5 rows)

Stored in the seed script as literal arrays. Labels: `well_rested`, `poor_sleep`, `evening_person`, `fragmented`, `burnout`. Values per the brief.

### Task scenarios (5 sets)

Each scenario is a named set of task rows. Labels: `deadline_pressure`, `overloaded_queue`, `light_day`, `mismatched_priorities`, `recovery_day`.

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
    // Edge cases: all tasks done, no deadlines, empty list
  ],
  task: async (input) => {
    // Call agent with input, intercept the tool call trace, return { result, toolCalls }
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
    { input: 'mark the task as done', expectedTools: [{ name: 'resolve_task' }] }, // ambiguous, should not mutate yet
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
    // Seed scenario, run full agent with "what should I work on?", return output
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
    model: 'claude-sonnet-4-5-20250929',
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

### Eval 4: Context compaction

Tests that long chat sessions preserve current scenario, task mutations, user preferences, and unresolved references after compaction.

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

### Phase 2: Agent core

4. Skill files — write all 5 `SKILL.md` files with frontmatter, reasoning chains, output formats.
5. Skill discovery — scan, parse frontmatter, build summary prompt.
6. Tool definitions — `load_skill` + 6 operation tools.
7. Subagents — energy and task subagent functions.
8. Agent loop — system prompt assembly, `toolRunner({ stream: true })`, tool call handling.

### Phase 3: CLI

9. Chat loop — `readline` input, streaming output, interleaved log lines.
10. Context management — token counting after each turn, compaction when threshold hit.
11. CLI entry point — `commander` with `chat` and `seed` subcommands, flags, interactive fallback.

### Phase 4: Evals

12. Skill routing eval — deterministic, all 5 skills + ambiguous cases.
13. Task resolution safety eval — mutation only after successful resolution.
14. Output quality eval — LLM-as-judge, all 5 scenario pairs.
15. Context compaction eval — preserve scenario state and mutation history.

### Phase 5: Polish

16. Error handling — API failures, malformed tool inputs, ambiguous task matches, empty scenarios.
17. Demo walkthrough — verify all log lines appear, compaction triggers, subagent logs visible.
