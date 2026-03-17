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
| Evals | `bun:test` | Bun's built-in test runner. Two-tier eval structure: deterministic tests (no API key) and live tests (real agent calls). Custom `judgeOutput` helper using Vercel AI SDK structured output for LLM-as-judge scoring. |
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
│   ├── helpers.ts               # Shared eval infrastructure (seeding, tracing, judging)
│   ├── skill-routing.eval.ts    # Deterministic + live routing tests
│   ├── task-resolution.eval.ts  # Resolution rules + live mutation safety
│   ├── usage-regression.eval.ts # Token cap assertions + tool narrowing + trace completeness
│   ├── compaction.eval.ts       # Context compaction and preflight counting tests
│   ├── output-quality.eval.ts   # LLM-as-judge quality tests
│   └── trajectory.eval.ts       # Multi-turn follow-ups + mid-trajectory course corrections
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
[tokens: turn 4,231 | session 12,847 | main 3,102 | subagents 1,129 | compaction 412 | context 7,200/10,000]
```

- **turn** — total tokens for this user turn (main + subagents + compaction)
- **session** — cumulative sum across all turns in this chat session
- **main** — main agent steps only (from `result.totalUsage`)
- **subagents** — separate subagent calls only (tracked via `trackSubagentUsage` callback)
- **compaction** — tokens used by the summary call (only shown when compaction fires)
- **context** — current projected context tokens vs. the budget cap

### Why this matters

Most token cost comes from repeated input (system prompt + message history sent on every step), not output. The main/subagent split makes this visible. The session total tracks cumulative cost across the demo. Context compaction keeps long sessions within budget by summarizing older turns (see the Context compaction section above).

### Context compaction

Compaction prevents unbounded context growth in long sessions. It uses the Anthropic `countTokens` API for preflight measurement and a summarization step to compress older turns.

#### Budget and thresholds

| Constant | Value | Purpose |
|----------|-------|---------|
| `CONTEXT_TOKEN_BUDGET` | 10,000 | Display cap shown in the token line |
| `COMPACTION_THRESHOLD` | 8,000 | Trigger compaction when projected context exceeds this |
| `COMPACTION_KEEP_TURNS` | 2 | Number of recent user/assistant turn pairs to retain verbatim |

#### Preflight token counting

`countContextTokens` calls the Anthropic SDK `messages.countTokens` endpoint before each turn. It builds the full payload the model would see — system prompt (including any existing `historySummary`), conversation history, the new user message, and meta tool definitions — and returns the projected `input_tokens`. If no `ANTHROPIC_API_KEY` is set, it returns 0 (graceful degradation for deterministic tests).

#### Compaction flow (`prepareHistoryForTurn`)

1. Count projected context tokens for the current history + new user input.
2. If below `COMPACTION_THRESHOLD`, return the history unchanged.
3. Split history into user/assistant turn pairs.
4. Retain the last `keepTurns` pairs verbatim.
5. Feed the older (pruned) turns — plus any existing `historySummary` — into `summarizeCompactedHistory`.
6. The summary call uses `generateText` with a focused system prompt that preserves durable facts: task names, ordering references, completed mutations, pending clarifications, and user goals.
7. Re-count context tokens with the compacted history + new summary to confirm reduction.
8. Return `{ history, historySummary, contextTokens, compacted, usage }`.

#### Summary injection

The `historySummary` string is injected into the system prompt under a `## Conversation Summary` heading by `buildBaseSystemPrompt`. It appears in every step's system prompt (via `buildStepSystemPrompt`) so the model retains awareness of older context without carrying the full message history.

#### Token display

After compaction, the CLI token line includes compaction cost and context budget:

```
[tokens: turn 4,231 | session 12,847 | main 3,102 | subagents 1,129 | compaction 412 | context 7,200/10,000]
```

The `compaction` segment only appears on turns where compaction fired. The `context` segment always shows current context tokens against the budget.

#### Direct Anthropic SDK usage

Compaction introduces a direct `@anthropic-ai/sdk` dependency alongside the Vercel AI SDK. The `countTokens` endpoint is not available through the AI SDK, so an `Anthropic` client is instantiated at module level (guarded by `ANTHROPIC_API_KEY` presence). Tool schemas are converted via the AI SDK's `asSchema` utility to produce the JSON Schema format that `countTokens` expects.

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

All evals run via `bun:test`. Two tiers per file: **deterministic** tests (no API key, fast, unit-level) and **live** tests (require `ANTHROPIC_API_KEY`, call the real agent, inspect traces).

Run all: `bun run evals`
Run one: `bun test --timeout=120000 evals/skill-routing.eval.ts`

### Shared infrastructure (`evals/helpers.ts`)

| Helper | Purpose |
|--------|---------|
| `liveDescribe` / `liveTest` | Skip live tests when `ANTHROPIC_API_KEY` is absent. |
| `makeChatConfig(overrides?)` | Default config: hour 11, `Europe/London`, fixed reference instant. |
| `seedScenario(energy, tasks)` | Destructive seed before each live test. |
| `runTracedConversation(inputs[], config)` | Runs multi-turn agent calls, collects traces and aggregated usage. |
| `latestTraceForTurn(traces, turnIndex)` | Filters and sorts trace entries for a specific turn. |
| `judgeOutput({ scenario, output, rubric })` | LLM-as-judge via `generateText` with `Output.object` structured output. Returns `{ score: 1-5, reasoning }`. |
| `assertNoExplicitMaxTokenCaps(paths[])` | Asserts no `max_tokens` / `maxTokens` strings in source files. |

### Eval 1: Skill routing (`skill-routing.eval.ts`)

**Deterministic tier:** Tests `searchToolCatalog` directly — known skills return exact mapped tools before fuzzy fallback.

```typescript
expect(searchToolCatalog({ skillName: 'task-fetch', query: 'show tasks' })).toEqual({
  tools: ['get_task_list'],
});
```

**Live tier:** Runs the full agent for each input, inspects the first tool call in the trace to verify `load_skill` targets the correct skill.

| Input | Expected skill |
|-------|---------------|
| `show me my tasks` | `task-fetch` |
| `how's my energy right now?` | `energy-check` |
| `what should I work on next?` | `task-prioritise` |
| `mark the investor memo task as done` | `task-update-delete` |

### Eval 2: Task resolution safety (`task-resolution.eval.ts`)

**Deterministic tier:** Tests `resolveTask` directly — overlapping titles ("Write the report" + "Review the report") return `ambiguous` with 2 candidates.

**Live tier:**

- Exact match mutates: "mark the investor memo task as done" → `resolve_task` + `update_task` called, task status changes to `done`.
- Ambiguous match blocks: "mark the report task as done" (with two report tasks seeded) → `resolve_task` called, `update_task` not called, assistant asks "which one?".
- Referential follow-up: "show me my tasks" then "complete the first one" → second turn calls `resolve_task` + `update_task` using context from the prior assistant message.

### Eval 3: Usage regression (`usage-regression.eval.ts`)

**Deterministic tier:** Asserts no explicit `max_tokens` / `maxTokens` strings in `agent.ts` or any subagent file.

**Live tier:**

- Token aggregation: `total.totalTokens == main.totalTokens + subagents.totalTokens`.
- Tool narrowing: for `task-fetch`, executor steps only activate `['load_skill', 'search_tools', 'get_task_list']` — no extra tools.
- Trace completeness: each step records non-empty `system`, `messages`, `activeTools`, and positive `usage.totalTokens`.

### Eval 4: Output quality (`output-quality.eval.ts`)

**Live tier only.** Uses `judgeOutput` to score agent output 1–5 against a rubric.

| Scenario | Rubric | Min score |
|----------|--------|-----------|
| `poor_sleep` × `deadline_pressure`, hour 11 | Does the response account for low energy, deadline urgency, and recommend *when* to do work? | 3 |
| `well_rested` × `deadline_pressure` | Does the response clearly list open tasks, group meaningfully, and surface deadline risk? | 4 |

### Eval 5: Context compaction (`compaction.eval.ts`)

**Live tier only.** Tests preflight token counting and history compaction.

- **First-turn baseline:** Empty history with a short user input. Verifies `prepareHistoryForTurn` returns `compacted: false`, positive `contextTokens`, and zero compaction usage.
- **Multi-turn compaction:** 3 turn pairs with `thresholdTokens: 1` (force compaction). Verifies the last 2 turns are retained verbatim, older turns are summarized into `historySummary` that preserves key facts (e.g. task names like "Finalize investor memo"), and compaction usage tokens are positive.

### Eval 6: Trajectory handling (`trajectory.eval.ts`)

**Live tier only.** Tests multi-turn coherence and mid-trajectory course correction.

- **Sustained trajectory:** "show me my tasks" → "which one is due first?" → "mark that one done" — verifies the agent maintains context across 3 turns, resolves the referenced task, and mutates it.
- **Course correction:** "show me my tasks" → "actually, how's my energy right now?" → "okay, mark the first one done" — verifies the agent loads `energy-check` in turn 2 (breaking the task flow), then returns to mutation in turn 3 without losing the original task list context.

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

14. Skill routing eval — deterministic `searchToolCatalog` tests + live routing via traces.
15. Task resolution safety eval — deterministic `resolveTask` tests + live mutation/ambiguity/follow-up tests.
16. Usage regression eval — no explicit token caps in source, tool narrowing per step, trace completeness.
17. Output quality eval — LLM-as-judge for prioritisation and task listing.
18. Trajectory eval — multi-turn follow-ups and mid-trajectory course corrections.

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
bun test --timeout=120000 evals/skill-routing.eval.ts
bun test --timeout=120000 evals/task-resolution.eval.ts
bun test --timeout=120000 evals/usage-regression.eval.ts
bun test --timeout=120000 evals/compaction.eval.ts
bun test --timeout=120000 evals/output-quality.eval.ts
bun test --timeout=120000 evals/trajectory.eval.ts
bun run evals
```

Expected:
- known skills activate exact mapped tools, not broad fuzzy expansions
- ambiguous mutation requests never mutate
- token usage accounting is internally consistent
- step traces expose enough information to explain high-cost turns
- quality evals clear the chosen threshold on seeded scenarios
- multi-turn trajectories maintain context and support course correction

## Commit Plan

Commit each bundle immediately after verification:

- `bundle-a: bootstrap bun runtime and database foundation`
- `bundle-b: add deterministic seed data and deadline parsing`
- `bundle-c: add task and energy operation tools`
- `bundle-d: add skill loading and subagent wrappers`
- `bundle-e: add main agent and chat cli`
- `bundle-f: add safe conversational mutation flow`
- `bundle-g: add evals`
