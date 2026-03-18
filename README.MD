# lean-agent

A CLI agent that schedules your tasks around your energy curve. Built to demonstrate how to keep an AI agent's context hygienic so it stays sharp, cheap, and recoverable across long conversations.

Built with the [AI SDK](https://sdk.vercel.ai), [Claude](https://anthropic.com), and [Bun](https://bun.sh).

> Every line of harness code is a vote of no confidence in your model.

For the full story behind this architecture, read [The Most Expensive Cheap Model I Ever Used](BLOG_LINK).

## Quick Start

Prerequisites: [Bun](https://bun.sh) and an `ANTHROPIC_API_KEY`.

```bash
git clone https://github.com/user/lean-agent.git
cd lean-agent
bun install
bun run db:push
bun run chat --energy well_rested --tasks deadline_pressure --hour 11
```

You'll be dropped into a chat. Try:

```
show me my tasks
what should I work on next?
mark the investor memo task as done
```

## Architecture

This agent is designed around four principles: progressive tool exposure, context hygiene, separation of cognitive concerns via subagents, and mutation safety. Each one addresses a specific cost or quality problem that compounds as conversations grow.

### Progressive Tool Exposure

Most agent frameworks load every tool definition into every API call. Three tools with typed Zod schemas can cost 2,000 tokens before the model has started thinking, and that cost repeats on every step of every turn.

lean-agent uses a two-tier tool architecture. The model always sees only two **meta tools**:

```typescript
const META_TOOL_NAMES = ['load_skill', 'search_tools'] as const;
```

**Functional tools** only appear after the model has declared its direction:

```typescript
const FUNCTIONAL_TOOL_NAMES = [
  'create_task',
  'resolve_task',
  'update_task',
  'delete_task',
  'get_energy_context',
  'get_task_context',
  'get_task_list',
] as const;
```

The activation flow:

1. The model calls `load_skill({ name: "task-create" })`. The full skill instructions are loaded locally and injected into the next step's system prompt by `prepareStep`.
2. The model calls `search_tools({ skillName: "task-create" })`. This returns the exact tools mapped to that skill.
3. `prepareStep` reads both results and activates only those tools for the next step.

```typescript
const SKILL_TOOL_MAP: Record<string, FunctionalToolName[]> = {
  'energy-check': ['get_energy_context'],
  'task-create': ['create_task', 'get_task_context', 'get_energy_context'],
  'task-fetch': ['get_task_list'],
  'task-prioritise': ['get_task_context', 'get_energy_context'],
  'task-update-delete': [
    'resolve_task', 'update_task', 'delete_task',
    'get_task_context', 'get_energy_context',
  ],
};
```

The `prepareStep` function that makes this work:

```typescript
prepareStep: ({ steps, messages }) => {
  const stepState = selectStepState(steps);
  const nextMessages = pruneConsumedOrchestrationMessages(messages);
  const nextSystem = buildStepSystemPrompt(
    params.config,
    stepState.activeSkillName,
  );

  return {
    activeTools: stepState.activeTools,
    system: nextSystem,
    messages: nextMessages,
  };
},
```

`selectStepState` walks the step history backward to find the most recent `load_skill` and `search_tools` results. If the model calls `load_skill` again mid-turn to change direction, the new skill wins. Meta tools are always appended, so the model can re-anchor at any point.

#### Why not intent classification?

The common alternative is a `classify_intent` tool forced on step 0 via `requiredTools`. The model classifies the user's message into a category, and `prepareStep` locks it into that category's tools for the rest of the turn.

The problem: classification is a one-way door. If the model misclassifies, or if the user changes direction mid-turn ("actually, how's my energy right now?"), there's no recovery without writing fallback logic. That's more harness.

With `load_skill`, the model can call it again on any step. It's a suggestion the model makes to itself, not a verdict it's stuck with.

#### Why more steps can be cheaper

This architecture adds steps (load_skill → search_tools → functional tool) compared to loading all tools at once. But LLM APIs charge by token, not by request. Three focused steps at ~1,500 tokens each (~4,500 total) is cheaper than one step with all tools loaded (~10,000 tokens). And each step has a cleaner context with less noise competing for the model's attention.

### Context Hygiene

Context rot is the phenomenon where model performance degrades as the context window fills. The same model, same prompt, same question gives worse answers when the context is cluttered. Context management is a quality requirement, not just a cost optimization.

[Progressive tool exposure](#progressive-tool-exposure) (above) is the first line of defense: the model only ever sees the tools and skill instructions it needs for the current path. Three additional mechanisms keep the window hygienic.

#### 1. Surgical pruning of orchestration noise

Between steps, only the routing signals are stripped: `load_skill` and `search_tools` call/result pairs. These are consumed by `prepareStep` and serve no further purpose.

```typescript
function pruneConsumedOrchestrationMessages(messages: ModelMessage[]): ModelMessage[] {
  return pruneMessages({
    messages,
    reasoning: 'none',
    toolCalls: [
      {
        type: 'before-last-message',
        tools: [...META_TOOL_NAMES], // only load_skill and search_tools
      },
    ],
    emptyMessages: 'remove',
  });
}
```

`META_TOOL_NAMES` targets only the routing tools. Everything else stays. Functional tool results (like subagent summaries) remain in the conversation because subagents have already compressed them at the source. That data is already lean. If we pruned it, the model would lose information it needs to reason across the rest of the turn. You never need to prune data you've already made compact before it entered the window.

#### 2. Subagents handle data fetching and reasoning

When the main agent needs task data or energy data, it doesn't fetch raw database rows and reason about them in-context. That would pull it off its trajectory, burning steps on data interpretation instead of answering the user's question.

Instead, it calls dedicated subagents. Each subagent fetches the data, reasons through it in a focused context built for that one job, and returns a compact summary.

```typescript
get_energy_context: aiTool({
  description: 'Return a compact summary of current energy, next peak, next dip, and next rebound.',
  inputSchema: z.object({
    currentHour: z.number().int().min(0).max(23).optional(),
    label: z.string().optional(),
  }),
  execute: async ({ currentHour, label }) => {
    logger.log('subagent', 'energy');
    const result = await getEnergyContext({
      currentHour: currentHour ?? config.currentHour,
      label,
    });
    trackSubagentUsage(result.usage);
    return { summary: result.summary };
  },
}),
```

Each subagent calls `generateText` internally with its own pre-trimmed payload. The main agent receives a `summary` string, never raw rows.

| Subagent | Input | Reasoning | Output |
|----------|-------|-----------|--------|
| `get_energy_context` | 24-value energy array + current hour | Identifies current level, next peak, dip, rebound | Compact energy summary |
| `get_task_context` | Open tasks trimmed to decision-relevant columns | Groups by deadline urgency and effort level | Urgency/effort grouping |
| `get_task_list` | Same trimmed task data | Formats as markdown grouped by priority | User-facing task list |

**Read boundary rule:** The main agent reads exclusively through subagents. Raw database fetch helpers (`fetchTasks`, `fetchEnergy`) are internal. The main agent never sees raw JSON.

**"Don't subagents add extra API calls?"** `generateText` already runs an internal step loop. Every step is effectively a sub-call to the LLM. Even without subagents, the main agent would spend steps making API calls to fetch and reason about data. Subagents don't add fundamentally new work. They move the same work into a focused context where it's done better and with less noise.

#### 3. Compaction as a safety net

The first three mechanisms keep the context hygienic turn-by-turn. But in long conversations, even hygienic history accumulates. When projected context tokens exceed the `COMPACTION_THRESHOLD` (8,000 tokens, 80% of the 10,000-token budget), a compaction call summarizes older history while keeping the last `COMPACTION_KEEP_TURNS` (2) turn pairs verbatim.

| Constant | Value | Purpose |
|----------|-------|---------|
| `CONTEXT_TOKEN_BUDGET` | 10,000 | Display cap in the token line |
| `COMPACTION_THRESHOLD` | 8,000 | Trigger compaction above this |
| `COMPACTION_KEEP_TURNS` | 2 | Recent turns retained verbatim |

Preflight token counting uses the Anthropic SDK's `messages.countTokens` endpoint to measure the full payload before each turn. If below threshold, history passes through unchanged. If above, `prepareHistoryForTurn` splits history into turn pairs, retains the last 2 verbatim, and summarizes the rest into a `historySummary` that's injected into the system prompt.

Compaction is not the solution for a dirty context window. If you skip the first three steps and try to compact noisy context, your summary will be noisy too. But when you compact a hygienic context, the signal is already high. The compaction agent receives clean data and produces an accurate summary. Hygiene first, compaction second.

### Mutation Safety

Mutation safety is enforced in code, not just prompted.

A `resolvedTaskIds` Set is created fresh for each turn inside `buildTools`. When `resolve_task` returns an exact match, the task's `id` is added to the set. `update_task` and `delete_task` check this set before executing:

```typescript
update_task: aiTool({
  description: 'Update an existing task by id after exact resolution in the current turn.',
  inputSchema: z.object({
    id: z.number().int().positive(),
    fields: updateTaskFieldsSchema,
  }),
  execute: ({ id, fields }) => {
    logger.log('tool', 'update_task');
    if (!resolvedTaskIds.has(id)) {
      throw new Error(
        'update_task is blocked until resolve_task returns one exact task in the current turn',
      );
    }
    return updateTask({ id, fields, timezone: config.timezone, referenceInstant: new Date(config.referenceInstant ?? DEFAULT_REFERENCE_ISO) });
  },
}),
```

This is a code-level invariant: no mutation without prior exact resolution in the same turn. If resolution is ambiguous (multiple candidates), the agent asks for clarification. No mutation occurs.

## Skills

Five skills, each defined as a `SKILL.md` file with frontmatter and a full reasoning chain:

| Skill | Trigger phrases | What it does |
|-------|----------------|--------------|
| `task-create` | "add a task", "remind me to", "new task" | Extracts task details from natural language, inserts a row with normalized deadline fields |
| `task-update-delete` | "mark done", "complete", "delete", "remove" | Resolves a task by title similarity, confirms match, applies update or deletion |
| `task-prioritise` | "what should I work on", "what's next", "help me plan" | Produces a temporal schedule matching tasks to energy windows |
| `energy-check` | "how's my energy", "am I in a peak", "energy today" | Summarizes current energy level and upcoming windows |
| `task-fetch` | "show my tasks", "list my tasks", "what's on my list" | Lists open tasks grouped by priority |

Skills follow a three-phase lifecycle: **discover** (scan `skills/` at startup, parse frontmatter, build summary for the base system prompt), **activate** (model calls `load_skill`, instructions injected into system prompt by `prepareStep`), **execute** (model calls `search_tools` to activate functional tools, then uses them).

## Seed Data

### Energy scenarios

| Label | Description |
|-------|-------------|
| `well_rested` | Classic circadian arc. Peak 10am-12pm, post-lunch dip, afternoon rebound. |
| `poor_sleep` | Compressed arc. Peak never breaks 0.55. Post-lunch near-flatline. |
| `evening_person` | Flat until mid-afternoon. Peaks 7-9pm. Useless for morning deep work. |
| `fragmented` | New parent / interrupted day. Short bursts with unpredictable drops. |
| `burnout` | Recovery day. Energy stays low (0.1-0.35). Protect the user from overcommitting. |

### Task scenarios

| Label | Description |
|-------|-------------|
| `deadline_pressure` | 2 high-effort tasks due tomorrow + 4 low-effort tasks. |
| `overloaded_queue` | 12 tasks, mixed effort and priority, no imminent deadlines. |
| `light_day` | 3 tasks, low-to-medium effort, no hard deadlines. |
| `mismatched_priorities` | Critical task due in 4 days vs low-priority task due in 3 hours. |
| `recovery_day` | All medium-to-high effort. Paired with `burnout` energy. |

Energy and task scenarios are independent. Any combination works:

```bash
bun run seed -- --energy poor_sleep --tasks deadline_pressure
bun run seed -- --energy evening_person --tasks light_day
```

## Evals

Run all evals:

```bash
bun run evals
```

Run a single eval:

```bash
bun test --timeout=120000 evals/skill-routing.eval.ts
```

Two tiers per file: **deterministic** tests (no API key, fast) and **live** tests (require `ANTHROPIC_API_KEY`, call the real agent).

| Eval | What it tests |
|------|---------------|
| `skill-routing` | Correct skill loads for given inputs. Deterministic: `searchToolCatalog` returns exact mapped tools. Live: agent traces show correct `load_skill` target. |
| `task-resolution` | Mutation safety. Deterministic: overlapping titles return `ambiguous`. Live: exact matches mutate, ambiguous matches block, referential follow-ups resolve from prior context. |
| `usage-regression` | Token predictability. Deterministic: no hardcoded `max_tokens` in source. Live: usage aggregation consistency, tool narrowing per step, trace completeness. |
| `compaction` | Context compaction. Live: preflight token counting, history summarization preserving key facts, last 2 turns retained verbatim. |
| `output-quality` | LLM-as-judge. Scenarios scored against rubrics: energy-awareness, deadline sensitivity, actionability. |
| `trajectory` | Multi-turn coherence. Sustained trajectory across 3 turns. Course correction (switch skills mid-conversation) and safe return to mutation. |

### LLM-as-judge pattern

The `judgeOutput` helper uses `generateText` with structured output to score agent responses:

```typescript
const judged = await judgeOutput({
  scenario: 'Tasks=deadline_pressure, energy=poor_sleep, hour=11',
  rubric: 'Does the response account for low energy, deadline urgency, and recommend when to do work?',
  output: result.outputs[0],
});
expect(judged.score).toBeGreaterThanOrEqual(3);
```

Returns `{ score: 1-5, reasoning: string }`.

## CLI Reference

```bash
lean-agent chat [--energy <label>] [--tasks <label>] [--hour <0-23>] [--tz <timezone>] [--ref <iso>] [--trace-agent]
lean-agent seed --energy <label> --tasks <label>
```

| Flag | Default | Description |
|------|---------|-------------|
| `--energy` | Interactive prompt | Energy scenario label |
| `--tasks` | Interactive prompt | Task scenario label |
| `--hour` | Current local hour | Simulated hour (0-23) |
| `--tz` | `Europe/London` | Timezone for deadline parsing |
| `--ref` | `2026-03-13T09:00:00.000Z` | Fixed reference instant for reproducible demos |
| `--trace-agent` | Off | Write JSONL trace per step to `traces/` |

If `--energy` or `--tasks` are omitted, the CLI prompts interactively using `@clack/prompts`.

### Token display

After each turn:

```
[tokens: turn 4,231 | session 12,847 | main 3,102 | subagents 1,129 | context 7,200/10,000]
```

When compaction fires:

```
[tokens: turn 4,231 | session 12,847 | main 3,102 | subagents 1,129 | compaction 412 | context 7,200/10,000]
```

| Segment | Meaning |
|---------|---------|
| `turn` | Total tokens this turn (main + subagents + compaction) |
| `session` | Cumulative across all turns |
| `main` | Main agent steps only |
| `subagents` | Subagent calls only |
| `compaction` | Summary call tokens (only shown when compaction fires) |
| `context` | Projected context tokens vs budget |

### Step tracing

`--trace-agent` writes one JSONL record per step to `traces/agent-trace-<timestamp>.jsonl`:

```json
{
  "turnIndex": 0,
  "stepNumber": 1,
  "activeSkillName": "task-fetch",
  "activeTools": ["load_skill", "search_tools", "get_task_list"],
  "system": "...",
  "messages": [],
  "toolCalls": [],
  "toolResults": [],
  "usage": { "inputTokens": 2100, "outputTokens": 45, "totalTokens": 2145 },
  "text": "",
  "finishReason": "tool-calls"
}
```

Use traces when a turn feels expensive, the agent picks the wrong tool, or you want to prove what context was active at each step.

## Project Structure

```
lean-agent/
├── src/
│   ├── index.ts                 # CLI entry point (commander)
│   ├── chat.ts                  # Chat loop (clack prompts + markdown rendering)
│   ├── agent.ts                 # Main agent (generateText + prepareStep)
│   ├── usage.ts                 # Token usage tracking
│   ├── dates.ts                 # Deadline parsing + ISO normalization
│   ├── skills.ts                # Skill discovery + loadSkill
│   ├── subagents/
│   │   ├── energy-context.ts    # Energy subagent
│   │   ├── task-context.ts      # Task subagent
│   │   └── task-list.ts         # Task-list subagent
│   ├── tools/
│   │   ├── task-create.ts       # Insert task row
│   │   ├── task-resolve.ts      # Find task by natural-language reference
│   │   ├── task-update.ts       # Update task row
│   │   ├── task-delete.ts       # Delete task row
│   │   ├── task-fetch.ts        # Internal task query helper
│   │   └── energy-fetch.ts      # Internal energy query helper
│   ├── ui/
│   │   └── render.ts            # Markdown-to-terminal rendering
│   └── db/
│       ├── index.ts             # Database connection
│       ├── schema.ts            # Drizzle table definitions
│       └── seed.ts              # Scenario seeder
├── skills/                      # SKILL.md files with reasoning chains
├── evals/                       # bun:test eval suite
├── drizzle.config.ts
├── package.json
├── LICENSE.md
└── tsconfig.json
```
