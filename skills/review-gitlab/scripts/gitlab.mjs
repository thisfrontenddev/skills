#!/usr/bin/env node
/**
 * Embedded GitLab CLI for the review-gitlab skill.
 *
 * Zero-dependency replacement for the gitlab-mr and gitlab-mr-edit MCP servers.
 * Uses Node's built-in fetch (Node 18+) against the GitLab REST API v4.
 *
 * Env:
 *   MR_MCP_GITLAB_TOKEN  (required)  Personal access token with api scope
 *   MR_MCP_GITLAB_HOST   (optional)  Defaults to https://gitlab.com
 *   MR_MCP_MIN_ACCESS_LEVEL     (optional)  Numeric access level filter for get_projects
 *   MR_MCP_PROJECT_SEARCH_TERM  (optional)  Search filter for get_projects
 *
 * Usage:
 *   node gitlab.mjs <command> [--flag value ...]
 *
 * Every command prints JSON to stdout on success. On failure it prints
 * { "error": "..." } to stderr and exits 1.
 *
 * Text bodies (comments, descriptions) may be passed inline with --body / --title
 * or, preferred for large markdown, via --body-file <path> / --title-file <path>.
 */

import { readFileSync } from "node:fs";

const TOKEN = process.env.MR_MCP_GITLAB_TOKEN;
const HOST = (process.env.MR_MCP_GITLAB_HOST || "https://gitlab.com").replace(/\/+$/, "");
const API = `${HOST}/api/v4`;

if (!TOKEN) {
  fail("MR_MCP_GITLAB_TOKEN environment variable is not set.");
}

function fail(message) {
  process.stderr.write(JSON.stringify({ error: message }, null, 2) + "\n");
  process.exit(1);
}

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function requireArg(args, name) {
  const value = args[name];
  if (value === undefined || value === true || value === "") {
    fail(`Missing required argument: --${name}`);
  }
  return value;
}

function num(args, name) {
  const raw = requireArg(args, name);
  const n = Number(raw);
  if (!Number.isFinite(n)) fail(`--${name} must be a number, got: ${raw}`);
  return n;
}

function resolveText(args, flag) {
  const fileFlag = `${flag}-file`;
  if (args[fileFlag] && args[fileFlag] !== true) {
    try {
      return readFileSync(args[fileFlag], "utf8");
    } catch (err) {
      fail(`Could not read --${fileFlag} (${args[fileFlag]}): ${err.message}`);
    }
  }
  if (args[flag] !== undefined && args[flag] !== true) return String(args[flag]);
  fail(`Provide --${flag} <text> or --${fileFlag} <path>`);
}

function enc(value) {
  return encodeURIComponent(String(value));
}

async function gitlab(path, { method = "GET", query, body } = {}) {
  let url = `${API}${path}`;
  if (query) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) usp.set(k, String(v));
    }
    const qs = usp.toString();
    if (qs) url += `?${qs}`;
  }
  const headers = { "PRIVATE-TOKEN": TOKEN };
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload });
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(`GitLab API ${method} ${path} -> ${res.status} ${res.statusText}${detail ? ` - ${detail}` : ""}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function paginate(path, query = {}) {
  const results = [];
  let page = 1;
  for (;;) {
    const url = `${API}${path}`;
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) usp.set(k, String(v));
    }
    usp.set("per_page", "100");
    usp.set("page", String(page));
    const res = await fetch(`${url}?${usp.toString()}`, {
      headers: { "PRIVATE-TOKEN": TOKEN },
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch {
        /* ignore */
      }
      throw new Error(`GitLab API GET ${path} -> ${res.status} ${res.statusText}${detail ? ` - ${detail}` : ""}`);
    }
    const batch = await res.json();
    if (Array.isArray(batch)) results.push(...batch);
    const next = res.headers.get("x-next-page");
    if (!next) break;
    page = Number(next);
    if (!Number.isFinite(page) || page <= 0) break;
  }
  return results;
}

// ── Commands ───────────────────────────────────────────────────────────

async function get_projects(args) {
  const verbose = Boolean(args.verbose);
  const query = { membership: "true" };
  if (process.env.MR_MCP_MIN_ACCESS_LEVEL) query.min_access_level = process.env.MR_MCP_MIN_ACCESS_LEVEL;
  if (process.env.MR_MCP_PROJECT_SEARCH_TERM) query.search = process.env.MR_MCP_PROJECT_SEARCH_TERM;
  const projects = await paginate(`/projects`, query);
  const out = verbose
    ? projects
    : projects.map((p) => ({
        id: p.id,
        description: p.description,
        name: p.name,
        path: p.path,
        path_with_namespace: p.path_with_namespace,
        web_url: p.web_url,
        default_branch: p.default_branch,
      }));
  print(out.length ? out : "No projects found.");
}

async function list_open_mrs(args) {
  const projectId = num(args, "project-id");
  const verbose = Boolean(args.verbose);
  const mrs = await paginate(`/projects/${enc(projectId)}/merge_requests`, { state: "opened" });
  const out = verbose
    ? mrs
    : mrs.map((mr) => ({
        iid: mr.iid,
        project_id: mr.project_id,
        title: mr.title,
        description: mr.description,
        state: mr.state,
        web_url: mr.web_url,
      }));
  print(out);
}

async function get_mr(args) {
  const projectId = num(args, "project-id");
  const iid = num(args, "mr");
  const verbose = Boolean(args.verbose);
  const mr = await gitlab(`/projects/${enc(projectId)}/merge_requests/${enc(iid)}`);
  const out = verbose
    ? mr
    : {
        title: mr.title,
        description: mr.description,
        state: mr.state,
        web_url: mr.web_url,
        target_branch: mr.target_branch,
        source_branch: mr.source_branch,
        merge_status: mr.merge_status,
        detailed_merge_status: mr.detailed_merge_status,
        diff_refs: mr.diff_refs,
      };
  print(out);
}

async function get_mr_comments(args) {
  const projectId = num(args, "project-id");
  const iid = num(args, "mr");
  const verbose = Boolean(args.verbose);
  const discussions = await paginate(`/projects/${enc(projectId)}/merge_requests/${enc(iid)}/discussions`);
  if (verbose) {
    print(discussions);
    return;
  }
  const unresolved = discussions.flatMap((d) => d.notes || []).filter((n) => n.resolved === false);
  const disscussionNotes = unresolved
    .filter((n) => n.type === "DiscussionNote")
    .map((n) => ({ id: n.id, noteable_id: n.noteable_id, body: n.body, author_name: n.author?.name }));
  const diffNotes = unresolved
    .filter((n) => n.type === "DiffNote")
    .map((n) => ({ id: n.id, noteable_id: n.noteable_id, body: n.body, author_name: n.author?.name, position: n.position }));
  print({ disscussionNotes, diffNotes });
}

async function add_mr_comment(args) {
  const projectId = num(args, "project-id");
  const iid = num(args, "mr");
  const body = resolveText(args, "body");
  const note = await gitlab(`/projects/${enc(projectId)}/merge_requests/${enc(iid)}/discussions`, {
    method: "POST",
    body: { body },
  });
  print(note);
}

async function add_diff_comment(args) {
  const projectId = num(args, "project-id");
  const iid = num(args, "mr");
  const comment = resolveText(args, "body");
  const baseSha = requireArg(args, "base-sha");
  const startSha = requireArg(args, "start-sha");
  const headSha = requireArg(args, "head-sha");
  const filePath = requireArg(args, "file");
  const line = requireArg(args, "line");
  const discussion = await gitlab(`/projects/${enc(projectId)}/merge_requests/${enc(iid)}/discussions`, {
    method: "POST",
    body: {
      body: comment,
      position: {
        base_sha: baseSha,
        start_sha: startSha,
        head_sha: headSha,
        old_path: filePath,
        new_path: filePath,
        position_type: "text",
        new_line: Number(line),
      },
    },
  });
  print(discussion);
}

async function get_mr_diff(args) {
  const projectId = num(args, "project-id");
  const iid = num(args, "mr");
  const diffs = await paginate(`/projects/${enc(projectId)}/merge_requests/${enc(iid)}/diffs`);
  print(diffs.length ? diffs : "No diff data available for this merge request.");
}

async function get_issue(args) {
  const projectId = num(args, "project-id");
  const iid = num(args, "issue");
  const verbose = Boolean(args.verbose);
  const issue = await gitlab(`/projects/${enc(projectId)}/issues/${enc(iid)}`);
  print(verbose ? issue : { title: issue.title, description: issue.description });
}

async function set_mr_description(args) {
  const projectId = num(args, "project-id");
  const iid = num(args, "mr");
  const description = resolveText(args, "body");
  const mr = await gitlab(`/projects/${enc(projectId)}/merge_requests/${enc(iid)}`, {
    method: "PUT",
    body: { description },
  });
  print(mr);
}

async function set_mr_title(args) {
  const projectId = num(args, "project-id");
  const iid = num(args, "mr");
  const title = resolveText(args, "title");
  const mr = await gitlab(`/projects/${enc(projectId)}/merge_requests/${enc(iid)}`, {
    method: "PUT",
    body: { title },
  });
  print(mr);
}

async function create_note(args) {
  const projectId = num(args, "project-id");
  const iid = num(args, "mr");
  const body = resolveText(args, "body");
  const note = await gitlab(`/projects/${enc(projectId)}/merge_requests/${enc(iid)}/notes`, {
    method: "POST",
    body: { body },
  });
  print({ success: true, note_id: note.id, created_at: note.created_at });
}

async function edit_note(args) {
  const projectId = num(args, "project-id");
  const iid = num(args, "mr");
  const noteId = num(args, "note-id");
  const body = resolveText(args, "body");
  const note = await gitlab(`/projects/${enc(projectId)}/merge_requests/${enc(iid)}/notes/${enc(noteId)}`, {
    method: "PUT",
    body: { body },
  });
  print({ success: true, note_id: note.id, updated_at: note.updated_at });
}

async function delete_note(args) {
  const projectId = num(args, "project-id");
  const iid = num(args, "mr");
  const noteId = num(args, "note-id");
  await gitlab(`/projects/${enc(projectId)}/merge_requests/${enc(iid)}/notes/${enc(noteId)}`, {
    method: "DELETE",
  });
  print({ success: true, note_id: noteId, deleted: true });
}

const COMMANDS = {
  get_projects,
  list_open_mrs,
  get_mr,
  get_mr_comments,
  add_mr_comment,
  add_diff_comment,
  get_mr_diff,
  get_issue,
  set_mr_description,
  set_mr_title,
  create_note,
  edit_note,
  delete_note,
};

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    print({ commands: Object.keys(COMMANDS) });
    return;
  }
  const handler = COMMANDS[command];
  if (!handler) fail(`Unknown command: ${command}. Known: ${Object.keys(COMMANDS).join(", ")}`);
  const args = parseArgs(rest);
  try {
    await handler(args);
  } catch (err) {
    fail(err.message ?? String(err));
  }
}

main();
