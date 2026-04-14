import * as fs from "fs";
import * as path from "path";
import type { GraphViewData } from "../store/graph_memory_store";

interface LintIssue {
  id: string;
  category:
    | "pending_conflicts"
    | "projection_lag"
    | "orphan_pages"
    | "stale_claims"
    | "missing_pages"
    | "evidence_gaps"
    | "projection_consistency"
    | "markdown_structure";
  severity: "info" | "warn" | "error";
  summary: string;
  next_action: string;
  metadata?: Record<string, unknown>;
}

interface LintMemoryWikiArgs {
  memoryRoot: string;
  graphView: GraphViewData;
}

interface LintMemoryWikiResult {
  generated_at: string;
  summary: {
    total_issues: number;
    by_category: Record<string, number>;
  };
  categories: Array<
    "pending_conflicts"
    | "projection_lag"
    | "orphan_pages"
    | "stale_claims"
    | "missing_pages"
    | "evidence_gaps"
    | "projection_consistency"
    | "markdown_structure"
  >;
  issues: LintIssue[];
}

function readJsonl(filePath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/).filter(Boolean);
  const output: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    try {
      output.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Ignore malformed lines.
    }
  }
  return output;
}

function slugify(value: string): string {
  const normalized = (value || "").trim().toLowerCase();
  if (!normalized) return "unknown";
  return normalized.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function readJson(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const text = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function listMarkdownFiles(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  try {
    return fs.readdirSync(dirPath).filter(file => file.toLowerCase().endsWith(".md"));
  } catch {
    return [];
  }
}

function hasRequiredTimelineSections(markdown: string): boolean {
  return markdown.includes("## Summary")
    && markdown.includes("## Timeline")
    && markdown.includes("## Latest Status");
}

export function lintMemoryWiki(args: LintMemoryWikiArgs): LintMemoryWikiResult {
  const now = new Date().toISOString();
  const issues: LintIssue[] = [];
  const categories: Array<
    "pending_conflicts"
    | "projection_lag"
    | "orphan_pages"
    | "stale_claims"
    | "missing_pages"
    | "evidence_gaps"
    | "projection_consistency"
    | "markdown_structure"
  > = [
    "pending_conflicts",
    "projection_lag",
    "orphan_pages",
    "stale_claims",
    "missing_pages",
    "evidence_gaps",
    "projection_consistency",
    "markdown_structure",
  ];

  const conflictPath = path.join(args.memoryRoot, "graph", "conflict_queue.jsonl");
  const pendingConflicts = readJsonl(conflictPath).filter(item => item.status === "pending");
  if (pendingConflicts.length > 0) {
    issues.push({
      id: "lint_pending_conflicts",
      category: "pending_conflicts",
      severity: "warn",
      summary: `${pendingConflicts.length} pending conflicts need confirmation.`,
      next_action: "Run resolve_graph_conflict to accept/reject pending items.",
      metadata: { pending_count: pendingConflicts.length },
    });
  }

  const graphPath = path.join(args.memoryRoot, "graph", "memory.jsonl");
  const projectionIndexPath = path.join(args.memoryRoot, "wiki", ".projection_index.json");
  const graphMtime = fs.existsSync(graphPath) ? fs.statSync(graphPath).mtimeMs : 0;
  const projectionMtime = fs.existsSync(projectionIndexPath) ? fs.statSync(projectionIndexPath).mtimeMs : 0;
  const lagSeconds = graphMtime > projectionMtime ? Math.floor((graphMtime - projectionMtime) / 1000) : 0;
  if (lagSeconds > 0) {
    issues.push({
      id: "lint_projection_lag",
      category: "projection_lag",
      severity: lagSeconds > 30 ? "warn" : "info",
      summary: `Wiki projection is behind graph updates by ${lagSeconds}s.`,
      next_action: "Trigger wiki projection maintenance to catch up queue events.",
      metadata: { lag_seconds: lagSeconds },
    });
  }

  const entitiesDir = path.join(args.memoryRoot, "wiki", "entities");
  const entityFiles = fs.existsSync(entitiesDir)
    ? fs.readdirSync(entitiesDir).filter(file => file.toLowerCase().endsWith(".md"))
    : [];
  const graphEntitySlugs = new Set(args.graphView.nodes.map(node => slugify(node.id)));
  const orphanPages = entityFiles.filter(file => !graphEntitySlugs.has(slugify(file.replace(/\.md$/i, ""))));
  if (orphanPages.length > 0) {
    issues.push({
      id: "lint_orphan_pages",
      category: "orphan_pages",
      severity: "warn",
      summary: `${orphanPages.length} entity pages have no corresponding graph node.`,
      next_action: "Rebuild projection or remove stale orphan pages.",
      metadata: { orphan_pages: orphanPages },
    });
  }

  const missingPages = args.graphView.nodes
    .map(node => `${slugify(node.id)}.md`)
    .filter(file => !entityFiles.includes(file));
  if (missingPages.length > 0) {
    issues.push({
      id: "lint_missing_pages",
      category: "missing_pages",
      severity: "error",
      summary: `${missingPages.length} graph entities are missing wiki pages.`,
      next_action: "Run projection rebuild to generate missing entity pages.",
      metadata: { missing_pages: missingPages },
    });
  }

  const wikiRoot = path.join(args.memoryRoot, "wiki");
  const topicsDir = path.join(wikiRoot, "topics");
  const timelinesDir = path.join(wikiRoot, "timelines");
  const topicFiles = listMarkdownFiles(topicsDir);
  const timelineFiles = listMarkdownFiles(timelinesDir);
  const structuralMissing: string[] = [];
  for (const required of ["index.md", "log.md"]) {
    if (!fs.existsSync(path.join(wikiRoot, required))) {
      structuralMissing.push(required);
    }
  }
  if (!fs.existsSync(timelinesDir)) {
    structuralMissing.push("timelines/");
  }
  const sectionMissing: string[] = [];
  for (const file of [...topicFiles.map(name => path.join(topicsDir, name)), ...timelineFiles.map(name => path.join(timelinesDir, name))]) {
    const markdown = fs.readFileSync(file, "utf-8");
    if (!hasRequiredTimelineSections(markdown)) {
      sectionMissing.push(path.relative(wikiRoot, file).replace(/\\/g, "/"));
    }
  }
  if (structuralMissing.length > 0 || sectionMissing.length > 0) {
    issues.push({
      id: "lint_wiki_markdown_structure",
      category: "markdown_structure",
      severity: structuralMissing.length > 0 ? "error" : "warn",
      summary: `Wiki markdown structure check failed (missing=${structuralMissing.length}, invalid_sections=${sectionMissing.length}).`,
      next_action: "Regenerate wiki projection so required files and Summary/Timeline/Latest Status sections are restored.",
      metadata: {
        error_code: "wiki_markdown_check_failed",
        missing: structuralMissing,
        invalid_sections: sectionMissing,
      },
    });
  }

  const projectionIndex = readJson(projectionIndexPath);
  const projectionMissing: string[] = [];
  for (const listKey of ["entities", "topics", "timelines"] as const) {
    const rows = Array.isArray(projectionIndex?.[listKey]) ? projectionIndex?.[listKey] as Array<Record<string, unknown>> : [];
    for (const row of rows) {
      const relPath = typeof row.path === "string" ? row.path.trim() : "";
      if (!relPath) continue;
      const absPath = path.join(wikiRoot, relPath);
      if (!fs.existsSync(absPath)) {
        projectionMissing.push(relPath);
      }
    }
  }
  if (projectionMissing.length > 0) {
    issues.push({
      id: "lint_projection_consistency",
      category: "projection_consistency",
      severity: "warn",
      summary: `${projectionMissing.length} projection index entries point to missing wiki files.`,
      next_action: "Rebuild wiki projection index after regenerating entities/topics/timelines pages.",
      metadata: {
        error_code: "wiki_projection_inconsistent_check_failed",
        missing_projection_paths: projectionMissing,
      },
    });
  }

  const staleClaims: string[] = [];
  for (const file of entityFiles) {
    const filePath = path.join(entitiesDir, file);
    const text = fs.readFileSync(filePath, "utf-8");
    const currentSection = text.split("## Current Facts")[1]?.split("##")[0] || "";
    if (currentSection.includes("/superseded") || currentSection.includes("/rejected")) {
      staleClaims.push(file);
    }
  }
  if (staleClaims.length > 0) {
    issues.push({
      id: "lint_stale_claims",
      category: "stale_claims",
      severity: "warn",
      summary: `${staleClaims.length} entity pages show stale superseded/rejected claims as current.`,
      next_action: "Rebuild affected entity pages from latest graph view.",
      metadata: { stale_pages: staleClaims },
    });
  }

  const evidenceGapEdges = args.graphView.edges.filter(edge => !edge.evidence_span || typeof edge.confidence !== "number");
  if (evidenceGapEdges.length > 0) {
    issues.push({
      id: "lint_evidence_gaps",
      category: "evidence_gaps",
      severity: "error",
      summary: `${evidenceGapEdges.length} relations are missing evidence_span/confidence.`,
      next_action: "Backfill evidence metadata or reject low-quality relations.",
      metadata: {
        sample: evidenceGapEdges.slice(0, 10).map(edge => ({
          source: edge.source,
          type: edge.type,
          target: edge.target,
          status: edge.status,
        })),
      },
    });
  }

  const byCategory: Record<string, number> = {};
  for (const category of categories) {
    byCategory[category] = issues.filter(issue => issue.category === category).length;
  }

  return {
    generated_at: now,
    summary: {
      total_issues: issues.length,
      by_category: byCategory,
    },
    categories,
    issues,
  };
}

export type { LintMemoryWikiResult };
