# skills

A collection of [Agent Skills](https://github.com/vercel-labs/skills) following the
`skills/<name>/SKILL.md` convention. Installable with the
[`skills` CLI](https://github.com/vercel-labs/skills) / `find-skills` and compatible
with Claude Code, Cursor, and other agents that read `SKILL.md`.

## Skills

| Skill | Description |
|-------|-------------|
| [`review-gitlab`](skills/review-gitlab/) | Two-phase deep code review of a GitLab merge request, posting only user-approved comments. Talks to GitLab through an embedded zero-dependency Node CLI — no MCP server required. |

## Install

With the skills CLI:

```bash
npx skills add <github-user>/skills/review-gitlab
```

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

## License

MIT — see [LICENSE](LICENSE).
