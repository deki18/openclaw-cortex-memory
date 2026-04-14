#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");

const PROGRESS_PATH = path.join(process.cwd(), "docs", "graph-memory-wiki-progress.json");

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    } else {
      out._.push(token);
    }
  }
  return out;
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function findMilestone(doc, milestoneId) {
  return doc.milestones.find((m) => m.id === milestoneId);
}

function findTask(doc, taskId) {
  for (const milestone of doc.milestones) {
    const task = milestone.tasks.find((t) => t.id === taskId);
    if (task) {
      return { milestone, task };
    }
  }
  return null;
}

function evalCondition(current, target, condition) {
  const expr = String(condition || "").trim();
  if (!expr) return false;
  if (expr.includes(">=")) return current >= target;
  if (expr.includes("<=")) return current <= target;
  if (expr.includes("==")) return current === target;
  if (expr.includes(">")) return current > target;
  if (expr.includes("<")) return current < target;
  return false;
}

function recomputeMilestones(doc) {
  for (const milestone of doc.milestones) {
    const total = milestone.tasks.length;
    const completed = milestone.tasks.filter((t) => t.status === "completed").length;
    const inProgress = milestone.tasks.filter((t) => t.status === "in_progress").length;
    const blocked = milestone.tasks.filter((t) => t.status === "blocked").length;

    milestone.progress_percent = total > 0 ? Math.round((completed / total) * 100) : 0;

    if (total > 0 && completed === total) {
      milestone.status = "completed";
    } else if (blocked > 0 && inProgress === 0 && completed === 0) {
      milestone.status = "blocked";
    } else if (inProgress > 0 || completed > 0) {
      milestone.status = "in_progress";
    } else {
      milestone.status = "pending";
    }
  }
}

function recomputeGates(doc) {
  for (const gate of doc.global_release_gates || []) {
    const measured = gate.measured === true;
    if (!measured) {
      gate.status = "pending";
      continue;
    }
    const pass = evalCondition(toNumber(gate.current), toNumber(gate.target), gate.pass_condition);
    gate.status = pass ? "passed" : "pending";
  }
}

function recomputeSummary(doc) {
  const total = doc.milestones.length;
  const completed = doc.milestones.filter((m) => m.status === "completed").length;
  const inProgress = doc.milestones.filter((m) => m.status === "in_progress").length;
  const blocked = doc.milestones.filter((m) => m.status === "blocked").length;
  const pending = doc.milestones.filter((m) => m.status === "pending").length;
  const progress = total > 0
    ? Math.round(doc.milestones.reduce((sum, m) => sum + (toNumber(m.progress_percent) || 0), 0) / total)
    : 0;

  doc.summary = {
    total_milestones: total,
    completed_milestones: completed,
    in_progress_milestones: inProgress,
    blocked_milestones: blocked,
    pending_milestones: pending,
    overall_progress_percent: progress,
  };
}

function touchProject(doc) {
  if (!doc.project) doc.project = {};
  doc.project.last_updated = new Date().toISOString();
}

function normalizeStatus(input) {
  const allowed = new Set(["pending", "in_progress", "completed", "blocked"]);
  const value = String(input || "").trim();
  if (!allowed.has(value)) {
    throw new Error(`Invalid status: ${value}. Allowed: pending|in_progress|completed|blocked`);
  }
  return value;
}

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/update-progress.js show",
      "  node scripts/update-progress.js mark-milestone --id M3 --status in_progress",
      "  node scripts/update-progress.js mark-task --id M3-T1 --status completed",
      "  node scripts/update-progress.js set-check --task M3-T1 --metric graph_view_tool_available --current 1",
      "  node scripts/update-progress.js set-gate --id gate_write_success_rate --current 99",
      "  node scripts/update-progress.js refresh",
    ].join("\n"),
  );
}

function cmdShow(doc) {
  console.log(JSON.stringify({
    project: doc.project,
    summary: doc.summary,
    milestone_status: doc.milestones.map((m) => ({ id: m.id, status: m.status, progress_percent: m.progress_percent })),
    gate_status: (doc.global_release_gates || []).map((g) => ({ id: g.id, status: g.status, current: g.current, target: g.target })),
  }, null, 2));
}

function cmdMarkMilestone(doc, args) {
  const id = String(args.id || "").trim();
  if (!id) throw new Error("Missing --id for mark-milestone");
  const status = normalizeStatus(args.status);
  const milestone = findMilestone(doc, id);
  if (!milestone) throw new Error(`Milestone not found: ${id}`);
  milestone.status = status;
  if (status === "completed") {
    milestone.progress_percent = 100;
    for (const task of milestone.tasks) {
      if (task.status !== "completed") task.status = "completed";
    }
  }
}

function cmdMarkTask(doc, args) {
  const id = String(args.id || "").trim();
  if (!id) throw new Error("Missing --id for mark-task");
  const status = normalizeStatus(args.status);
  const hit = findTask(doc, id);
  if (!hit) throw new Error(`Task not found: ${id}`);
  hit.task.status = status;
}

function cmdSetCheck(doc, args) {
  const taskId = String(args.task || "").trim();
  const metric = String(args.metric || "").trim();
  if (!taskId || !metric) throw new Error("Missing --task or --metric for set-check");
  const hit = findTask(doc, taskId);
  if (!hit) throw new Error(`Task not found: ${taskId}`);
  const check = (hit.task.quantitative_checks || []).find((c) => String(c.metric || "").trim() === metric);
  if (!check) throw new Error(`Check metric not found in ${taskId}: ${metric}`);
  check.current = toNumber(args.current, check.current);
}

function cmdSetGate(doc, args) {
  const id = String(args.id || "").trim();
  if (!id) throw new Error("Missing --id for set-gate");
  const gate = (doc.global_release_gates || []).find((g) => g.id === id);
  if (!gate) throw new Error(`Gate not found: ${id}`);
  gate.current = toNumber(args.current, gate.current);
  gate.measured = true;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd) {
    usage();
    process.exit(1);
  }
  const doc = readJson(PROGRESS_PATH);

  if (cmd === "show") {
    cmdShow(doc);
    return;
  }
  if (cmd === "mark-milestone") {
    cmdMarkMilestone(doc, args);
  } else if (cmd === "mark-task") {
    cmdMarkTask(doc, args);
  } else if (cmd === "set-check") {
    cmdSetCheck(doc, args);
  } else if (cmd === "set-gate") {
    cmdSetGate(doc, args);
  } else if (cmd === "refresh") {
    // no-op, recompute only
  } else {
    usage();
    process.exit(1);
  }

  recomputeMilestones(doc);
  recomputeGates(doc);
  recomputeSummary(doc);
  touchProject(doc);
  writeJson(PROGRESS_PATH, doc);
  console.log(`Updated progress file: ${PROGRESS_PATH}`);
}

try {
  main();
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
}
