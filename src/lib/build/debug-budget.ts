export class DebugBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DebugBudgetExceededError";
  }
}

export type DebugBudget = {
  maxRoundsPerStep: number;
  maxTotalRounds: number;
  totalRounds: number;
  roundsByStep: Map<string, number>;
  notesByStep: Map<string, string[]>;
};

export type SerializedDebugBudget = {
  maxRoundsPerStep: number;
  maxTotalRounds: number;
  totalRounds: number;
  roundsByStep: Record<string, number>;
  notesByStep: Record<string, string[]>;
};

export function createDebugBudget(input: {
  maxRoundsPerStep: number;
  maxTotalRounds: number;
}): DebugBudget {
  return {
    maxRoundsPerStep: input.maxRoundsPerStep,
    maxTotalRounds: input.maxTotalRounds,
    totalRounds: 0,
    roundsByStep: new Map(),
    notesByStep: new Map(),
  };
}

export function serializeDebugBudget(
  budget: DebugBudget,
): SerializedDebugBudget {
  return {
    maxRoundsPerStep: budget.maxRoundsPerStep,
    maxTotalRounds: budget.maxTotalRounds,
    totalRounds: budget.totalRounds,
    roundsByStep: Object.fromEntries(budget.roundsByStep),
    notesByStep: Object.fromEntries(budget.notesByStep),
  };
}

export function hydrateDebugBudget(
  input: SerializedDebugBudget | null | undefined,
  fallback: { maxRoundsPerStep: number; maxTotalRounds: number },
): DebugBudget {
  const budget = createDebugBudget({
    maxRoundsPerStep: input?.maxRoundsPerStep ?? fallback.maxRoundsPerStep,
    maxTotalRounds: input?.maxTotalRounds ?? fallback.maxTotalRounds,
  });
  budget.totalRounds = input?.totalRounds ?? 0;
  budget.roundsByStep = new Map(Object.entries(input?.roundsByStep ?? {}));
  budget.notesByStep = new Map(Object.entries(input?.notesByStep ?? {}));
  return budget;
}

export function reserveDebugRound(
  budget: DebugBudget,
  step: string,
): { stepRound: number; previousAttempts: string[] } {
  const stepRound = (budget.roundsByStep.get(step) ?? 0) + 1;
  if (stepRound > budget.maxRoundsPerStep) {
    throw new DebugBudgetExceededError(
      `${step} still failing after ${budget.maxRoundsPerStep} debug rounds`,
    );
  }

  const totalRounds = budget.totalRounds + 1;
  if (totalRounds > budget.maxTotalRounds) {
    throw new DebugBudgetExceededError(
      `Build still failing after ${budget.maxTotalRounds} total debug rounds`,
    );
  }

  budget.roundsByStep.set(step, stepRound);
  budget.totalRounds = totalRounds;
  return {
    stepRound,
    previousAttempts: [...(budget.notesByStep.get(step) ?? [])],
  };
}

export function recordDebugAttempt(
  budget: DebugBudget,
  step: string,
  note: string,
): void {
  const notes = budget.notesByStep.get(step) ?? [];
  notes.push(note);
  budget.notesByStep.set(step, notes);
}
