---
name: review-gitlab
description: Review a GitLab merge request and post approved comments. Use when the user asks to review a GitLab MR, provides a GitLab merge request URL / `group/project !IID` / `!IID`, or wants a code review posted to GitLab. Talks to GitLab through the embedded zero-dependency CLI at scripts/gitlab.mjs (no MCP server required).
---

You are performing a deep code review on a GitLab merge request. Follow a strict **two-phase workflow**: first analyze and present findings locally, then post only user-approved comments to GitLab.

Large MRs are reviewed in **chunks** for depth. Every finding includes a **fix prompt** for Claude Code.

## GitLab access — embedded CLI

All GitLab interaction goes through the bundled CLI **`scripts/gitlab.mjs`** that ships inside this skill's own directory. Invoke it via Bash as `node <skill-dir>/scripts/gitlab.mjs <command> [flags]`, where `<skill-dir>` is wherever this skill is installed:
- Project-level install (run from the repo root): `node .claude/skills/review-gitlab/scripts/gitlab.mjs …`
- User-level install: `node ~/.claude/skills/review-gitlab/scripts/gitlab.mjs …`

Below, `gitlab.mjs <command>` is shorthand for that full `node <skill-dir>/scripts/gitlab.mjs <command>` invocation. The CLI reads `MR_MCP_GITLAB_TOKEN` (and optional `MR_MCP_GITLAB_HOST`, default `https://gitlab.com`) from the environment. Each command prints JSON to stdout; on error it prints `{"error": "..."}` to stderr and exits non-zero.

**There is no GitLab MCP server.** Do not call any `mcp__gitlab-mr__*` or `mcp__gitlab-mr-edit__*` tool — use the CLI commands below instead.

| Old MCP tool | CLI command | Required flags |
|---|---|---|
| `get_projects` | `get_projects` | — (optional `--verbose`) |
| `list_open_merge_requests` | `list_open_mrs` | `--project-id N` |
| `get_merge_request_details` | `get_mr` | `--project-id N --mr IID` |
| `get_merge_request_diff` | `get_mr_diff` | `--project-id N --mr IID` |
| `get_merge_request_comments` | `get_mr_comments` | `--project-id N --mr IID` |
| `add_merge_request_comment` | `add_mr_comment` | `--project-id N --mr IID --body-file F` |
| `add_merge_request_diff_comment` | `add_diff_comment` | `--project-id N --mr IID --base-sha S --start-sha S --head-sha S --file P --line L --body-file F` |
| `get_issue_details` | `get_issue` | `--project-id N --issue IID` |
| `set_merge_request_description` | `set_mr_description` | `--project-id N --mr IID --body-file F` |
| `set_merge_request_title` | `set_mr_title` | `--project-id N --mr IID --title "…"` |
| `create_merge_request_comment` (Notes API, plain note) | `create_note` | `--project-id N --mr IID --body-file F` |
| `edit_merge_request_comment` | `edit_note` | `--project-id N --mr IID --note-id ID --body-file F` |
| `delete_merge_request_comment` | `delete_note` | `--project-id N --mr IID --note-id ID` |

**Passing comment bodies:** comment/scorecard/description text is large markdown (backticks, newlines, code fences) and is fragile on the command line. For every write command, **Write the body to a temp file first** (e.g. `/tmp/claude-review-<short>.md`) and pass it with `--body-file <path>`. A short `--body "text"` flag exists for trivial one-liners, and `--title-file` mirrors `--body-file` for `set_mr_title`. Add `--verbose` to any read command to get the full unfiltered GitLab payload.

## Input

The user provided: $ARGUMENTS

This can be one of:
- A full GitLab MR URL: `https://gitlab.com/group/project/-/merge_requests/42`
- A path with MR IID: `group/project !42`
- Just an MR IID if the project is obvious from context: `!42`

---

## Phase 0 — Setup

### Step 1: Parse the input

Extract the **project path** (e.g. `group/project`) and **MR IID** (e.g. `42`) from the input.

If given a full URL, parse it:
- `https://gitlab.com/group/subgroup/project/-/merge_requests/42` → project path = `group/subgroup/project`, IID = `42`

### Step 2: Find the project ID

Run `gitlab.mjs get_projects` to list projects. Match the project path (`path_with_namespace`) to find the numeric `id` (the `--project-id`).

If `$ARGUMENTS` contains only an MR IID (like `!42`), ask the user for the project path.

### Step 3: Fetch MR data (3 parallel calls)

Run these **in parallel** (independent Bash calls in one message):
1. `gitlab.mjs get_mr --project-id N --mr IID` — metadata + `diff_refs` (containing `base_sha`, `start_sha`, `head_sha` needed for Phase 2)
2. `gitlab.mjs get_mr_diff --project-id N --mr IID` — the full code diff
3. `gitlab.mjs get_mr_comments --project-id N --mr IID` — **existing review comments** (for deduplication)

---

## Phase 1 — Analyze (READ-ONLY, no GitLab writes)

**CRITICAL: Do NOT run any write command during Phase 1. No `add_mr_comment`, no `create_note`, no `add_diff_comment`, no `edit_note`, no `delete_note`, no `set_mr_*`. Phase 1 is strictly read-only.**

### Step 4: Triage & chunk plan

Count total changed files and estimate total diff character length. Classify the MR:

| Size | Threshold | Strategy |
|------|-----------|----------|
| Small | <15 files OR <50K chars | **Single-pass** — review all diffs together |
| Medium | 15-50 files OR 50K-150K chars | **3-5 chunks** |
| Large | 50+ files OR 150K+ chars | **5-10 chunks**, ~15-25 files each |

**Grouping heuristic** (apply in priority order):
1. **Feature cohorts** — files that work together (e.g. a block's `block.ts` + `Component.tsx` + `index.ts`)
2. **Directory** — `payload/blocks/**`, `components/**`, `app/[locale]/**`, `packages/**`
3. **Config/infra** — `package.json`, CI configs, migrations, docker files → one chunk
4. **Generated/lock files** — `payload-types.ts`, `pnpm-lock.yaml`, `*.gen.ts` → **skip entirely** (note in Skipped Files section)

Print the chunk plan before starting reviews:

```
Review plan: [Single-pass | N chunks]
- Chunk 1: [Label] ([N] files) — file1.ts, file2.ts, ...
- Chunk 2: [Label] ([N] files) — ...
- Skipped: [N] files (generated/lock)
```

### Step 5: Index existing comments

From the `get_mr_comments` results, build a mental index of all existing review comments:
- **`note_id`** (the `id` field of each note — needed for edit/delete operations)
- File path + line number (for diff comments)
- Finding substance / what it's about
- Whether resolved or still open
- Author name

**Rules during review:**
- If a finding is already raised by an existing comment → **skip it** and list in "Previously Raised" section
- If an existing comment points out an issue that appears to be fixed in the current diff → note it as "appears fixed"
- Also check for a comment containing `<!-- CLAUDE_REVIEW_SCORECARD_v1 -->` — if found, note its `note_id` and date for the scorecard update strategy

**Augment previous Claude Code review comments that lack fix prompts:**
- Look for diff comments containing the `<!-- CLAUDE_REVIEW_FINDING -->` marker (posted by a previous run of this skill) that do **not** already contain a `💡 **Fix prompt:**` block
- If the issue is still relevant (not fixed in the current diff), **generate a fix prompt** for it
- List these in a dedicated "Augmented Comments" section in the draft
- These will be **edited into the original comment** (appending the fix prompt block) using the `note_id`
- Note: comments posted before this marker was introduced won't be detected — that's expected

### Step 6: Chunked deep review

For each chunk (or single pass for small MRs):

1. **Print progress header**: `"Reviewing chunk 2/5: Design system components..."`
2. **Extract that chunk's diffs** from the diff data (filter by file paths belonging to this chunk)
3. **For each non-trivial changed file**: use the **Read** tool to read the full local file for broader context around the changes
4. **Analyze** diff + local context for:
   - **Bugs**: Logic errors, off-by-one, null/undefined risks, race conditions
   - **Security**: Injection vulnerabilities, auth issues, data exposure, OWASP top 10
   - **Performance**: N+1 queries, unnecessary re-renders, missing memoization, large payloads
   - **Style**: Violations of project conventions (see CLAUDE.md/AGENTS.md — no native HTML tags, no inline styles, PandaCSS only, strict imports, etc.)
   - **Logic**: Incorrect business logic, missing edge cases, incomplete error handling
   - **Types**: TypeScript type safety issues, overly broad types, missing type guards
5. **Record findings** with: file, line, severity, category, description, **fix prompt**
6. **Do NOT present findings between chunks** — accumulate all findings, present once at the end

### Step 7: Calculate confidence score

Start at **7/10**, then adjust across five dimensions:

#### 1. Coverage
| Adj | Condition |
|-----|-----------|
| +1 | All changed files read with full local context |
| 0 | Most files read, a few skipped (generated/lock) |
| -1 | Chunked review with context gaps between chunks |
| -2 | Many files skipped or only diffs read (no local files) |

#### 2. Code complexity
| Adj | Condition |
|-----|-----------|
| +1 | Straightforward — declarative, config, UI components, translations |
| 0 | Standard — clear control flow, well-structured feature work |
| -1 | Non-trivial — algorithms, state machines, complex data transformations |
| -2 | Highly complex — dynamic code gen, deeply nested async, intricate caching |

#### 3. Security findings
| Adj | Condition |
|-----|-----------|
| +1 | Security-sensitive areas reviewed, no issues found |
| 0 | No security-sensitive code in the MR |
| -1 | Minor security concerns found |
| -2 | Critical security issues found |

#### 4. Test coverage signal
| Adj | Condition |
|-----|-----------|
| +1 | MR includes tests covering the new/changed logic |
| 0 | Existing tests likely cover the changes |
| -1 | No tests and changes affect business logic or data flow |

#### 5. Domain familiarity
| Adj | Condition |
|-----|-----------|
| +1 | Well-documented areas with clear patterns (e.g. Payload blocks) |
| 0 | Standard project areas |
| -1 | Unfamiliar domain, third-party integrations, undocumented APIs |

**Final score = clamp(7 + sum of adjustments, 1, 10)**

Present the breakdown as the criteria table shown in the scorecard format below (one row per dimension with points and explanation).

### Step 8: Present the draft review

Merge all chunk findings, deduplicate, sort by severity (critical first), and present the full draft.

Severity emojis:
- 🔴 **Critical** — bugs, security vulnerabilities, data loss risks
- 🟠 **Warning** — performance issues, potential bugs, logic concerns
- 🟡 **Suggestion** — style issues, minor improvements, best practices
- 🟢 **Nit** — cosmetic, optional, purely stylistic

Use this **exact format**:

```
## MR Review Draft: group/project !IID

**Title:** [MR title]
**Author:** [MR author]
**Branch:** [source_branch] → [target_branch]
**Review method:** [Single-pass | Chunked (N chunks)]
**Files reviewed:** X/Y (Z skipped)

---

### Review Scorecard (will be posted as MR comment)

<!-- CLAUDE_REVIEW_SCORECARD_v1 -->
## 🔍 Review Scorecard

# Confidence Score: [N]/10

| Criteria | Points | Explanation |
|----------|--------|-------------|
| Base | 7 | — |
| Read coverage | [+1/0/-1/-2] | [One-line reason] |
| Code complexity | [+1/0/-1/-2] | [One-line reason] |
| Security | [+1/0/-1/-2] | [One-line reason] |
| Test coverage | [+1/0/-1/-2] | [One-line reason] |
| Familiarity | [+1/0/-1] | [One-line reason] |

**Reviewed:** [X]/[Y] files ([Z] skipped: [reason])
**Method:** [Single-pass review | Chunked deep review (N chunks)]

### Summary
[2-4 sentence assessment. Is it ready to merge? What are the main themes?]

### Findings Breakdown
| Severity | Count | Key Areas |
|----------|-------|-----------|
| Critical | N | [areas or —] |
| Warning  | N | [areas or —] |
| Suggestion | N | [areas or —] |
| Nit | N | [areas or —] |

### Verdict
[APPROVE / APPROVE WITH SUGGESTIONS / REQUEST CHANGES / NEEDS DISCUSSION]
[One sentence explaining the verdict]

---
*Automated review by Claude Code — [N] inline comments posted, [M] existing comments edited with fix prompts*

---

### Previously Raised (will NOT be re-posted)
- `src/foo.tsx:12` — Missing null check (by @author, still open)
- `src/bar.tsx:45` — Unused import (by @author, appears fixed)
*[Or: "No existing review comments found."]*

---

### Augmented Comments (fix prompts for previous Claude Code review comments)

These will be edited into previous `/review-gitlab` comments that lacked a fix prompt:

A1. ✏️ Edit previous review on `[file_path]:[line_number]` (note_id: [id]) — "[original comment summary]"

   💡 **Fix prompt:** "[Imperative fix description referencing exact file paths,
   line numbers, current code, and expected replacement.]"

A2. ✏️ Edit previous review on `[file_path]:[line_number]` (note_id: [id]) — "[original comment summary]"

   💡 **Fix prompt:** "[...]"

*[Or: "No existing comments need augmentation."]*

---

### New Findings

1. 🔴 **Bug** — `[file_path]:[line_number]`
   > [Clear description of the issue]

   💡 **Fix prompt:** "[Imperative description of what to change, referencing exact
   file paths, line numbers, current code, and expected replacement. Specific enough
   to execute without further searching.]"

2. 🟠 **Performance** — `[file_path]:[line_number]`
   > [Clear description of the issue]

   💡 **Fix prompt:** "[...]"

3. 🟡 **Convention** — `[file_path]:[line_number]`
   > [Clear description of the issue]

   💡 **Fix prompt:** "[...]"

[...more findings sorted by severity...]

---

### Skipped Files
- `apps/nextjs/payload-types.ts` — Generated
- `pnpm-lock.yaml` — Lock file
[Or: "No files skipped."]
```

Then ask:

```
**What would you like to post to GitLab?**
- `all` — scorecard + all findings + all augmented comments
- `none` — discard everything
- `scorecard only` — just the scorecard comment
- `1, 3, 5` — scorecard + these numbered findings only
- `all except 2` — scorecard + all findings except these
- `augments only` — scorecard + augmented comment edits only (no new findings)
- `A1, A2` — specific augmented comments only
- `edit 3` — edit an existing posted finding's comment (by note_id from Step 5)
- `delete 3` — delete an existing posted finding's comment (by note_id from Step 5)
- `dry-run <selection>` — preview what would be posted without posting (e.g. `dry-run all`, `dry-run 1, 3`)
- Or edit any finding/prompt before posting
```

If there are no issues found, still present the scorecard with a positive assessment and ask if the user wants to post it.

---

## Phase 2 — Post (only after user approval)

Wait for the user to respond with their selection. Then:

### Step 9: Post approved comments

**Dry-run mode:** If the user's selection starts with `dry-run`, do NOT run any write command. Instead, parse the selection after the `dry-run` prefix (e.g. `dry-run all` → treat as `all`, `dry-run 1, 3` → treat as `1, 3`) and for each action that _would_ be taken, print a summary block:

```
## Dry Run — Actions Preview

The following actions would be taken (nothing was posted):

1. 📝 **Create scorecard comment** (plain note)
   - Command: `gitlab.mjs create_note`
   - Body preview: [first 200 chars of scorecard]...

2. 💬 **Post diff comment** on `src/foo.tsx:42`
   - Command: `gitlab.mjs add_diff_comment`
   - Severity: 🔴 Critical — [category]
   - Body preview: [first 150 chars]...

3. ✏️ **Edit existing comment** (note_id: 12345) — append fix prompt
   - Command: `gitlab.mjs edit_note`
   - Appending: 💡 Fix prompt for [description]

4. ✏️ **Update existing scorecard** (note_id: 67890)
   - Command: `gitlab.mjs edit_note`
   - Body preview: [first 200 chars]...

---
Total: N new comments, M edits, D deletes
Ready to post? Reply with your selection (without `dry-run`) to execute.
```

Then stop and wait for the user's next response. Do NOT proceed to post.

**Normal posting mode:** Based on the user's selection. For every write, **Write the comment body to a temp file** (e.g. `/tmp/claude-review-<n>.md`) and pass `--body-file`:

1. **Scorecard comment**: Post the scorecard (everything between `<!-- CLAUDE_REVIEW_SCORECARD_v1 -->` and the closing `---`) as a general MR comment.

   **Scorecard update strategy:**
   - If an existing comment with `<!-- CLAUDE_REVIEW_SCORECARD_v1 -->` was found in Step 5, **edit it in place**: `gitlab.mjs edit_note --project-id N --mr IID --note-id <recorded id> --body-file <file>`. Append `\n\n> ℹ️ Updated from previous scorecard` at the end of the new scorecard body.
   - If no existing scorecard found, post a new one: `gitlab.mjs create_note --project-id N --mr IID --body-file <file>` (Notes API — creates a plain comment, not a resolvable thread).

2. **Line-level findings**: For each approved finding, post it as a diff comment:
   `gitlab.mjs add_diff_comment --project-id N --mr IID --base-sha <base> --start-sha <start> --head-sha <head> --file <path> --line <line> --body-file <file>` where:
   - `--base-sha` / `--start-sha` / `--head-sha`: from `diff_refs` (fetched in Step 3)
   - `--file`: the file path as shown in the diff
   - `--line`: the line number (maps to `new_line` in the GitLab API — it targets the new version of the file)
   - body file content: `<!-- CLAUDE_REVIEW_FINDING -->\n**[Severity emoji] [Category]**: [description]\n\n💡 **Fix prompt:**\n\`\`\`\n[fix prompt text]\n\`\`\``

   Run the diff-comment commands **in parallel** where possible (independent Bash calls in one message).

3. **Augmented comments**: For each approved augmented comment (A1, A2, etc.), **edit the original comment in place**: `gitlab.mjs edit_note --project-id N --mr IID --note-id <original id> --body-file <file>`. Set the body to the original comment body with the fix prompt block appended:
   - Append: `\n\n💡 **Fix prompt:**\n\`\`\`\n[fix prompt text]\n\`\`\`\n\n*— Fix prompt added by Claude Code review*`

   Edit these **in parallel** where possible.

4. If the user edited any comment text, use the edited version when posting.

5. **Edit/delete existing comments**: If the user chose `edit N` or `delete N`:
   - `edit N` — Ask the user for the new text (or let them provide it inline), then run `gitlab.mjs edit_note --project-id N --mr IID --note-id <id of finding #N> --body-file <file>`.
   - `delete N` — Confirm with the user, then run `gitlab.mjs delete_note --project-id N --mr IID --note-id <id of finding #N>`.

### Step 10: Report results

After posting, report:
```
## Review Posted ✓

Posted to [MR URL]:
- Scorecard comment [posted | edited in place] (confidence: N/10, verdict: [VERDICT])
- [N] inline comments on [files list]
- [M] existing comments edited with fix prompts
- [D] comments deleted (if any)

[Any errors that occurred during posting]
```

If any comment fails to post (e.g. invalid line number for a deleted file), report the error and continue posting the rest.

---

## Fix Prompt Guidelines

When writing fix prompts for findings, follow these rules:
- Reference **exact file paths and line numbers** from the diff
- Describe the **current code** and the **expected replacement** clearly
- **Group related fixes** across files into a single prompt when they share the same root cause
- Use **imperative voice**: "Replace...", "Remove...", "Add...", "Refactor..."
- Be **specific enough** to execute without further codebase searching
- Optimize for Claude Opus/Sonnet — **explicit, no ambiguity**, no pronouns for code references
- Include the import path if a new import is needed
