# Manual Runbook

This runbook lets a human manually verify the same behaviors covered by the Bun eval suite.

## Prerequisites

- `ANTHROPIC_API_KEY` is set in your shell.
- Install dependencies:

```bash
bun install
```

- Confirm the repo compiles:

```bash
bun run typecheck
```

## Useful Commands

Start chat:

```bash
bun run chat --energy well_rested --tasks deadline_pressure --hour 11
```

Start chat with step tracing:

```bash
bun run chat --trace-agent --energy well_rested --tasks deadline_pressure --hour 11
```

Seed a different scenario:

```bash
bun run seed -- --energy poor_sleep --tasks deadline_pressure
```

Inspect tasks:

```bash
sqlite3 data/lean-agent.db "select id, title, status, priority, effort, ifnull(deadline_at,'') from tasks order by id;"
```

Inspect only completed tasks:

```bash
sqlite3 data/lean-agent.db "select id, title, status from tasks where status = 'done' order by id;"
```

Run the full automated suite:

```bash
bun run evals
```

## Scenario 1: Basic Greeting

Purpose:
- confirm the app boots
- confirm a no-tool turn works
- confirm token display is visible

Setup:

```bash
bun run chat --energy poor_sleep --tasks deadline_pressure --hour 11
```

Prompt:

```text
hi
```

Expected behavior:
- assistant replies directly
- no `[skill: ...]` log
- no `[tool: ...]` log
- no `[subagent: ...]` log
- status line includes:
  - `turn`
  - `session`
  - `main`
  - `subagents`
  - `context X/10,000`

This matches:
- `evals/skill-routing.eval.ts`
- `evals/compaction.eval.ts`

## Scenario 2: Skill Routing for Task List

Purpose:
- confirm the model loads the `task-fetch` skill
- confirm it activates only `get_task_list`

Setup:

```bash
bun run chat --trace-agent --energy well_rested --tasks deadline_pressure --hour 11
```

Prompt:

```text
show me my tasks
```

Expected console logs:
- `[skill: task-fetch]`
- `[tool: search_tools]`
- `[subagent: task-list]`

Expected response:
- grouped task list
- deadline risk should be surfaced

Expected trace behavior:
- step 0 starts with meta tools only
- executor steps should show:

```text
activeTools = [load_skill, search_tools, get_task_list]
```

This matches:
- `evals/skill-routing.eval.ts`
- `evals/usage-regression.eval.ts`

## Scenario 3: Skill Routing for Energy

Purpose:
- confirm the model loads the `energy-check` skill

Setup:

```bash
bun run chat --trace-agent --energy poor_sleep --tasks deadline_pressure --hour 11
```

Prompt:

```text
how's my energy right now?
```

Expected console logs:
- `[skill: energy-check]`
- `[tool: search_tools]`
- `[subagent: energy]`

Expected response:
- mentions current energy level
- mentions a next peak, dip, or rebound window if applicable

This matches:
- `evals/skill-routing.eval.ts`

## Scenario 4: Skill Routing for Prioritisation

Purpose:
- confirm the model loads the `task-prioritise` skill
- confirm the answer accounts for both tasks and energy

Setup:

```bash
bun run chat --trace-agent --energy poor_sleep --tasks deadline_pressure --hour 11
```

Prompt:

```text
what should I work on next?
```

Expected console logs:
- `[skill: task-prioritise]`
- `[tool: search_tools]`
- `[subagent: tasks]`
- `[subagent: energy]`

Expected response:
- not just "what" to do
- also "when" to do it
- should account for poor sleep and deadline pressure

This matches:
- `evals/skill-routing.eval.ts`
- `evals/output-quality.eval.ts`

## Scenario 5: Exact Mutation Safety

Purpose:
- confirm exact task references are resolved before mutation

Setup:

```bash
bun run chat --trace-agent --energy well_rested --tasks deadline_pressure --hour 11
```

Prompt:

```text
mark the investor memo task as done
```

Expected console logs:
- `[skill: task-update-delete]`
- `[tool: search_tools]`
- `[tool: resolve_task]`
- `[tool: update_task]`

Expected DB result:

```bash
sqlite3 data/lean-agent.db "select id, title, status from tasks where title = 'Finalize investor memo';"
```

Expected:
- `Finalize investor memo` has `status = done`

This matches:
- `evals/task-resolution.eval.ts`

## Scenario 6: Ambiguous Mutation Safety

Purpose:
- confirm ambiguous references do not mutate

Setup:

```bash
bun run seed -- --energy well_rested --tasks deadline_pressure
bun run tools create-task --title "Write the report" --effort medium --priority high --duration 90
bun run tools create-task --title "Review the report" --effort low --priority medium --duration 30
bun run chat --trace-agent --energy well_rested --tasks deadline_pressure --hour 11
```

Prompt:

```text
mark the report task as done
```

Expected console logs:
- `[tool: resolve_task]`
- no `[tool: update_task]`

Expected response:
- asks a short clarification question
- mentions more than one candidate

Expected DB result:

```bash
sqlite3 data/lean-agent.db "select id, title, status from tasks where title like '%report%' order by id;"
```

Expected:
- both report tasks remain `todo`

This matches:
- `evals/task-resolution.eval.ts`

## Scenario 7: Referential Follow-up

Purpose:
- confirm the assistant can use the prior assistant list as context

Setup:

```bash
bun run chat --trace-agent --energy well_rested --tasks deadline_pressure --hour 11
```

Prompt sequence:

```text
show me my tasks
complete the first one
```

Expected:
- first turn shows an ordered/grouped task list
- second turn calls:
  - `[tool: resolve_task]`
  - `[tool: update_task]`

Expected DB result:

```bash
sqlite3 data/lean-agent.db "select id, title, status from tasks where status = 'done' order by id;"
```

Expected:
- at least one task is now `done`

This matches:
- `evals/task-resolution.eval.ts`

## Scenario 8: Same-Trajectory Multi-turn

Purpose:
- confirm the assistant can stay on a workflow across multiple turns

Setup:

```bash
bun run chat --trace-agent --energy well_rested --tasks deadline_pressure --hour 11
```

Prompt sequence:

```text
show me my tasks
which one is due first?
mark that one done
```

Expected:
- second answer identifies `Finalize investor memo`
- third turn resolves and updates that task

Expected DB result:

```bash
sqlite3 data/lean-agent.db "select id, title, status from tasks where title = 'Finalize investor memo';"
```

Expected:
- `Finalize investor memo` is `done`

This matches:
- `evals/trajectory.eval.ts`

## Scenario 9: Trajectory Change and Return

Purpose:
- confirm the assistant can switch skills mid-conversation and then return safely

Setup:

```bash
bun run chat --trace-agent --energy well_rested --tasks deadline_pressure --hour 11
```

Prompt sequence:

```text
show me my tasks
actually, how's my energy right now?
okay, mark the first one done
```

Expected:
- first turn uses `task-fetch`
- second turn switches to `energy-check`
- third turn returns to `task-update-delete`

Expected console logs:
- second turn shows `[skill: energy-check]`
- third turn shows `[tool: resolve_task]` then `[tool: update_task]`

Expected DB result:

```bash
sqlite3 data/lean-agent.db "select id, title, status from tasks where title = 'Finalize investor memo';"
```

Expected:
- `Finalize investor memo` is `done`

This matches:
- `evals/trajectory.eval.ts`

## Scenario 10: Usage Accounting

Purpose:
- confirm the token display is internally consistent

Setup:

```bash
bun run chat --trace-agent --energy well_rested --tasks deadline_pressure --hour 11
```

Prompt:

```text
what's on my schedule
```

Expected:
- token line appears after response
- `turn = main + subagents + optional compaction`
- `session` grows cumulatively across turns

Expected trace:
- every step has:
  - `system`
  - `messages`
  - `activeTools`
  - `usage`

This matches:
- `evals/usage-regression.eval.ts`

## Scenario 11: No Explicit Max Token Caps

Purpose:
- confirm the codebase is not constraining model output with explicit token caps

Run:

```bash
rg -n "\bmax_tokens\b|\bmaxTokens\b" src package.json skills
```

Expected:
- no matches

This matches:
- `evals/usage-regression.eval.ts`

## Scenario 12: Compaction

Purpose:
- confirm context compaction kicks in after the threshold
- confirm last 2 turns are preserved

There are two ways to verify this.

### Option A: Automated verification

Run only the compaction eval:

```bash
bun test --timeout=120000 --max-concurrency=1 ./evals/compaction.eval.ts
```

Expected:
- `2 pass`
- `0 fail`

### Option B: Manual high-context session

Setup:

```bash
bun run chat --trace-agent --energy well_rested --tasks deadline_pressure --hour 11
```

Use a long conversation with several verbose turns:

```text
show me my tasks
what should I work on next?
how's my energy right now?
explain your reasoning in a little more detail
show me my tasks again
which one is due first?
mark that one done
```

What to watch for:
- `context X/10,000` approaches the threshold
- after compaction, token line includes `compaction N`
- context count should drop relative to the un-compacted trajectory

What compaction does:
- summarizes older turns
- keeps the last 2 turns verbatim
- injects the summary into the system prompt as `## Conversation Summary`

This matches:
- `evals/compaction.eval.ts`

## Scenario 13: Output Quality

Purpose:
- confirm the assistant output is actually useful, not just technically correct

### Prioritisation quality

Setup:

```bash
bun run chat --energy poor_sleep --tasks deadline_pressure --hour 11
```

Prompt:

```text
what should I work on next?
```

Expected:
- recommendation accounts for poor energy
- recommendation accounts for deadline urgency
- recommendation includes timing guidance

### Task-list quality

Setup:

```bash
bun run chat --energy well_rested --tasks deadline_pressure --hour 11
```

Prompt:

```text
what's on my schedule
```

Expected:
- open tasks are clearly listed
- list is grouped meaningfully
- deadline risk is surfaced without filler

This matches:
- `evals/output-quality.eval.ts`

## Trace Inspection

If you started chat with `--trace-agent`, inspect the latest trace file:

```bash
ls -t traces/agent-trace-*.jsonl | head -n 1
```

Then inspect the first few lines:

```bash
LATEST="$(ls -t traces/agent-trace-*.jsonl | head -n 1)"
sed -n '1,20p' "$LATEST"
```

Each JSONL line includes:
- `turnIndex`
- `stepNumber`
- `activeSkillName`
- `activeTools`
- `system`
- `messages`
- `toolCalls`
- `toolResults`
- `usage`

Use this when:
- a turn feels too expensive
- the agent appears to choose the wrong tool
- you want to prove what context was active at each step

## Recommended Smoke Test Order

If you only want a fast confidence pass, use this order:

1. `hi`
2. `show me my tasks`
3. `how's my energy right now?`
4. `what should I work on next?`
5. `mark the investor memo task as done`
6. `show me my tasks`
7. `complete the first one`
8. `actually, how's my energy right now?`
9. `okay, mark the first one done`

That sequence covers:
- greeting
- routing
- read paths
- subagents
- mutation safety
- referential follow-up
- trajectory switching
- token display
