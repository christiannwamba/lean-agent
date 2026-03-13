This document is the single source of truth for building the CLI demo. Everything a coding agent needs — schema, seed data, skills, context management rules, and evals — is defined here.

---

## Overview

A CLI tool where the user chats with an AI agent about their tasks. The agent reasons about what to do and *when* to do it based on the user's energy curve throughout the day. The domain mirrors Rivva (productivity + wellness) intentionally.

**Tech stack:**

- Anthropic SDK (direct — not Vercel AI SDK)
- SQLite (better-sqlite3) with Drizzle
- Vitest for evals

---

## Database Schema

### Table: `tasks`

| Column | Type | Constraints | Notes |
| --- | --- | --- | --- |
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |  |
| `title` | TEXT | NOT NULL | Task name |
| `effort` | TEXT | NOT NULL | Enum: `low`, `medium`, `high` |
| `priority` | TEXT | NOT NULL | Enum: `low`, `medium`, `high`, `critical` |
| `deadline` | TEXT | NULLABLE | ISO 8601 timestamp. Null = no time pressure |
| `duration_minutes` | INTEGER | NOT NULL | Estimated time to complete |
| `status` | TEXT | NOT NULL, DEFAULT `todo` | Enum: `todo`, `in_progress`, `done` |
| `category` | TEXT | NULLABLE | Enum: `deep_work`, `admin`, `communication`, `creative` |
| `created_at` | TEXT | NOT NULL, DEFAULT current_timestamp | ISO 8601 |

### Table: `energy_days`

| Column | Type | Constraints | Notes |
| --- | --- | --- | --- |
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |  |
| `label` | TEXT | NOT NULL UNIQUE | Scenario name e.g. `well_rested` |
| `date` | TEXT | NOT NULL | ISO date string e.g. `2026-03-13` |
| `hours` | TEXT | NOT NULL | JSON array of 24 floats between 0.0 and 1.0. Index 0 = midnight, index 9 = 9am |

**Example row:**

```json
{
  "label": "well_rested",
  "date": "2026-03-13",
  "hours": [0.1, 0.1, 0.1, 0.1, 0.1, 0.2, 0.4, 0.6, 0.75, 0.88, 0.92, 0.85, 0.65, 0.45, 0.5, 0.6, 0.55, 0.45, 0.35, 0.25, 0.2, 0.15, 0.1, 0.1]
}
```

---

## Seed Data

### Energy Scenarios (5 rows in `energy_days`)

**1. `well_rested`**

Classic circadian arc. Sharp morning rise, peak 10am–12pm (0.85–0.92), post-lunch dip around 1–3pm, partial afternoon rebound, drops off by 9pm.

```json
[0.1, 0.1, 0.1, 0.1, 0.1, 0.2, 0.4, 0.6, 0.75, 0.88, 0.92, 0.85, 0.65, 0.45, 0.5, 0.62, 0.55, 0.45, 0.35, 0.25, 0.2, 0.15, 0.1, 0.1]
```

**2. `poor_sleep`**

Same circadian shape but compressed. Peak never breaks 0.55. Post-lunch dip is near-flatline. Slight evening recovery.

```json
[0.1, 0.1, 0.1, 0.1, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.52, 0.48, 0.35, 0.2, 0.22, 0.3, 0.28, 0.25, 0.2, 0.18, 0.15, 0.1, 0.1, 0.1]
```

**3. `evening_person`**

Flat and disengaged until mid-afternoon. Rises after 4pm, peaks 7–9pm. Useless for morning deep work.

```json
[0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.15, 0.2, 0.22, 0.25, 0.28, 0.3, 0.3, 0.32, 0.38, 0.45, 0.55, 0.68, 0.78, 0.82, 0.75, 0.6, 0.4, 0.2]
```

**4. `fragmented`**

New parent / interrupted day. Short bursts of moderate energy with unpredictable drops. Agent should recommend short, completable tasks only.

```json
[0.1, 0.1, 0.3, 0.2, 0.1, 0.15, 0.55, 0.4, 0.2, 0.6, 0.5, 0.3, 0.2, 0.55, 0.45, 0.3, 0.2, 0.4, 0.35, 0.2, 0.15, 0.1, 0.1, 0.1]
```

**5. `burnout`**

Recovery day. Energy stays low across the board (0.1–0.35), slight bump mid-afternoon. Agent's correct answer is to protect the user from overcommitting.

```json
[0.1, 0.1, 0.1, 0.1, 0.1, 0.12, 0.18, 0.22, 0.28, 0.3, 0.32, 0.3, 0.25, 0.2, 0.35, 0.32, 0.28, 0.22, 0.18, 0.15, 0.12, 0.1, 0.1, 0.1]
```

### Task Scenarios (5 seed sets in `tasks`)

Toggled via a seed script. Each scenario stresses a different aspect of prioritisation logic.

**1. `deadline_pressure`** — 2 high-effort tasks due tomorrow morning + 4 low-effort tasks. Forces the agent to ruthlessly protect the afternoon rebound for the deadline tasks.

**2. `overloaded_queue`** — 12 tasks, mixed effort and priority, no imminent deadlines. Agent must filter down to what's achievable today and explicitly defer the rest.

**3. `light_day`** — 3 tasks, all low-to-medium effort, no hard deadlines. Agent should recommend using the peak window for something higher-leverage and breezing through tasks in off-peak hours.

**4. `mismatched_priorities`** — A `critical` / `high` effort task with deadline 4 days away alongside a `low` priority task due in 3 hours. Tests whether the agent reasons about deadline proximity, not just priority label.

**5. `recovery_day`** — Paired specifically with `burnout` energy. All tasks medium-to-high effort. Correct agent behaviour: defer what can be deferred, batch light admin, protect the user from overcommitting.

---

## Skills

The agent supports 5 skills. Each skill is a set of instructions injected into the messages array for the relevant API call only. Skills are **turn-scoped** — excluded from every subsequent call. No skill debt accumulates in context.

### Skill 1: `task-create`

**Trigger phrases:** "add a task", "create a task", "remind me to", "I need to", "new task"

Extracts task details from the user's message and inserts a new row into `tasks`. If effort, priority, or duration are not stated, the agent infers and confirms.

**Fields to extract or infer:** `title`, `effort`, `priority`, `deadline` (parse natural language e.g. "tomorrow morning" → next 9am), `duration_minutes`, `category`.

**Output:** Confirmation with the full parsed task details.

---

### Skill 2: `task-update-delete`

**Trigger phrases:** "update", "change", "edit", "mark done", "complete", "delete", "remove", "cancel"

Finds the matching task by title similarity, confirms the match, then applies the update or deletion.

**Rules:**

- Never delete without confirming the exact task first
- If multiple tasks match, list them and ask which one
- On status update to `done`, optionally ask if there is a follow-on task

---

### Skill 3: `task-prioritise`

**Trigger phrases:** "what should I work on", "prioritise my tasks", "what's next", "what do I do now", "help me plan"

This is the core reasoning skill. Receives the current hour, the full 24-hour energy array for today, and the full task list. Produces a temporal schedule — not a sorted list, but a recommendation of *when* to do each thing.

**Reasoning chain:**

1. Identify current hour index in the energy array
2. Scan forward to identify upcoming windows:
    - **Peak:** sustained run ≥ 0.7
    - **Dip:** sustained run ≤ 0.4
    - **Rebound:** rise of ≥ 0.2 after a dip
3. Classify each task by required energy window:
    - `high` effort → needs a peak
    - `medium` effort → works in a rebound, not a dip
    - `low` effort → fits in a dip or rebound
4. Cross-reference deadline urgency:
    - Deadline within 8 hours → find next available suitable window today, flag as urgent
    - Deadline within 24 hours → schedule to next ideal window, note time constraint
    - No imminent deadline → schedule to ideal energy match
5. Check `duration_minutes` fits within the window. If a 3-hour task only has a 45-minute rebound, split or defer explicitly
6. Produce a structured recommendation with *when* to do each task, not just *what*

**Output format:**

```
🔋 Current energy: [value] ([low/medium/high])
📈 Next peak: [time range]
📉 Next dip: [time range]
📈 Next rebound: [time range]

Recommended schedule:
• [Time] — [Task title] ([effort], ~[duration]min) — [reason]
• [Time] — [Task title] ...

⚠️ Flagged: [Any tasks with deadline conflicts or window mismatches]
```

---

### Skill 4: `energy-check`

**Trigger phrases:** "how's my energy", "what's my energy like", "am I in a peak", "when's my next dip", "energy today"

Reads the current hour and energy array. Returns a plain-language summary of where the user is in their energy curve, what's coming next, and a one-line recommendation for what type of work to do right now.

**Output format:**

```
🔋 Right now ([time]): [value] — [low/moderate/high energy]
Next peak: [time range] ([value])
Next dip: [time range]
Next rebound: [time range]

Best for right now: [plain language recommendation]
```

---

### Skill 5: `task-fetch`

**Trigger phrases:** "show my tasks", "list my tasks", "what tasks do I have", "what's on my list"

Fetches all non-completed tasks and returns a clean summary grouped by priority. Does not produce scheduling recommendations — that is `task-prioritise`'s job.

**Output format:**

```
📋 Your tasks ([n] open):

Critical
• [Task title] — due [deadline], [effort] effort, ~[duration]min

High
• ...

Medium / Low
• ...
```

---

## Context Management

### Token budget

- Max context window: 10,000 tokens
- Compaction trigger: 80% (8,000 tokens)

### Skill scoping

Skills are injected into the messages array only for the call that needs them. On the next turn they are excluded. The developer controls this explicitly — there is no automatic persistence.

### Subagents

When `task-prioritise` fires, the main agent calls two tool functions before generating its response:

- **Energy subagent** — receives the raw 24-value array and current hour, returns a compact summary (~60 tokens) of current level, next peak, next dip, next rebound
- **Task subagent** — receives the full task list, returns a compact summary (~80 tokens) grouping open tasks by deadline urgency and effort

The main agent reasons across the two summaries only. Neither subagent's full context enters the main agent's context window.

### Compaction

When the conversation reaches 8,000 tokens, a dedicated compaction call fires. It receives the full message history and is instructed to produce a structured summary that:

- **Preserves verbatim (protected fields):**
    - Today's active energy scenario label
    - Any tasks created, updated, or completed in this session
    - Any explicit user preferences stated in this session
- **Summarises everything else**

The message history is then replaced with a single summary message plus the last 2–3 turns in full.

---

## Evals (Vitest)

### Eval 1: Skill routing

Tests whether the correct skill is selected for a given user input.

- **Input:** user message string + current energy scenario label
- **Expected output:** skill name selected by the routing call
- **Pass condition:** selected skill matches expected
- **Returns:** `{ input, expected, actual, pass: boolean }`

**Test cases cover:**

- All 5 skill trigger patterns
- Ambiguous inputs (e.g. "what now?" — prioritise or energy-check?)
- All 5 energy scenarios as context
- Edge cases: empty task list, all tasks done, no deadlines

### Eval 2: Output quality (LLM-as-judge)

Tests whether the prioritisation output is energy-aware, deadline-sensitive, and actionable.

- **Structure:** Construct synthetic conversation history (3–5 turns), inject task + energy scenario, run `task-prioritise`, pass output to a grader Claude call
- **Returns:** `{ score: 1-5, reasoning: string, pass: boolean }`

**Grading criteria:**

- Did the response identify the correct upcoming energy windows?
- Did it assign tasks to appropriate windows based on effort?
- Did it flag deadline conflicts correctly?
- Is the output actionable (does it say *when*, not just *what*?)
- Is the recommendation different across energy scenarios for the same task set? (Proves it's reading energy, not just sorting by priority)

**Scenario combinations to run:**

- `deadline_pressure` × `poor_sleep` — highest stakes test
- `overloaded_queue` × `well_rested` — tests filtering logic
- `mismatched_priorities` × `fragmented` — tests deadline over priority reasoning
- `light_day` × `evening_person` — tests that morning peak isn't recommended for a non-morning person
- `recovery_day` × `burnout` — tests that the agent protects the user, not just schedules them

---

## CLI Behaviour

- User types a message, presses enter
- Agent logs which skill was selected: `[skill: task-prioritise]`
- If subagents fire: `[subagent: energy] → [subagent: tasks]`
- Agent streams response to terminal
- Token count displayed after each turn: `[context: 3,241 / 10,000 tokens]`
- Compaction logged visibly when triggered: `[compaction fired at 8,012 tokens → compressed to 1,847]`

These log lines are intentional. They make the invisible visible for the demo and the video.
