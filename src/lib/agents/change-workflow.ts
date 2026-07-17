export type ChangeWorkflowMode = "standard" | "deep-diagnostic";

export type ChangeWorkflow = {
  mode: ChangeWorkflowMode;
  bugLike: boolean;
  forceDeepDiagnostic: boolean;
  previousFailedChangeCount: number;
  reasons: string[];
  acceptanceFocus: string[];
};

const BUG_LIKE_CHANGE_PATTERNS = [
  /\bbug\b/i,
  /\bbroken\b/i,
  /\berror\b/i,
  /\bcrash(?:es|ed|ing)?\b/i,
  /\bfail(?:s|ed|ing)?\b/i,
  /\bfrozen\b/i,
  /\bstuck\b/i,
  /\bnot\s+(?:work|working|saving|showing|appearing|loading|updating|persisting)\b/i,
  /\bdoes(?:n['’]?t| not)\s+(?:work|save|show|appear|load|update|persist)\b/i,
  /\bcan(?:n['’]?t| not)\s+(?:save|open|change|edit|delete|create|submit|log in|login)\b/i,
  /\bwon['’]?t\s+(?:save|open|change|edit|delete|create|submit|load)\b/i,
  /\bsave\b/i,
  /\bsaving\b/i,
  /\bsubmit\b/i,
  /\bbutton\b/i,
  /\bmissing\b/i,
];

const RETRY_CHANGE_PATTERNS = [
  /\bagain\b/i,
  /\bstill\b/i,
  /\btried\b/i,
  /\bretry\b/i,
  /\bprevious\b/i,
  /\bdidn['’]?t\s+fix\b/i,
];

export function selectChangeWorkflow(input: {
  changeSummary: string;
  forceDeepDiagnostic?: boolean;
  previousFailedChangeCount?: number;
}): ChangeWorkflow {
  const summary = input.changeSummary.trim();
  const forceDeepDiagnostic = input.forceDeepDiagnostic ?? false;
  const previousFailedChangeCount = input.previousFailedChangeCount ?? 0;
  const bugLike = BUG_LIKE_CHANGE_PATTERNS.some((pattern) =>
    pattern.test(summary),
  );
  const retryLike = RETRY_CHANGE_PATTERNS.some((pattern) =>
    pattern.test(summary),
  );
  const reasons: string[] = [];
  if (forceDeepDiagnostic) {
    reasons.push("manual Deep Diagnostic Change Mode requested");
  }
  if (bugLike) reasons.push("bug-like change request");
  if (retryLike) reasons.push("retry wording in change request");
  if (previousFailedChangeCount > 0) {
    reasons.push(`${previousFailedChangeCount} prior failed change attempt(s)`);
  }

  const mode: ChangeWorkflowMode =
    forceDeepDiagnostic || bugLike || retryLike || previousFailedChangeCount > 0
      ? "deep-diagnostic"
      : "standard";

  return {
    mode,
    bugLike,
    forceDeepDiagnostic,
    previousFailedChangeCount,
    reasons: reasons.length > 0 ? reasons : ["routine targeted change"],
    acceptanceFocus: inferAcceptanceFocus(summary),
  };
}

function inferAcceptanceFocus(changeSummary: string): string[] {
  const summary = changeSummary.toLowerCase();
  const focus: string[] = [];
  if (/\bsav|submit|persist|create|update/.test(summary)) {
    focus.push(
      "Fill required fields, save or submit, see the result immediately, and verify it persists after refresh when the app stores data.",
    );
  }
  if (/\bsearch|filter|sort/.test(summary)) {
    focus.push(
      "Search, filter, or sort controls change the visible list/table without hiding valid results or crashing.",
    );
  }
  if (/\bdrag|drop|kanban|board|status/.test(summary)) {
    focus.push(
      "Moving an item through the board/status workflow updates visible state and stored data.",
    );
  }
  if (/\bexport|csv|download/.test(summary)) {
    focus.push(
      "Export controls produce user-visible output without external services or broken browser APIs.",
    );
  }
  if (/\bcomment|note|history/.test(summary)) {
    focus.push(
      "Comments, notes, or history entries can be added and are visible in the expected detail workflow.",
    );
  }
  if (/\blog ?in|sign ?in|role|viewer|editor|owner/.test(summary)) {
    focus.push(
      "Signed-in, signed-out, viewer, editor, and owner states remain safe and role-appropriate.",
    );
  }
  return focus.length > 0
    ? focus
    : ["The requested change works from the UI and does not regress existing workflows."];
}
