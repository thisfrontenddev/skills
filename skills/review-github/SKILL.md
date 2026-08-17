---
name: review-github
description: Review a GitHub pull request and post approved comments. Use when the user asks to review a GitHub PR, provides a GitHub pull request URL / `owner/repo#N` / `#N`, or wants a code review posted to GitHub. Talks to GitHub through the `gh` CLI (no MCP server required).
---

Deep-review a GitHub pull request in a strict **two-phase workflow**: analyze and present findings locally (Phase 1, read-only), then post only user-approved comments (Phase 2). Large PRs are reviewed in **chunks** for depth. Every finding carries a **fix prompt** for Claude Code.

All GitHub access goes through the `gh` CLI (authenticate once with `gh auth login`; needs `repo` scope). Below, `-R owner/repo` is omitted for brevity — pass it on every command unless the cwd is the target repo.

## Input

The user provided: `$ARGUMENTS` — one of:

- A full PR URL: `https://github.com/owner/repo/pull/42`
- `owner/repo#42`
- `#42` (resolve the repo with `gh repo view --json nameWithOwner`; ask if the cwd isn't the target repo)

## Phase 0 — Fetch

Run these **in parallel** (independent Bash calls in one message):

1. `gh pr view <N> --json title,author,headRefName,baseRefName,headRefOid,url,files,isDraft`
2. `gh pr diff <N>` — the full diff
3. `gh api repos/{owner}/{repo}/pulls/<N>/comments --paginate` — inline review comments
4. `gh api repos/{owner}/{repo}/issues/<N>/comments --paginate` — top-level comments

`headRefOid` is the `commit_id` needed for posting inline comments in Phase 2.

## Phase 1 — Analyze (READ-ONLY)

**CRITICAL: no writes in Phase 1.** No `gh pr comment`, no `gh pr review`, no `--method POST|PATCH|DELETE`.

### Chunk plan

| Size | Threshold | Strategy |
|------|-----------|----------|
| Small | <15 files OR <50K chars | Single-pass |
| Medium | 15–50 files OR 50–150K chars | 3–5 chunks |
| Large | 50+ files OR 150K+ chars | 5–10 chunks, ~15–25 files each |

Group by, in priority order: **feature cohort** (files that work together), **directory**, **config/infra** (`package.json`, CI, migrations, Dockerfiles → one chunk). **Skip entirely** generated and lock files (`*-types.ts`, `*.gen.ts`, `pnpm-lock.yaml`) and list them under Skipped Files. Print the plan before reviewing:

```
Review plan: [Single-pass | N chunks]
- Chunk 1: [Label] ([N] files) — file1.ts, file2.ts, ...
- Skipped: [N] files (generated/lock)
```

### Index existing comments

Record each comment's `id`, path, line, substance, resolved state, and author.

- A finding already raised by an existing comment → **skip it**, list under "Previously Raised" (mark "appears fixed" when the current diff resolves it).
- Note the `id` of any comment containing `<!-- CLAUDE_REVIEW_SCORECARD_v1 -->` — that's the scorecard to update in place.
- Comments containing `<!-- CLAUDE_REVIEW_FINDING -->` but **no** `💡 **Fix prompt:**` block, whose issue is still relevant → generate a fix prompt and list under "Augmented Comments" (Phase 2 PATCHes that comment `id`). Comments predating the marker won't be detected — expected.

### Chunked deep review

Per chunk: print `Reviewing chunk 2/5: [label]...`, extract that chunk's diffs, and **Read the full local file** for every non-trivial change — the diff alone lacks context. Analyze for:

- **Bugs** — logic errors, off-by-one, null/undefined risks, race conditions
- **Security** — injection, auth, data exposure, OWASP top 10
- **Performance** — N+1 queries, unnecessary re-renders, missing memoization, large payloads
- **Conventions** — project rules from CLAUDE.md / AGENTS.md
- **Logic** — wrong business logic, missing edge cases, incomplete error handling
- **Types** — TypeScript safety, overly broad types, missing guards

Record file, line, severity, category, description, fix prompt. **Do not present findings between chunks** — accumulate and present once.

### Confidence score

Start at **7**, sum the adjustments, clamp to 1–10:

| Dimension | +1 | 0 | −1 | −2 |
|---|---|---|---|---|
| Read coverage | All files read w/ local context | Most read, generated skipped | Chunked, context gaps | Diffs only / many skipped |
| Complexity | Declarative, config, UI | Standard feature work | Algorithms, state machines | Codegen, intricate async/caching |
| Security | Sensitive areas reviewed, clean | No sensitive code | Minor concerns | Critical issues |
| Tests | PR adds covering tests | Existing tests likely cover | None, and logic/data flow changed | — |
| Familiarity | Documented area, clear patterns | Standard project area | Unfamiliar domain, undocumented APIs | — |

### Present the draft

Merge chunk findings, deduplicate, sort critical-first. Severities: 🔴 **Critical** (bugs, security, data loss) · 🟠 **Warning** (performance, likely bugs) · 🟡 **Suggestion** (style, best practice) · 🟢 **Nit** (cosmetic).

Use this exact structure:

```
## PR Review Draft: owner/repo#N

**Title:** [title]  ·  **Author:** [author]
**Branch:** [head] → [base]
**Review method:** [Single-pass | Chunked (N chunks)]
**Files reviewed:** X/Y (Z skipped)

---

### Review Scorecard (will be posted as PR comment)

<!-- CLAUDE_REVIEW_SCORECARD_v1 -->
## 🔍 Review Scorecard

# Confidence Score: [N]/10

| Criteria | Points | Explanation |
|----------|--------|-------------|
| Base | 7 | — |
| Read coverage | [+1/0/-1/-2] | [one line] |
| Code complexity | [+1/0/-1/-2] | [one line] |
| Security | [+1/0/-1/-2] | [one line] |
| Test coverage | [+1/0/-1] | [one line] |
| Familiarity | [+1/0/-1] | [one line] |

**Reviewed:** [X]/[Y] files ([Z] skipped: [reason])
**Method:** [Single-pass | Chunked deep review (N chunks)]

### Summary
[2–4 sentences: ready to merge? main themes?]

### Findings Breakdown
| Severity | Count | Key Areas |
|----------|-------|-----------|
| Critical | N | [areas or —] |
| Warning | N | [areas or —] |
| Suggestion | N | [areas or —] |
| Nit | N | [areas or —] |

### Verdict
[APPROVE / APPROVE WITH SUGGESTIONS / REQUEST CHANGES / NEEDS DISCUSSION]
[one sentence]

---
*Automated review by Claude Code — [N] inline comments posted, [M] existing comments edited with fix prompts*

---

### Previously Raised (will NOT be re-posted)
- `src/foo.tsx:12` — Missing null check (by @author, still open)
- `src/bar.tsx:45` — Unused import (by @author, appears fixed)
*[Or: "No existing review comments found."]*

---

### Augmented Comments (fix prompts for previous Claude Code review comments)

A1. ✏️ Edit previous review on `[file]:[line]` (comment id: [id]) — "[original summary]"

   💡 **Fix prompt:** "[...]"

*[Or: "No existing comments need augmentation."]*

---

### New Findings

1. 🔴 **Bug** — `[file]:[line]`
   > [clear description]

   💡 **Fix prompt:** "[imperative, exact paths/lines, current code → expected replacement]"

[...more findings, sorted by severity...]

---

### Skipped Files
- `packages/api/types.gen.ts` — Generated
- `pnpm-lock.yaml` — Lock file
[Or: "No files skipped."]
```

Then ask:

```
**What would you like to post to GitHub?**
- `all` — scorecard + all findings + all augmented comments
- `none` — discard everything
- `scorecard only` — just the scorecard comment
- `1, 3, 5` — scorecard + these numbered findings only
- `all except 2` — scorecard + all findings except these
- `augments only` — scorecard + augmented comment edits only
- `A1, A2` — specific augmented comments only
- `edit N` / `delete N` — edit or delete an existing posted comment (by id from Phase 1)
- `dry-run <selection>` — preview without posting (e.g. `dry-run all`)
- Or edit any finding/prompt before posting
```

With zero findings, still present the scorecard with a positive assessment and offer to post it.

## Phase 2 — Post (only after approval)

**Dry-run:** if the selection starts with `dry-run`, run no write command. Print each action that _would_ be taken (command, target, severity, first ~150 chars of body), then `Total: N new comments, M edits, D deletes`, and **stop**.

**Posting.** Comment bodies are large markdown (backticks, newlines, fences) and are fragile on the command line — **write each body to a temp file first** (e.g. `/tmp/claude-review-<n>.md`) and pass it by reference.

1. **Scorecard** — post everything from `<!-- CLAUDE_REVIEW_SCORECARD_v1 -->` through the closing footer.
   - Existing scorecard id found in Phase 1 → edit in place:
     `gh api --method PATCH repos/{owner}/{repo}/issues/comments/<id> -F body=@<file>`, appending `\n\n> ℹ️ Updated from previous scorecard` to the new body.
   - Otherwise → `gh pr comment <N> --body-file <file>`.

2. **Line-level findings** — one inline comment each, run **in parallel** where possible:

   ```
   gh api --method POST repos/{owner}/{repo}/pulls/<N>/comments \
     -F body=@<file> -f commit_id=<headRefOid> -f path=<path> \
     -F line=<line> -f side=RIGHT
   ```

   Add `-F start_line=<n> -f start_side=RIGHT` for a multi-line span. Body content:

   ````
   <!-- CLAUDE_REVIEW_FINDING -->
   **[emoji] [Category]**: [description]

   💡 **Fix prompt:**
   ```
   [fix prompt text]
   ```
   ````

3. **Augmented comments** — edit the original in place, in parallel where possible:
   `gh api --method PATCH repos/{owner}/{repo}/pulls/comments/<id> -F body=@<file>`, body = original + fix prompt block + `\n\n*— Fix prompt added by Claude Code review*`.

4. **edit N / delete N** — PATCH the same endpoint with new text, or `--method DELETE` after confirming with the user.

If the user edited any text in Phase 1, post the edited version.

**Two GitHub-specific gotchas:**

- `issues/comments/<id>` (top-level, i.e. the scorecard) and `pulls/comments/<id>` (inline) are **separate id spaces** — use the endpoint matching where the comment lives.
- An inline comment is rejected when its line isn't part of the diff for `commit_id`, so a push between Phase 1 and Phase 2 invalidates positions. **Report the failure and keep posting the rest**; never abort the batch.

### Report

```
## Review Posted ✓

Posted to [PR URL]:
- Scorecard comment [posted | edited in place] (confidence: N/10, verdict: [VERDICT])
- [N] inline comments on [files]
- [M] existing comments edited with fix prompts
- [D] comments deleted (if any)

[Any errors that occurred during posting]
```

## Fix prompt guidelines

- Reference **exact file paths and line numbers** from the diff
- Describe the **current code** and the **expected replacement**
- **Group related fixes** sharing one root cause into a single prompt
- Imperative voice: "Replace…", "Remove…", "Add…", "Refactor…"
- Specific enough to execute with no further codebase searching
- No pronouns for code references; include the import path when a new import is needed
