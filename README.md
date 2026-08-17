# skills

A collection of [Agent Skills](https://github.com/vercel-labs/skills) following the
`skills/<name>/SKILL.md` convention. Installable with the
[`skills` CLI](https://github.com/vercel-labs/skills) / `find-skills` and compatible
with Claude Code, Cursor, and other agents that read `SKILL.md`.

## Skills

| Skill | Description |
|-------|-------------|
| [`review-gitlab`](skills/review-gitlab/) | Two-phase deep code review of a GitLab merge request, posting only user-approved comments. Talks to GitLab through an embedded zero-dependency Node CLI — no MCP server required. |
| [`review-github`](skills/review-github/) | The same two-phase deep review for a GitHub pull request, driven by the `gh` CLI. |

## Install

With the skills CLI:

```bash
npx skills add thisfrontenddev/skills/skills/review-gitlab
npx skills add thisfrontenddev/skills/skills/review-github
```

The path after the repo name is resolved from the repo root, so the `skills/`
directory is part of it — `thisfrontenddev/skills/review-github` finds nothing.

Or clone and symlink a skill into your agent's skills directory:

```bash
git clone https://github.com/<github-user>/skills.git
ln -s "$(pwd)/skills/skills/review-gitlab" ~/.claude/skills/review-gitlab
```

## review-gitlab

Requires a GitLab token in the environment:

```bash
export MR_MCP_GITLAB_TOKEN=<personal access token with api scope>
export MR_MCP_GITLAB_HOST=https://gitlab.com   # optional, this is the default
```

The skill drives `skills/review-gitlab/scripts/gitlab.mjs`, a zero-dependency CLI
(Node 18+, built-in `fetch`) covering projects, merge requests, diffs, discussions,
diff comments, issues, and note create/edit/delete. Run `node scripts/gitlab.mjs`
with no arguments to list commands.

## review-github

Requires the [GitHub CLI](https://cli.github.com/) authenticated with `repo` scope:

```bash
gh auth login
```

No embedded script — the skill drives `gh pr view`, `gh pr diff`, `gh pr comment`, and
`gh api` for inline review comments and edits.

## License

MIT — see [LICENSE](LICENSE).
