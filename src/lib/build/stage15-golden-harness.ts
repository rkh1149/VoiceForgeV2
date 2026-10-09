import { createHash } from "crypto";
import {
  createFallbackArchitecturePlan,
  validateArchitecturePlan,
  type ArchitecturePlan,
} from "../architecture";
import { computeSpecComplexity, type AppSpec } from "../spec";
import { validateWorkflowContracts } from "../workflow-contract";
import { compileAcceptanceTests } from "./acceptance-compiler";
import {
  GOLDEN_CAPABILITY_CATALOG,
  REQUIRED_CAPABILITY_PAIRS,
} from "./capability-catalog";
import {
  analyzeGoldenCapabilityCoverage,
  GOLDEN_CAPABILITY_MATRIX,
  type GoldenCapabilityCase,
} from "./golden-capability-matrix";
import { GOLDEN_REGRESSION_SPECS } from "./golden-regression-specs";
import {
  HISTORICAL_REGRESSIONS,
  validateHistoricalRegressionRegistry,
} from "./historical-regressions";
import { runPlanningSpecialistReviews } from "./planning-specialists";
import { createWorkflowImplementationMatrix } from "./workflow-implementation-matrix";
import type { WorkflowImplementationMatrix } from "./workflow-implementation-matrix";
import type { VoiceForgeAcceptanceManifest } from "./acceptance-manifest";

export type Stage15GoldenPackage = {
  caseId: string;
  specId: string;
  capabilityIds: string[];
  executionTiers: string[];
  architectureHash: string;
  workflowMatrixHash: string;
  acceptanceManifestHash: string;
  compiledTestHash: string;
  sourceFixturePath: string;
  artifacts: {
    spec: AppSpec;
    architecture: ArchitecturePlan;
    workflowMatrix: WorkflowImplementationMatrix;
    acceptanceManifest: VoiceForgeAcceptanceManifest;
    compiledTestSource: string;
    adapterSource: string;
  };
  summary: {
    workflows: number;
    journeys: number;
    steps: number;
    saves: number;
    handoffs: number;
  };
  blockingIssues: string[];
  warnings: string[];
};

export type Stage15QualityGate = {
  status: "passed" | "failed";
  packages: Stage15GoldenPackage[];
  blockingIssues: string[];
  warnings: string[];
  summary: {
    goldenCases: number;
    capabilitiesCovered: number;
    requiredPairsCovered: number;
    regressionCases: number;
  };
};

export function createStage15GoldenPackage(
  goldenCase: GoldenCapabilityCase,
): Stage15GoldenPackage {
  const golden = GOLDEN_REGRESSION_SPECS.find(
    (candidate) => candidate.id === goldenCase.specId,
  );
  if (!golden) {
    throw new Error(`Stage 15 golden spec ${goldenCase.specId} is missing.`);
  }
  const architecture = createFallbackArchitecturePlan(
    golden.spec,
    computeSpecComplexity(golden.spec),
  );
  const architectureReview = validateArchitecturePlan(architecture, golden.spec);
  const contractReview = validateWorkflowContracts(golden.spec, architecture);
  const implementationMatrix = createWorkflowImplementationMatrix({
    spec: golden.spec,
    architecture,
  });
  const planningReviews = runPlanningSpecialistReviews({
    spec: golden.spec,
    architecture,
    architectureValidation: architectureReview,
  });

  const initialCompilation = compileAcceptanceTests({
    spec: golden.spec,
    architecture,
  });
  const resolvedAdapters = deterministicGoldenAdapters(
    initialCompilation.manifest.adapters.map((adapter) => adapter.id),
  );
  const compilation = compileAcceptanceTests({
    spec: golden.spec,
    architecture,
    existingAdapterSource: resolvedAdapters,
  });
  const blockingIssues = unique([
    ...architectureReview.blockingIssues,
    ...contractReview.blockingIssues,
    ...implementationMatrix.blockingIssues,
    ...planningReviews.flatMap((review) => review.blockingIssues),
    ...compilation.blockingIssues,
    ...goldenCase.capabilities.flatMap((capabilityId) =>
      GOLDEN_CAPABILITY_CATALOG[capabilityId].platformServices.flatMap(
        (requiredService) =>
          architecture.platformServices.some(
            (service) =>
              service.service === requiredService &&
              service.required &&
              service.availability === "available",
          )
            ? []
            : [
                `stage15: Declared capability ${capabilityId} requires available platform service ${requiredService}.`,
              ],
      ),
    ),
  ]);
  const warnings = unique([
    ...architectureReview.warnings,
    ...contractReview.warnings,
    ...implementationMatrix.warnings,
    ...planningReviews.flatMap((review) => review.warnings),
    ...compilation.warnings,
  ]);

  return {
    caseId: goldenCase.id,
    specId: golden.id,
    capabilityIds: [...goldenCase.capabilities],
    executionTiers: [...goldenCase.executionTiers],
    architectureHash: stableHash(architecture),
    workflowMatrixHash: stableHash(implementationMatrix),
    acceptanceManifestHash: stableHash(compilation.manifest),
    compiledTestHash: createHash("sha256")
      .update(compilation.compiledSource)
      .digest("hex"),
    sourceFixturePath: "src/lib/build/fixtures/stage15-browser-golden.ts",
    artifacts: {
      spec: golden.spec,
      architecture,
      workflowMatrix: implementationMatrix,
      acceptanceManifest: compilation.manifest,
      compiledTestSource: compilation.compiledSource,
      adapterSource: resolvedAdapters,
    },
    summary: {
      workflows: architecture.workflowContracts.length,
      journeys: compilation.manifest.summary.journeys,
      steps: compilation.manifest.summary.steps,
      saves: compilation.manifest.summary.saves,
      handoffs: compilation.manifest.summary.handoffs,
    },
    blockingIssues,
    warnings,
  };
}

export function runStage15QualityGate(): Stage15QualityGate {
  const coverage = analyzeGoldenCapabilityCoverage();
  const registryIssues = validateHistoricalRegressionRegistry();
  const packages = GOLDEN_CAPABILITY_MATRIX.map(createStage15GoldenPackage);
  const blockingIssues = unique([
    ...coverage.missingCapabilities.map(
      (id) => `stage15: Capability ${id} has no golden coverage.`,
    ),
    ...coverage.missingPairs.map(
      ([left, right]) =>
        `stage15: Required capability pair ${left} + ${right} has no golden coverage.`,
    ),
    ...coverage.duplicateIds.map(
      (id) => `stage15: Golden case id ${id} is duplicated.`,
    ),
    ...registryIssues.map((issue) => `stage15: ${issue}`),
    ...packages.flatMap((item) =>
      item.blockingIssues.map((issue) => `${item.caseId}: ${issue}`),
    ),
  ]);
  return {
    status: blockingIssues.length > 0 ? "failed" : "passed",
    packages,
    blockingIssues,
    warnings: unique(
      packages.flatMap((item) =>
        item.warnings.map((warning) => `${item.caseId}: ${warning}`),
      ),
    ),
    summary: {
      goldenCases: packages.length,
      capabilitiesCovered: coverage.coveredCapabilities.length,
      requiredPairsCovered:
        GOLDEN_CAPABILITY_MATRIX.length > 0
          ? REQUIRED_CAPABILITY_PAIRS.length - coverage.missingPairs.length
          : 0,
      regressionCases: HISTORICAL_REGRESSIONS.length,
    },
  };
}

function deterministicGoldenAdapters(ids: string[]): string {
  const entries = ids
    .sort()
    .map((id) => `  ${JSON.stringify(id)}: async () => undefined,`)
    .join("\n");
  return `export const acceptanceAdapters = {\n${entries}\n};\n`;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
