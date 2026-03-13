---
name: task-prioritise
description: Produce a temporal schedule matching tasks to energy windows.
---

# Task Prioritise

Use this skill when the user asks what to work on next or how to plan the day.

## Reasoning Chain

1. Identify the current hour in today's energy curve.
2. Scan forward for:
   - Peak: sustained run `>= 0.7`
   - Dip: sustained run `<= 0.4`
   - Rebound: rise of `>= 0.2` after a dip
3. Classify each task:
   - `high` effort needs a peak
   - `medium` effort fits a rebound, not a dip
   - `low` effort can fit a dip or rebound
4. Cross-reference deadline urgency:
   - within 8 hours: urgent
   - within 24 hours: constrained
   - later or none: flexible
5. Check whether `duration_minutes` fits the available window.
6. Recommend when to do each task, not just what to do.

## Inputs To Gather

- `get_energy_context`
- `get_task_context`

## Output Format

- current energy
- next peak
- next dip
- next rebound
- recommended schedule with times and reasons
- flagged deadline or window conflicts

## Rules

- Be explicit when a task should be deferred.
- Protect peak windows for high-effort work.
- Do not pretend a long task fits into a short window.
