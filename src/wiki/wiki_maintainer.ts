import { drainWikiRebuildQueue } from "./wiki_queue";
import { projectWikiKnowledge, writeGraphViewProjection } from "./wiki_projector";
import type { GraphViewData } from "../store/graph_memory_store";

interface LoggerLike {
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}

interface MaintainWikiProjectionArgs {
  memoryRoot: string;
  graphView: GraphViewData;
  maxBatch?: number;
  logger?: LoggerLike;
  force?: boolean;
}

interface MaintainWikiProjectionResult {
  processed: number;
  remaining: number;
  snapshot: {
    view_path: string;
    timeline_path: string;
    snapshot_id: string;
    mermaid_path: string;
    network_markdown_path: string;
  } | null;
  projected:
    | {
      updated_at: string;
      entities_count: number;
      topics_count: number;
      timelines_count: number;
      files: {
        index: string;
        projection_index: string;
        entities_dir: string;
        topics_dir: string;
        timelines_dir: string;
      };
    }
    | null;
}

export function maintainWikiProjection(args: MaintainWikiProjectionArgs): MaintainWikiProjectionResult {
  const drain = drainWikiRebuildQueue({
    memoryRoot: args.memoryRoot,
    maxBatch: args.maxBatch,
  });
  if (drain.drained.length === 0 && args.force !== true) {
    return {
      processed: 0,
      remaining: 0,
      snapshot: null,
      projected: null,
    };
  }
  const snapshot = writeGraphViewProjection({
    memoryRoot: args.memoryRoot,
    view: args.graphView,
  });
  const projected = projectWikiKnowledge({
    memoryRoot: args.memoryRoot,
    graphView: args.graphView,
    queueEvents: drain.drained,
  });
  if (args.logger) {
    args.logger.info(
      `wiki_projection_maintained processed=${drain.drained.length} remaining=${drain.remaining} entities=${projected.entities_count} topics=${projected.topics_count} timelines=${projected.timelines_count}`,
    );
  }
  return {
    processed: drain.drained.length,
    remaining: drain.remaining,
    snapshot,
    projected,
  };
}

export type { MaintainWikiProjectionResult };
