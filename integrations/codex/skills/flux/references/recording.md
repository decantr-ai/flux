# Record meaningful work

Every helper command needs `--session <exact-current-chat-id>`. `snapshot` provides real source IDs. Do not fabricate references. Write JSON to a temporary UTF-8 file and pass its path; keep shell quoting separate from JSON encoding.

`record --json <file>` accepts `{kind, summary, provenance, source, data}`. The CLI stamps project and chat identity and rejects conflicting scope. Common kinds:

- `project_patch`: `data.patch.focus = {title,status,sessionId,intentSourceId,updatedAt,sourceIds,why:{text,sourceIds,provenance},next:{text,status,sourceIds,provenance}}`. Anchor to the latest actual human message after considering whether it changes the work. Mark next as `planned` or `suggested`.
- `item_updated`: `data.item = {id,title,status,purpose,parentId?,returnCondition?,sourceIds}`. Reuse IDs; preserve unfinished work and dependencies.
- `decision_recorded`: `data.decision = {id,title,rationale,status,sourceIds}`. Ideas are not commitments. Separate implementation assessments from the user's planning choices.
- `verification`: include observed scope and limitations in `text`; tool success alone does not establish the intended outcome.
- `goal_updated`: `data.goal` is the approved project goal, not an inferred new task.

`checkpoint --json <file>` accepts `{id,title,steps:[{id,title,status}],sourceIds}`. Use a new checkpoint ID and stable step IDs. Historical status stays historical.

Ideas may include `implementation:{status,completedText,remainingText,provenance,sourceIds}`, where status is `unknown`, `not_started`, `partial`, `in_progress`, `complete` or `research_only`. Respect the user's planned/later/dismissed choice. Add to plan creates pending work; it does not dispatch execution. Update the linked item when authorized rather than recreating it.

For a clarification outside supported native question controls, `question --json <file>` accepts `{id,text,sourceIds,options?}`. Once the public source exists, record one stable identity for each actionable ask. `resolve-question --json <file>` takes `{id,status:"replied",sourceIds,answer}` with the full incoming ID and an exact excerpt from the linked human reply. Explicit closure may use `resolved`, `cancelled` or `superseded` with a reason. Never close questions merely because another turn finished.
