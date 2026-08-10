import ts from "typescript";
import type { ArchitecturePlan } from "../architecture";
import { platformEntityFromSpec } from "../platform/spec-seeding";
import type { AppSpec } from "../spec";
import type {
  WorkflowContract,
  WorkflowContractRole,
} from "../workflow-contract";
import type { FileMap } from "./template";

export const UI_AFFORDANCE_REVIEW_VERSION = 1 as const;

const ALL_ROLES: WorkflowContractRole[] = [
  "owner",
  "editor",
  "viewer",
  "public",
];
const VAGUE_LABELS = new Set([
  "click here",
  "continue",
  "go",
  "ok",
  "open",
  "save",
  "submit",
]);
const LABEL_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "of",
  "on",
  "the",
  "to",
]);
const ACTION_CONTROL_KINDS = new Set([
  "button",
  "link",
  "menu",
  "drag_drop",
]);
const SOURCE_EXTENSIONS = [".ts", ".tsx"] as const;
const LOCKED_SOURCE_FILES = new Set([
  "src/lib/platform-data.ts",
  "src/lib/platform-files.ts",
  "src/lib/platform-notifications.ts",
  "src/lib/platform-integrations.ts",
  "src/lib/device-location.ts",
  "src/lib/voiceforge-modules.ts",
  "src/components/voiceforge-reusable.tsx",
  "src/components/voiceforge-google-map.tsx",
]);
const RUNTIME_EVIDENCE_PATTERN =
  /\b(listPlatformRecords|searchPlatformRecords|runPlatformRecordReport|createPlatformRecord|updatePlatformRecord|deletePlatformRecord|listPlatformFiles|listPlatformNotifications|computeGoogleMapsRoute|searchGoogleMapsPlaces|getCurrentDeviceLocation|watchDeviceLocation|DeviceLocationTracker|GoogleMapsTripMap|usePlatformSessionState|localStorage\.(?:getItem|setItem)|redirect\s*\()\b/;
const PLACEHOLDER_TEXT_PATTERN =
  /\b(coming soon|under construction|not implemented|to be implemented|will be added later|planned for a later stage|placeholder page)\b/i;

export type UiAffordanceControlEvidence = {
  kind: WorkflowContract["controls"][number]["kind"];
  label: string;
  labelConfidence: "resolved" | "dynamic" | "missing";
  route: string;
  filePath: string;
  line: number;
  roles: WorkflowContractRole[];
  targetRoute: string | null;
};

export type UiAffordanceRouteEvidence = {
  route: string;
  filePath: string;
  reachableByRoles: WorkflowContractRole[];
  incomingFrom: Array<{
    route: string;
    label: string;
    roles: WorkflowContractRole[];
  }>;
  controls: UiAffordanceControlEvidence[];
  placeholder: boolean;
};

export type UiAffordanceWorkflowEvidence = {
  contractId: string;
  name: string;
  startRoute: string;
  roles: WorkflowContractRole[];
  status: "discoverable" | "needs_repair" | "not_applicable";
  missingControls: Array<{
    controlId: string;
    label: string;
    route: string;
    roles: WorkflowContractRole[];
  }>;
  unreachableRoles: WorkflowContractRole[];
  matchedControls: number;
  expectedControls: number;
  issues: string[];
};

export type UiAffordanceEntityEvidence = {
  entityName: string;
  entityKey: string;
  status: "available" | "needs_repair";
  requiredOperations: Array<"create" | "read" | "update" | "delete">;
  availableOperations: Array<"create" | "read" | "update" | "delete">;
  routes: string[];
};

export type UiAffordanceReview = {
  version: typeof UI_AFFORDANCE_REVIEW_VERSION;
  summary: {
    routesFound: number;
    reachableRoutes: number;
    workflowsPlanned: number;
    workflowsDiscoverable: number;
    controlsExpected: number;
    controlsMatched: number;
    entityPathsRequired: number;
    entityPathsAvailable: number;
    hiddenRoutes: number;
    placeholderPages: number;
    vagueControls: number;
    uncertainControls: number;
  };
  routes: UiAffordanceRouteEvidence[];
  workflows: UiAffordanceWorkflowEvidence[];
  entities: UiAffordanceEntityEvidence[];
  hiddenRoutes: string[];
  placeholderRoutes: string[];
  vagueControls: UiAffordanceControlEvidence[];
  uncertainControls: UiAffordanceControlEvidence[];
  warnings: string[];
  blockingIssues: string[];
};

type ModuleControl = Omit<UiAffordanceControlEvidence, "route"> & {
  ownerComponent: string | null;
  dynamicLabelKey: string | null;
  sourcePosition: number;
};

type NavigationEvidence = {
  label: string;
  targetRoute: string;
  filePath: string;
  line: number;
  roles: WorkflowContractRole[];
  ownerComponent: string | null;
};

type ComponentReference = {
  ownerComponent: string | null;
  targetPath: string;
  targetComponent: string | null;
  props: Record<string, string>;
  roles: WorkflowContractRole[];
};

type ModuleAnalysis = {
  path: string;
  source: string;
  imports: string[];
  defaultComponent: string | null;
  componentDefaults: Record<string, Record<string, string>>;
  componentReferences: ComponentReference[];
  controls: ModuleControl[];
  navigation: NavigationEvidence[];
  renderedText: Array<{ ownerComponent: string | null; text: string }>;
};

type RouteWorkingEvidence = UiAffordanceRouteEvidence & {
  navigation: NavigationEvidence[];
  sourceText: string;
  renderedText: string[];
};

type MatchedControl = {
  expected: WorkflowContract["controls"][number];
  actual: UiAffordanceControlEvidence;
  roles: WorkflowContractRole[];
};

export function analyzeUiAffordances(input: {
  spec: AppSpec;
  architecture: ArchitecturePlan;
  files: FileMap;
}): UiAffordanceReview {
  const modules = analyzeModules(input.files);
  const routeMap = buildRouteEvidence(modules, input.files);
  const brokenNavigationIssues = findBrokenNavigationIssues(routeMap);
  populateReachability(routeMap);

  const workflowResults = input.architecture.workflowContracts.map((contract) =>
    reviewWorkflow(contract, routeMap),
  );
  const workflowById = new Map(
    workflowResults.map((workflow) => [workflow.contractId, workflow]),
  );
  const entityResults = reviewEntities({
    spec: input.spec,
    architecture: input.architecture,
    routeMap,
    workflowById,
  });
  const contractRoutes = new Set(
    input.architecture.workflowContracts.flatMap((contract) => [
      contract.start.route,
      contract.success.route,
      ...contract.controls.map((control) => control.route),
      ...contract.steps.map((step) => step.route),
    ]),
  );
  const placeholderRoutes = [...routeMap.values()]
    .filter(
      (route) =>
        route.placeholder &&
        [...contractRoutes].some((plannedRoute) =>
          routePatternsOverlap(route.route, plannedRoute),
        ),
    )
    .map((route) => route.route)
    .sort();
  const vagueControls = uniqueSourceControls(
    [...routeMap.values()]
      .filter((route) =>
        [...contractRoutes].some((plannedRoute) =>
          routePatternsOverlap(route.route, plannedRoute),
        ),
      )
      .flatMap((route) => route.controls)
      .filter(isVagueOrUnlabeledAction),
  );
  const uncertainControls = uniqueSourceControls(
    [...routeMap.values()]
      .filter((route) =>
        [...contractRoutes].some((plannedRoute) =>
          routePatternsOverlap(route.route, plannedRoute),
        ),
      )
      .flatMap((route) =>
        route.controls.filter(
          (control) =>
            ACTION_CONTROL_KINDS.has(control.kind) &&
            control.labelConfidence === "dynamic" &&
            !control.label &&
            !route.controls.some(
              (peer) =>
                peer.filePath === control.filePath &&
                peer.kind === control.kind &&
                peer.labelConfidence === "resolved" &&
                Boolean(peer.label),
            ),
        ),
      ),
  );
  const hiddenRoutes = [...routeMap.values()]
    .filter((route) => route.reachableByRoles.length === 0)
    .map((route) => route.route)
    .sort();

  const blockingIssues = uniqueStrings([
    ...brokenNavigationIssues,
    ...workflowResults.flatMap((workflow) => workflow.issues),
    ...entityResults
      .filter((entity) => entity.status === "needs_repair")
      .map((entity) => {
        const missing = entity.requiredOperations.filter(
          (operation) => !entity.availableOperations.includes(operation),
        );
        return `ui_affordance: Entity ${entity.entityName} (${entity.entityKey}) has no discoverable ${missing.join("/")} path on a reachable screen.`;
      }),
    ...placeholderRoutes.map(
      (route) =>
        `ui_affordance: Planned workflow route ${route} is mostly placeholder content and does not expose a real control, navigation choice, or runtime data surface.`,
    ),
    ...vagueControls.map((control) =>
      control.label
        ? `ui_affordance: ${control.filePath}:${control.line} uses the vague ${control.kind} label "${control.label}" on ${control.route}; name the action and object clearly.`
        : `ui_affordance: ${control.filePath}:${control.line} has an unlabeled ${control.kind} on ${control.route}; add visible text or an aria-label that names the action.`,
    ),
  ]);

  const warnings = uniqueStrings([
    ...hiddenRoutes
      .filter(
        (route) =>
          ![...contractRoutes].some((plannedRoute) =>
            routePatternsOverlap(route, plannedRoute),
          ),
      )
      .map(
        (route) =>
          `ui_affordance: Route ${route} is not reachable from the generated app entry point. It is not currently referenced by a workflow contract, so verify that it is not abandoned UI.`,
      ),
    ...uncertainControls.map(
      (control) =>
        `ui_affordance: ${control.filePath}:${control.line} uses a runtime-provided ${control.kind} label on ${control.route}. Static review could not resolve the text, so browser accessibility tests must verify its accessible name.`,
    ),
  ]);

  const routes = [...routeMap.values()]
    .map((route): UiAffordanceRouteEvidence => ({
      route: route.route,
      filePath: route.filePath,
      reachableByRoles: route.reachableByRoles,
      incomingFrom: route.incomingFrom,
      controls: route.controls.map((control) => ({
        kind: control.kind,
        label: control.label,
        labelConfidence: control.labelConfidence,
        route: control.route,
        filePath: control.filePath,
        line: control.line,
        roles: control.roles,
        targetRoute: control.targetRoute,
      })),
      placeholder: route.placeholder,
    }))
    .sort((left, right) => left.route.localeCompare(right.route));
  const controlsExpected = workflowResults.reduce(
    (sum, workflow) => sum + workflow.expectedControls,
    0,
  );
  const controlsMatched = workflowResults.reduce(
    (sum, workflow) => sum + workflow.matchedControls,
    0,
  );
  const entityPathsRequired = entityResults.reduce(
    (sum, entity) => sum + entity.requiredOperations.length,
    0,
  );
  const entityPathsAvailable = entityResults.reduce(
    (sum, entity) => sum + entity.availableOperations.length,
    0,
  );

  return {
    version: UI_AFFORDANCE_REVIEW_VERSION,
    summary: {
      routesFound: routes.length,
      reachableRoutes: routes.filter(
        (route) => route.reachableByRoles.length > 0,
      ).length,
      workflowsPlanned: workflowResults.length,
      workflowsDiscoverable: workflowResults.filter(
        (workflow) => workflow.status === "discoverable",
      ).length,
      controlsExpected,
      controlsMatched,
      entityPathsRequired,
      entityPathsAvailable,
      hiddenRoutes: hiddenRoutes.length,
      placeholderPages: placeholderRoutes.length,
      vagueControls: vagueControls.length,
      uncertainControls: uncertainControls.length,
    },
    routes,
    workflows: workflowResults,
    entities: entityResults,
    hiddenRoutes,
    placeholderRoutes,
    vagueControls,
    uncertainControls,
    warnings,
    blockingIssues,
  };
}

function findDefaultComponent(sourceFile: ts.SourceFile): string | null {
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
      )
    ) {
      return statement.name?.text ?? "default";
    }
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      return statement.expression.text;
    }
  }
  return null;
}

function findComponentDefaults(
  sourceFile: ts.SourceFile,
  defaultComponent: string | null,
): Record<string, Record<string, string>> {
  const defaults: Record<string, Record<string, string>> = {};
  const visit = (node: ts.Node) => {
    if (isFunctionLike(node)) {
      const component = functionComponentName(node, defaultComponent);
      const parameter = node.parameters[0];
      if (component && parameter && ts.isObjectBindingPattern(parameter.name)) {
        const values: Record<string, string> = {};
        for (const element of parameter.name.elements) {
          if (!ts.isIdentifier(element.name) || !element.initializer) continue;
          const value = expressionText(element.initializer, sourceFile);
          if (value) values[element.name.text] = normalizeVisibleText(value);
        }
        defaults[component] = values;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return defaults;
}

function findLabelsByControlId(sourceFile: ts.SourceFile): Map<string, string> {
  const labels = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node)) {
      const tagName = node.openingElement.tagName
        .getText(sourceFile)
        .toLowerCase();
      if (tagName === "label") {
        const controlId = jsxAttributeValue(
          node.openingElement,
          "htmlFor",
          sourceFile,
        );
        const label = jsxElementText(node, sourceFile);
        if (controlId && label) labels.set(controlId, label);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return labels;
}

function findLabelsByDynamicControlId(
  sourceFile: ts.SourceFile,
): Map<string, { label: string; dynamicKey: string | null }> {
  const labels = new Map<
    string,
    { label: string; dynamicKey: string | null }
  >();
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node)) {
      const tagName = node.openingElement.tagName
        .getText(sourceFile)
        .toLowerCase();
      if (tagName === "label") {
        const controlId = jsxAttributeDynamicKey(
          node.openingElement,
          "htmlFor",
          sourceFile,
        );
        const label = jsxElementText(node, sourceFile);
        const dynamicKey = jsxElementDynamicKey(node, sourceFile);
        if (controlId && (label || dynamicKey)) {
          labels.set(controlId, { label, dynamicKey });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return labels;
}

function componentOwnerForNode(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  defaultComponent: string | null,
): string | null {
  let current: ts.Node | undefined = node;
  while (current && current !== sourceFile) {
    if (isFunctionLike(current)) {
      const component = functionComponentName(current, defaultComponent);
      if (component) return component;
    }
    current = current.parent;
  }
  return null;
}

function isFunctionLike(
  node: ts.Node,
): node is
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

function functionComponentName(
  node:
    | ts.FunctionDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction
    | ts.MethodDeclaration,
  defaultComponent: string | null,
): string | null {
  let name: string | null = null;
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) {
    name = node.name.text;
  } else if (ts.isMethodDeclaration(node)) {
    name = node.name.getText();
  } else if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    name = node.parent.name.text;
  }
  if (!name) return null;
  return /^[A-Z]/.test(name) || name === defaultComponent ? name : null;
}

function jsxStaticProps(
  node: ts.JsxElement | ts.JsxSelfClosingElement,
  opening: ts.JsxOpeningLikeElement,
  sourceFile: ts.SourceFile,
): Record<string, string> {
  const props: Record<string, string> = {};
  for (const property of opening.attributes.properties) {
    if (!ts.isJsxAttribute(property)) continue;
    const name = property.name.getText(sourceFile);
    if (!property.initializer) {
      props[name] = "true";
      continue;
    }
    const value = jsxAttributeValue(opening, name, sourceFile);
    if (value) {
      props[name] = normalizeVisibleText(value);
      continue;
    }
    const dynamicKey = jsxAttributeDynamicKey(opening, name, sourceFile);
    if (dynamicKey) props[name] = dynamicKey;
  }
  const children = jsxElementText(node, sourceFile);
  if (children) props.children = children;
  return props;
}

function analyzeModules(files: FileMap): Map<string, ModuleAnalysis> {
  const modules = new Map<string, ModuleAnalysis>();
  for (const [path, source] of Object.entries(files)) {
    if (!isAnalyzableSource(path)) continue;
    modules.set(path, analyzeModule(path, source, files));
  }
  return modules;
}

function analyzeModule(
  path: string,
  source: string,
  files: FileMap,
): ModuleAnalysis {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const importsByLocalName = new Map<
    string,
    { path: string; component: string | null }
  >();
  const imports: string[] = [];
  const controls: ModuleControl[] = [];
  const navigation: NavigationEvidence[] = [];
  const renderedText: ModuleAnalysis["renderedText"] = [];
  const componentReferences: ComponentReference[] = [];
  const defaultComponent = findDefaultComponent(sourceFile);
  const componentDefaults = findComponentDefaults(sourceFile, defaultComponent);
  const labelsByControlId = findLabelsByControlId(sourceFile);
  const labelsByDynamicControlId = findLabelsByDynamicControlId(sourceFile);

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = stringValue(statement.moduleSpecifier);
    if (!specifier) continue;
    const resolved = resolveInternalImport(path, specifier, files);
    if (!resolved) continue;
    imports.push(resolved);
    const clause = statement.importClause;
    if (clause?.name) {
      importsByLocalName.set(clause.name.text, {
        path: resolved,
        component: "default",
      });
    }
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        importsByLocalName.set(element.name.text, {
          path: resolved,
          component: element.propertyName?.text ?? element.name.text,
        });
      }
    }
  }

  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      /(?:nav|link|menu|route)/i.test(node.name.text) &&
      node.initializer
    ) {
      for (const targetRoute of staticAppRoutes(node.initializer)) {
        navigation.push({
          label: `Open ${targetRoute}`,
          targetRoute,
          filePath: path,
          line: lineOf(sourceFile, node),
          roles: rolesForNode(node, sourceFile),
          ownerComponent: componentOwnerForNode(
            node,
            sourceFile,
            defaultComponent,
          ),
        });
      }
    }

    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const tagName = opening.tagName.getText(sourceFile);
      const ownerComponent = componentOwnerForNode(
        node,
        sourceFile,
        defaultComponent,
      );
      const imported = importsByLocalName.get(tagName);
      if (imported) {
        componentReferences.push({
          ownerComponent,
          targetPath: imported.path,
          targetComponent: imported.component,
          props: jsxStaticProps(node, opening, sourceFile),
          roles: rolesForNode(node, sourceFile),
        });
      } else if (/^[A-Z]/.test(tagName)) {
        componentReferences.push({
          ownerComponent,
          targetPath: path,
          targetComponent: tagName,
          props: jsxStaticProps(node, opening, sourceFile),
          roles: rolesForNode(node, sourceFile),
        });
      }
      const foundControls = controlsForElement({
        node,
        opening,
        tagName,
        path,
        sourceFile,
        ownerComponent,
        labelsByControlId,
        labelsByDynamicControlId,
      });
      controls.push(...foundControls);
      for (const control of foundControls) {
        if (control.targetRoute) {
          navigation.push({
            label: control.label || `Open ${control.targetRoute}`,
            targetRoute: control.targetRoute,
            filePath: control.filePath,
            line: control.line,
            roles: control.roles,
            ownerComponent,
          });
        }
      }
      const text = jsxElementText(node, sourceFile);
      if (text) renderedText.push({ ownerComponent, text });
    }

    if (ts.isCallExpression(node)) {
      const expression = node.expression.getText(sourceFile);
      if (
        /(?:^|\.)(?:push|replace|redirect)$/.test(expression) ||
        expression === "redirect"
      ) {
        const targetRoute = expressionRoute(node.arguments[0], sourceFile);
        if (targetRoute) {
          navigation.push({
            label: expression === "redirect" ? "Automatic redirect" : "Open route",
            targetRoute,
            filePath: path,
            line: lineOf(sourceFile, node),
            roles: rolesForNode(node, sourceFile),
            ownerComponent: componentOwnerForNode(
              node,
              sourceFile,
              defaultComponent,
            ),
          });
        }
      }
    }

    if (ts.isObjectLiteralExpression(node)) {
      const href = objectStringProperty(
        node,
        ["href", "route", "to", "path", "url"],
        sourceFile,
      );
      if (href) {
        const ownerComponent = componentOwnerForNode(
          node,
          sourceFile,
          defaultComponent,
        );
        const label =
          objectStringProperty(
            node,
            ["label", "name", "title", "text"],
            sourceFile,
          ) ??
          `Open ${href}`;
        navigation.push({
          label,
          targetRoute: href,
          filePath: path,
          line: lineOf(sourceFile, node),
          roles: rolesForNode(node, sourceFile),
          ownerComponent,
        });
        controls.push({
          kind: "link",
          label,
          labelConfidence: "resolved",
          dynamicLabelKey: null,
          sourcePosition: node.getStart(sourceFile),
          targetRoute: href,
          filePath: path,
          line: lineOf(sourceFile, node),
          roles: rolesForNode(node, sourceFile),
          ownerComponent,
        });
      }
    }

    if (
      ts.isArrayLiteralExpression(node) &&
      isNavigationCollection(node, sourceFile)
    ) {
      const tuple = navigationTuple(node, sourceFile);
      if (tuple) {
        const ownerComponent = componentOwnerForNode(
          node,
          sourceFile,
          defaultComponent,
        );
        navigation.push({
          ...tuple,
          filePath: path,
          line: lineOf(sourceFile, node),
          roles: rolesForNode(node, sourceFile),
          ownerComponent,
        });
        controls.push({
          kind: "link",
          label: tuple.label,
          labelConfidence: "resolved",
          dynamicLabelKey: null,
          sourcePosition: node.getStart(sourceFile),
          targetRoute: tuple.targetRoute,
          filePath: path,
          line: lineOf(sourceFile, node),
          roles: rolesForNode(node, sourceFile),
          ownerComponent,
        });
      }
    }

    if (
      ts.isPropertyAssignment(node) &&
      isNavigationCollection(node, sourceFile)
    ) {
      const keyed = keyedNavigationProperty(node, sourceFile);
      if (keyed) {
        const ownerComponent = componentOwnerForNode(
          node,
          sourceFile,
          defaultComponent,
        );
        navigation.push({
          ...keyed,
          filePath: path,
          line: lineOf(sourceFile, node),
          roles: rolesForNode(node, sourceFile),
          ownerComponent,
        });
        controls.push({
          kind: "link",
          label: keyed.label,
          labelConfidence: "resolved",
          dynamicLabelKey: null,
          sourcePosition: node.getStart(sourceFile),
          targetRoute: keyed.targetRoute,
          filePath: path,
          line: lineOf(sourceFile, node),
          roles: rolesForNode(node, sourceFile),
          ownerComponent,
        });
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return {
    path,
    source,
    imports: uniqueStrings(imports),
    defaultComponent,
    componentDefaults,
    componentReferences: uniqueComponentReferences(componentReferences),
    controls: uniqueModuleControls(controls),
    navigation: uniqueNavigation(navigation),
    renderedText: uniqueRenderedText(renderedText),
  };
}

function controlsForElement(input: {
  node: ts.JsxElement | ts.JsxSelfClosingElement;
  opening: ts.JsxOpeningLikeElement;
  tagName: string;
  path: string;
  sourceFile: ts.SourceFile;
  ownerComponent: string | null;
  labelsByControlId: Map<string, string>;
  labelsByDynamicControlId: Map<
    string,
    { label: string; dynamicKey: string | null }
  >;
}): ModuleControl[] {
  const kind = controlKind(input.tagName, input.opening, input.sourceFile);
  const composite = compositeControls(input.tagName, input);
  if (!kind) return composite;
  const labelResult = controlLabel(
    input.node,
    input.opening,
    input.sourceFile,
    input.labelsByControlId,
    input.labelsByDynamicControlId,
  );
  const targetRoute =
    jsxAttributeValue(input.opening, "href", input.sourceFile) ??
    jsxAttributeValue(input.opening, "to", input.sourceFile) ??
    routeFromHandler(input.opening, input.sourceFile);
  return [
    {
      kind,
      label: labelResult.label,
      labelConfidence: labelResult.confidence,
      dynamicLabelKey: labelResult.dynamicKey,
      sourcePosition: input.opening.getStart(input.sourceFile),
      filePath: input.path,
      line: lineOf(input.sourceFile, input.opening),
      roles: rolesForNode(input.node, input.sourceFile),
      targetRoute,
      ownerComponent: input.ownerComponent,
    },
    ...composite,
  ];
}

function compositeControls(
  tagName: string,
  input: {
    node: ts.JsxElement | ts.JsxSelfClosingElement;
    opening: ts.JsxOpeningLikeElement;
    path: string;
    sourceFile: ts.SourceFile;
    ownerComponent: string | null;
  },
): ModuleControl[] {
  const labels =
    tagName === "DeviceLocationTracker"
      ? ["Use my location", "Start tracking", "Stop tracking", "Export GPX"]
      : [];
  return labels.map((label) => ({
    kind: "button" as const,
    label,
    labelConfidence: "resolved" as const,
    dynamicLabelKey: null,
    sourcePosition: input.opening.getStart(input.sourceFile),
    filePath: input.path,
    line: lineOf(input.sourceFile, input.opening),
    roles: rolesForNode(input.node, input.sourceFile),
    targetRoute: null,
    ownerComponent: input.ownerComponent,
  }));
}

function controlKind(
  tagName: string,
  opening: ts.JsxOpeningLikeElement,
  sourceFile: ts.SourceFile,
): WorkflowContract["controls"][number]["kind"] | null {
  const lowerTag = tagName.toLowerCase();
  if (lowerTag === "button" || jsxAttribute(opening, "onClick")) return "button";
  if (
    lowerTag === "a" ||
    lowerTag.endsWith("link") ||
    jsxAttribute(opening, "href")
  ) {
    return "link";
  }
  if (lowerTag === "form" || jsxAttribute(opening, "onSubmit")) return "form";
  if (lowerTag === "select" || lowerTag === "googleplaceautocomplete") {
    return "combobox";
  }
  if (lowerTag === "textarea") return "textbox";
  if (lowerTag === "input" || lowerTag.endsWith("input")) {
    const type = jsxAttributeValue(opening, "type", sourceFile)?.toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "date" || type === "datetime-local") return "date";
    if (type === "file" || lowerTag.includes("upload")) return "file";
    return "textbox";
  }
  if (jsxAttribute(opening, "onDrop") || jsxAttribute(opening, "draggable")) {
    return "drag_drop";
  }
  if (lowerTag.includes("menu")) return "menu";
  return null;
}

function controlLabel(
  node: ts.JsxElement | ts.JsxSelfClosingElement,
  opening: ts.JsxOpeningLikeElement,
  sourceFile: ts.SourceFile,
  labelsByControlId: Map<string, string>,
  labelsByDynamicControlId: Map<
    string,
    { label: string; dynamicKey: string | null }
  >,
): {
  label: string;
  confidence: UiAffordanceControlEvidence["labelConfidence"];
  dynamicKey: string | null;
} {
  const labelAttributes = ["aria-label", "label", "title"];
  if (elementValueNamesControl(opening, sourceFile)) {
    labelAttributes.push("value");
  }
  const direct = labelAttributes
    .map((name) => jsxAttributeValue(opening, name, sourceFile))
    .find(Boolean);
  if (direct) {
    return {
      label: normalizeVisibleText(direct),
      confidence: "resolved",
      dynamicKey: null,
    };
  }
  const directDynamic = labelAttributes
    .map((name) => jsxAttributeDynamicKey(opening, name, sourceFile))
    .find(Boolean);
  if (directDynamic) {
    return { label: "", confidence: "dynamic", dynamicKey: directDynamic };
  }
  const controlId = jsxAttributeValue(opening, "id", sourceFile);
  const associatedLabel = controlId
    ? labelsByControlId.get(controlId)
    : undefined;
  if (associatedLabel) {
    return {
      label: associatedLabel,
      confidence: "resolved",
      dynamicKey: null,
    };
  }
  const dynamicControlId = jsxAttributeDynamicKey(
    opening,
    "id",
    sourceFile,
  );
  const dynamicAssociation = dynamicControlId
    ? labelsByDynamicControlId.get(dynamicControlId)
    : undefined;
  if (dynamicAssociation) {
    return dynamicAssociation.dynamicKey
      ? {
          label: dynamicAssociation.label,
          confidence: "dynamic",
          dynamicKey: dynamicAssociation.dynamicKey,
        }
      : {
          label: dynamicAssociation.label,
          confidence: "resolved",
          dynamicKey: null,
        };
  }
  const ownText = jsxElementText(node, sourceFile);
  const ownDynamic = jsxElementDynamicKey(node, sourceFile);
  if (ownDynamic) {
    return {
      label: ownText,
      confidence: "dynamic",
      dynamicKey: ownDynamic,
    };
  }
  if (ownText) {
    return { label: ownText, confidence: "resolved", dynamicKey: null };
  }
  let parent: ts.Node | undefined = node.parent;
  while (parent && parent !== sourceFile) {
    if (ts.isJsxElement(parent)) {
      const tag = parent.openingElement.tagName.getText(sourceFile).toLowerCase();
      if (tag === "label") {
        const parentText = jsxElementText(parent, sourceFile);
        const parentDynamic = jsxElementDynamicKey(parent, sourceFile);
        if (parentDynamic) {
          return {
            label: parentText,
            confidence: "dynamic",
            dynamicKey: parentDynamic,
          };
        }
        if (parentText) {
          return {
            label: parentText,
            confidence: "resolved",
            dynamicKey: null,
          };
        }
      }
      if (tag === "form" || tag === "section" || tag === "main") break;
    }
    parent = parent.parent;
  }
  return { label: "", confidence: "missing", dynamicKey: null };
}

function elementValueNamesControl(
  opening: ts.JsxOpeningLikeElement,
  sourceFile: ts.SourceFile,
): boolean {
  const tagName = opening.tagName.getText(sourceFile).toLowerCase();
  if (tagName === "button") return true;
  if (tagName !== "input") return false;
  const type = jsxAttributeValue(opening, "type", sourceFile)?.toLowerCase();
  return type === "button" || type === "submit" || type === "reset";
}

function jsxElementDynamicKey(
  node: ts.JsxElement | ts.JsxSelfClosingElement,
  sourceFile: ts.SourceFile,
): string | null {
  if (ts.isJsxSelfClosingElement(node)) return null;
  for (const child of node.children) {
    if (!ts.isJsxExpression(child) || !child.expression) continue;
    const key = dynamicExpressionKey(child.expression, sourceFile);
    if (key) return key;
  }
  return null;
}

function dynamicExpressionKey(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.getText(sourceFile);
  if (ts.isElementAccessExpression(node)) return node.getText(sourceFile);
  if (ts.isParenthesizedExpression(node)) {
    return dynamicExpressionKey(node.expression, sourceFile);
  }
  if (ts.isConditionalExpression(node)) {
    return (
      dynamicExpressionKey(node.whenTrue, sourceFile) ??
      dynamicExpressionKey(node.whenFalse, sourceFile)
    );
  }
  return null;
}

function jsxElementText(
  node: ts.JsxElement | ts.JsxSelfClosingElement,
  sourceFile: ts.SourceFile,
): string {
  if (ts.isJsxSelfClosingElement(node)) return "";
  const values: string[] = [];
  const collect = (child: ts.Node) => {
    if (ts.isJsxText(child)) values.push(child.text);
    if (ts.isJsxExpression(child) && child.expression) {
      values.push(expressionText(child.expression, sourceFile));
      return;
    }
    if (ts.isJsxElement(child)) {
      for (const nested of child.children) collect(nested);
    }
  };
  for (const child of node.children) collect(child);
  return normalizeVisibleText(values.join(" "));
}

function expressionText(node: ts.Expression, sourceFile: ts.SourceFile): string {
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isNumericLiteral(node)
  ) {
    return node.text;
  }
  if (ts.isConditionalExpression(node)) {
    return `${expressionText(node.whenTrue, sourceFile)} ${expressionText(node.whenFalse, sourceFile)}`;
  }
  if (ts.isBinaryExpression(node)) {
    return `${expressionText(node.left, sourceFile)} ${expressionText(node.right, sourceFile)}`;
  }
  if (ts.isTemplateExpression(node)) {
    return [
      node.head.text,
      ...node.templateSpans.flatMap((span) => [
        expressionText(span.expression, sourceFile),
        span.literal.text,
      ]),
    ].join(" ");
  }
  if (ts.isParenthesizedExpression(node)) {
    return expressionText(node.expression, sourceFile);
  }
  return "";
}

function buildRouteEvidence(
  modules: Map<string, ModuleAnalysis>,
  files: FileMap,
): Map<string, RouteWorkingEvidence> {
  const routes = new Map<string, RouteWorkingEvidence>();
  const layouts = [...modules.keys()].filter((path) => isLayoutFile(path));
  for (const path of modules.keys()) {
    if (!isPageFile(path)) continue;
    const route = pagePathToRoute(path);
    const rendered = collectRenderedEvidence(path, modules);
    const applicableLayouts = layouts.filter((layout) =>
      routeUnderLayout(route, layoutPathToRoutePrefix(layout)),
    );
    for (const layout of applicableLayouts) {
      mergeRenderedEvidence(rendered, collectRenderedEvidence(layout, modules));
    }
    const sourcePaths = collectModuleClosure(path, modules);
    for (const layout of applicableLayouts) {
      for (const modulePath of collectModuleClosure(layout, modules)) {
        sourcePaths.add(modulePath);
      }
    }
    const controls = uniqueControls(
      rendered.controls.map((control) => ({ ...control, route })),
    );
    const navigation = uniqueNavigation(rendered.navigation);
    const sourceText = [...sourcePaths]
      .filter((modulePath) => !LOCKED_SOURCE_FILES.has(modulePath))
      .map((modulePath) => files[modulePath] ?? "")
      .join("\n");
    const renderedText = uniqueStrings(rendered.renderedText);
    routes.set(route, {
      route,
      filePath: path,
      reachableByRoles: [],
      incomingFrom: [],
      controls,
      placeholder: isPlaceholderRoute({ controls, navigation, sourceText, renderedText }),
      navigation,
      sourceText,
      renderedText,
    });
  }
  return routes;
}

type RenderedEvidence = {
  controls: ModuleControl[];
  navigation: NavigationEvidence[];
  renderedText: string[];
};

function collectRenderedEvidence(
  startPath: string,
  modules: Map<string, ModuleAnalysis>,
): RenderedEvidence {
  const result: RenderedEvidence = {
    controls: [],
    navigation: [],
    renderedText: [],
  };
  const startModule = modules.get(startPath);
  if (!startModule) return result;
  const queue: Array<{
    path: string;
    component: string | null;
    props: Record<string, string>;
    roles: WorkflowContractRole[];
  }> = [
    {
      path: startPath,
      component: startModule.defaultComponent,
      props: {},
      roles: [...ALL_ROLES],
    },
  ];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const instance = queue.shift();
    if (!instance) continue;
    const moduleAnalysis = modules.get(instance.path);
    if (!moduleAnalysis) continue;
    const component =
      instance.component === "default"
        ? moduleAnalysis.defaultComponent
        : instance.component;
    const instanceKey = `${instance.path}:${component ?? "<module>"}:${JSON.stringify(instance.props)}:${instance.roles.join(",")}`;
    if (visited.has(instanceKey)) continue;
    visited.add(instanceKey);
    const defaults = component
      ? moduleAnalysis.componentDefaults[component] ?? {}
      : {};
    const props = { ...defaults, ...instance.props };
    const owns = (owner: string | null) =>
      owner === null || owner === component;

    for (const control of moduleAnalysis.controls.filter((item) =>
      owns(item.ownerComponent),
    )) {
      const instantiated = instantiateControl(control, props, instance.roles);
      if (instantiated.roles.length > 0) result.controls.push(instantiated);
    }
    for (const navigation of moduleAnalysis.navigation.filter((item) =>
      owns(item.ownerComponent),
    )) {
      const roles = intersectRoles(navigation.roles, instance.roles);
      if (roles.length > 0) result.navigation.push({ ...navigation, roles });
    }
    for (const text of moduleAnalysis.renderedText.filter((item) =>
      owns(item.ownerComponent),
    )) {
      result.renderedText.push(text.text);
    }
    for (const reference of moduleAnalysis.componentReferences.filter((item) =>
      owns(item.ownerComponent),
    )) {
      const roles = intersectRoles(reference.roles, instance.roles);
      if (roles.length === 0) continue;
      queue.push({
        path: reference.targetPath,
        component: reference.targetComponent,
        props: resolveReferenceProps(reference.props, props),
        roles,
      });
    }
  }

  return result;
}

function mergeRenderedEvidence(
  target: RenderedEvidence,
  source: RenderedEvidence,
): void {
  target.controls.push(...source.controls);
  target.navigation.push(...source.navigation);
  target.renderedText.push(...source.renderedText);
}

function instantiateControl(
  control: ModuleControl,
  props: Record<string, string>,
  instanceRoles: WorkflowContractRole[],
): ModuleControl {
  const dynamicValue = control.dynamicLabelKey
    ? props[control.dynamicLabelKey] ?? props[control.dynamicLabelKey.split(".").at(-1) ?? ""]
    : undefined;
  return {
    ...control,
    label: dynamicValue ? normalizeVisibleText(dynamicValue) : control.label,
    labelConfidence: dynamicValue ? "resolved" : control.labelConfidence,
    roles: intersectRoles(control.roles, instanceRoles),
  };
}

function resolveReferenceProps(
  referenceProps: Record<string, string>,
  parentProps: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(referenceProps).map(([key, value]) => [
      key,
      parentProps[value] ?? value,
    ]),
  );
}

function intersectRoles(
  left: WorkflowContractRole[],
  right: WorkflowContractRole[],
): WorkflowContractRole[] {
  return left.filter((role) => right.includes(role));
}

function populateReachability(routes: Map<string, RouteWorkingEvidence>): void {
  const startRoute = routes.has("/") ? "/" : [...routes.keys()].sort()[0];
  if (!startRoute) return;
  for (const role of ALL_ROLES) {
    const queue = [startRoute];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const route = queue.shift();
      if (!route || visited.has(route)) continue;
      visited.add(route);
      const evidence = routes.get(route);
      if (!evidence) continue;
      if (!evidence.reachableByRoles.includes(role)) {
        evidence.reachableByRoles.push(role);
      }
      for (const edge of evidence.navigation) {
        if (!edge.roles.includes(role)) continue;
        const target = resolveTargetRoute(route, edge.targetRoute, routes);
        if (!target) continue;
        const targetEvidence = routes.get(target);
        if (!targetEvidence) continue;
        const incoming = targetEvidence.incomingFrom.find(
          (item) => item.route === route && item.label === edge.label,
        );
        if (incoming) {
          if (!incoming.roles.includes(role)) incoming.roles.push(role);
        } else {
          targetEvidence.incomingFrom.push({
            route,
            label: edge.label,
            roles: [role],
          });
        }
        if (!visited.has(target)) queue.push(target);
      }
    }
  }
  for (const route of routes.values()) {
    route.reachableByRoles.sort(roleSort);
    route.incomingFrom.forEach((incoming) => incoming.roles.sort(roleSort));
  }
}

function reviewWorkflow(
  contract: WorkflowContract,
  routes: Map<string, RouteWorkingEvidence>,
): UiAffordanceWorkflowEvidence {
  if (contract.trigger !== "user_action") {
    return {
      contractId: contract.id,
      name: contract.name,
      startRoute: contract.start.route,
      roles: contract.actor.roles,
      status: "not_applicable",
      missingControls: [],
      unreachableRoles: [],
      matchedControls: 0,
      expectedControls: contract.controls.length,
      issues: [],
    };
  }

  const issues: string[] = [];
  const startRoute = findPlannedRoute(contract.start.route, routes);
  const unreachableRoles = contract.actor.roles.filter(
    (role) => !startRoute?.reachableByRoles.includes(role),
  );
  if (!startRoute) {
    issues.push(
      `ui_affordance: Workflow "${contract.name}" (${contract.id}) starts on ${contract.start.route}, but that generated route does not exist.`,
    );
  } else if (unreachableRoles.length > 0) {
    issues.push(
      `ui_affordance: Workflow "${contract.name}" (${contract.id}) starts on ${contract.start.route}, but ${unreachableRoles.join("/")} cannot reach it through visible navigation or a contextual control. Add a clearly labeled incoming link, tab, menu item, or button.`,
    );
  }

  const matched: MatchedControl[] = [];
  const missingControls: UiAffordanceWorkflowEvidence["missingControls"] = [];
  for (const expected of contract.controls) {
    const route = findPlannedRoute(expected.route, routes);
    const matchedRoles: WorkflowContractRole[] = [];
    let actualMatch: UiAffordanceControlEvidence | null = null;
    for (const role of expected.roles) {
      const exact = route?.controls.find(
        (control) =>
          control.roles.includes(role) &&
          compatibleControlKind(expected.kind, control.kind) &&
          labelsEquivalent(expected.accessibleName, control.label),
      );
      const actual =
        exact ??
        route?.controls.find(
          (control) =>
            control.roles.includes(role) &&
            compatibleControlKind(expected.kind, control.kind) &&
            control.labelConfidence === "dynamic",
        );
      if (actual) {
        matchedRoles.push(role);
        actualMatch ??= actual;
      }
    }
    if (actualMatch && matchedRoles.length === expected.roles.length) {
      matched.push({ expected, actual: actualMatch, roles: matchedRoles });
      continue;
    }
    const missingRoles = expected.roles.filter(
      (role) => !matchedRoles.includes(role),
    );
    missingControls.push({
      controlId: expected.id,
      label: expected.accessibleName,
      route: expected.route,
      roles: missingRoles,
    });
    issues.push(
      `ui_affordance: Workflow "${contract.name}" (${contract.id}) requires a visible ${expected.kind} named "${expected.accessibleName}" on ${expected.route} for ${missingRoles.join("/")}, but no matching reachable control was found.`,
    );
  }

  const needsRepair = issues.length > 0;
  return {
    contractId: contract.id,
    name: contract.name,
    startRoute: contract.start.route,
    roles: contract.actor.roles,
    status: needsRepair ? "needs_repair" : "discoverable",
    missingControls,
    unreachableRoles,
    matchedControls: matched.length,
    expectedControls: contract.controls.length,
    issues,
  };
}

function reviewEntities(input: {
  spec: AppSpec;
  architecture: ArchitecturePlan;
  routeMap: Map<string, RouteWorkingEvidence>;
  workflowById: Map<string, UiAffordanceWorkflowEvidence>;
}): UiAffordanceEntityEvidence[] {
  return input.spec.dataEntities
    .filter((entity) => entity.ownership !== "system")
    .flatMap((entity) => {
      const planned = input.architecture.dataModel.find(
        (candidate) =>
          normalizeIdentifier(candidate.name) === normalizeIdentifier(entity.name),
      );
      if (planned?.storage === "none" || planned?.storage === "future") return [];
      const entityKey = platformEntityFromSpec(entity, input.spec).key;
      const contracts = input.architecture.workflowContracts.filter((contract) =>
        contract.requiredData.some(
          (required) => normalizeIdentifier(required.entityKey) === normalizeIdentifier(entityKey),
        ),
      );
      const requiredOperations = uniqueOperations([
        "read",
        ...contracts.flatMap((contract) =>
          contract.requiredData
            .filter(
              (required) =>
                normalizeIdentifier(required.entityKey) ===
                normalizeIdentifier(entityKey),
            )
            .flatMap((required) => required.operations),
        ),
      ]);
      const routes = uniqueStrings(
        contracts.flatMap((contract) => [
          contract.start.route,
          contract.success.route,
          ...contract.controls.map((control) => control.route),
        ]),
      );
      const availableOperations = requiredOperations.filter((operation) => {
        if (operation === "read") {
          return routes.some((route) => {
            const evidence = findPlannedRoute(route, input.routeMap);
            return (
              Boolean(evidence?.reachableByRoles.length) &&
              sourceMentionsEntity(evidence?.sourceText ?? "", entity.name, entityKey)
            );
          });
        }
        const sourceHasOperation = routes.some((route) => {
          const evidence = findPlannedRoute(route, input.routeMap);
          return (
            Boolean(evidence?.reachableByRoles.length) &&
            sourceMentionsEntity(
              evidence?.sourceText ?? "",
              entity.name,
              entityKey,
            ) &&
            sourceMentionsDataOperation(evidence?.sourceText ?? "", operation)
          );
        });
        if (sourceHasOperation) return true;
        return contracts.some((contract) => {
          const workflow = input.workflowById.get(contract.id);
          return (
            workflow?.status === "discoverable" &&
            contract.expectedSaves.some(
              (save) =>
                save.operation === operation &&
                normalizeIdentifier(save.entityKey) === normalizeIdentifier(entityKey),
            )
          );
        });
      });
      return [
        {
          entityName: entity.name,
          entityKey,
          status:
            availableOperations.length === requiredOperations.length
              ? "available"
              : "needs_repair",
          requiredOperations,
          availableOperations,
          routes,
        },
      ];
    });
}

function findBrokenNavigationIssues(
  routes: Map<string, RouteWorkingEvidence>,
): string[] {
  const issues: string[] = [];
  for (const route of routes.values()) {
    for (const edge of route.navigation) {
      if (!isInternalRoute(edge.targetRoute)) continue;
      if (resolveTargetRoute(route.route, edge.targetRoute, routes)) continue;
      issues.push(
        `ui_affordance: ${edge.filePath}:${edge.line} exposes "${edge.label}" from ${route.route}, but its target ${edge.targetRoute} does not match a generated page.`,
      );
    }
  }
  return uniqueStrings(issues);
}

function findPlannedRoute(
  plannedRoute: string,
  routes: Map<string, RouteWorkingEvidence>,
): RouteWorkingEvidence | null {
  const normalized = normalizeRoute(plannedRoute);
  return (
    routes.get(normalized) ??
    [...routes.values()].find((route) =>
      routePatternsOverlap(route.route, normalized),
    ) ??
    null
  );
}

function resolveTargetRoute(
  currentRoute: string,
  target: string,
  routes: Map<string, RouteWorkingEvidence>,
): string | null {
  if (!isInternalRoute(target)) return null;
  const withoutQuery = target.split(/[?#]/)[0] || "/";
  const normalized = withoutQuery.startsWith("/")
    ? normalizeRoute(withoutQuery)
    : normalizeRoute(`${currentRoute}/${withoutQuery}`);
  if (routes.has(normalized)) return normalized;
  const normalizedParts = normalized.split("/").filter(Boolean);
  const candidates = [...routes.keys()].filter((route) =>
    routePatternsOverlap(route, normalized),
  );
  const wildcardMatch = candidates.find((route) => {
    const routeParts = route.split("/").filter(Boolean);
    return normalizedParts.every(
      (part, index) => part !== "*" || isDynamicRoutePart(routeParts[index]),
    );
  });
  return wildcardMatch ?? candidates[0] ?? null;
}

function routePatternsOverlap(left: string, right: string): boolean {
  const leftParts = normalizeRoute(left).split("/").filter(Boolean);
  const rightParts = normalizeRoute(right).split("/").filter(Boolean);
  if (leftParts.length !== rightParts.length) return false;
  return leftParts.every(
    (part, index) =>
      part === rightParts[index] ||
      isDynamicRoutePart(part) ||
      isDynamicRoutePart(rightParts[index]),
  );
}

function compatibleControlKind(
  expected: WorkflowContract["controls"][number]["kind"],
  actual: WorkflowContract["controls"][number]["kind"],
): boolean {
  if (expected === actual) return true;
  if (expected === "form" && actual === "button") return true;
  if (
    ["button", "link", "menu"].includes(expected) &&
    ["button", "link", "menu"].includes(actual)
  ) {
    return true;
  }
  return false;
}

function labelsEquivalent(expected: string, actual: string): boolean {
  const normalizedExpected = normalizeLabel(expected);
  const normalizedActual = normalizeLabel(actual);
  if (!normalizedActual) return false;
  if (normalizedExpected === normalizedActual) return true;
  if (
    normalizedActual.includes(normalizedExpected) ||
    normalizedExpected.includes(normalizedActual)
  ) {
    return Math.min(normalizedActual.length, normalizedExpected.length) >= 5;
  }
  const expectedWords = labelWords(normalizedExpected);
  const actualWords = new Set(labelWords(normalizedActual));
  const overlap = expectedWords.filter((word) => actualWords.has(word)).length;
  return expectedWords.length > 0 && overlap / expectedWords.length >= 0.67;
}

function isVagueOrUnlabeledAction(
  control: UiAffordanceControlEvidence,
): boolean {
  if (!ACTION_CONTROL_KINDS.has(control.kind)) return false;
  if (control.labelConfidence === "dynamic") return false;
  const label = normalizeLabel(control.label);
  return !label || VAGUE_LABELS.has(label);
}

function isPlaceholderRoute(input: {
  controls: UiAffordanceControlEvidence[];
  navigation: NavigationEvidence[];
  sourceText: string;
  renderedText: string[];
}): boolean {
  const renderedText = input.renderedText.join(" ");
  if (PLACEHOLDER_TEXT_PATTERN.test(renderedText)) return true;
  if (input.controls.length > 0 || input.navigation.length > 0) return false;
  if (RUNTIME_EVIDENCE_PATTERN.test(input.sourceText)) return false;
  return labelWords(renderedText).length < 40;
}

function collectModuleClosure(
  startPath: string,
  modules: Map<string, ModuleAnalysis>,
): Set<string> {
  const visited = new Set<string>();
  const queue = [startPath];
  while (queue.length > 0) {
    const path = queue.shift();
    if (!path || visited.has(path)) continue;
    visited.add(path);
    const analysis = modules.get(path);
    if (!analysis) continue;
    for (const dependency of analysis.imports) {
      if (!visited.has(dependency)) queue.push(dependency);
    }
  }
  return visited;
}

function rolesForNode(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): WorkflowContractRole[] {
  let roles = [...ALL_ROLES];
  let current: ts.Node = node;
  let parent: ts.Node | undefined = node.parent;
  for (let depth = 0; parent && depth < 14; depth++, parent = parent.parent) {
    const constraint = roleConstraintForBranch(current, parent, sourceFile);
    if (constraint) roles = intersectRoles(roles, constraint);
    current = parent;
  }
  return roles;
}

function roleConstraintForBranch(
  child: ts.Node,
  parent: ts.Node,
  sourceFile: ts.SourceFile,
): WorkflowContractRole[] | null {
  if (ts.isConditionalExpression(parent)) {
    if (nodeContains(parent.whenTrue, child)) {
      return rolesFromCondition(parent.condition, true, sourceFile);
    }
    if (nodeContains(parent.whenFalse, child)) {
      return rolesFromCondition(parent.condition, false, sourceFile);
    }
  }
  if (ts.isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind;
    if (
      operator === ts.SyntaxKind.AmpersandAmpersandToken &&
      nodeContains(parent.right, child)
    ) {
      return rolesFromCondition(parent.left, true, sourceFile);
    }
    if (
      operator === ts.SyntaxKind.BarBarToken &&
      nodeContains(parent.right, child)
    ) {
      return rolesFromCondition(parent.left, false, sourceFile);
    }
  }
  if (ts.isIfStatement(parent)) {
    if (nodeContains(parent.thenStatement, child)) {
      return rolesFromCondition(parent.expression, true, sourceFile);
    }
    if (parent.elseStatement && nodeContains(parent.elseStatement, child)) {
      return rolesFromCondition(parent.expression, false, sourceFile);
    }
  }
  return null;
}

function nodeContains(container: ts.Node, node: ts.Node): boolean {
  return node.pos >= container.pos && node.end <= container.end;
}

function rolesFromCondition(
  condition: ts.Expression,
  truthy: boolean,
  sourceFile: ts.SourceFile,
): WorkflowContractRole[] | null {
  const text = condition.getText(sourceFile);
  const effectiveTruthy = /^\s*!/.test(text) ? !truthy : truthy;
  const normalized = text.replace(/^\s*!+\s*/, "");

  if (/\bcanManage\b/i.test(normalized)) {
    return effectiveTruthy ? ["owner"] : ["editor", "viewer", "public"];
  }
  if (/\bcanWrite\b/i.test(normalized)) {
    return effectiveTruthy
      ? ["owner", "editor"]
      : ["viewer", "public"];
  }

  const equality = normalized.match(
    /\brole\s*(===|==|!==|!=)\s*["'](owner|editor|viewer|public)["']/i,
  );
  if (!equality) return null;
  const role = equality[2].toLowerCase() as WorkflowContractRole;
  const isEqual = equality[1] === "===" || equality[1] === "==";
  return effectiveTruthy === isEqual
    ? [role]
    : ALL_ROLES.filter((candidate) => candidate !== role);
}

function routeFromHandler(
  opening: ts.JsxOpeningLikeElement,
  sourceFile: ts.SourceFile,
): string | null {
  const handler = jsxAttribute(opening, "onClick");
  if (!handler?.initializer || !ts.isJsxExpression(handler.initializer)) {
    return null;
  }
  const text = handler.initializer.getText(sourceFile);
  const match = text.match(
    /\b(?:router\.)?(?:push|replace)\s*\(\s*(["'`])([^"'`]+)\1/,
  );
  return match ? normalizeTemplateTarget(match[2]) : null;
}

function expressionRoute(
  node: ts.Expression | undefined,
  sourceFile: ts.SourceFile,
): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return normalizeTemplateTarget(node.text);
  }
  if (ts.isTemplateExpression(node)) {
    return normalizeTemplateTarget(
      `${node.head.text}${node.templateSpans
        .map((span) => `*${span.literal.text}`)
        .join("")}`,
    );
  }
  if (ts.isParenthesizedExpression(node)) {
    return expressionRoute(node.expression, sourceFile);
  }
  return null;
}

function jsxAttributeValue(
  opening: ts.JsxOpeningLikeElement,
  name: string,
  sourceFile: ts.SourceFile,
): string | null {
  const attribute = jsxAttribute(opening, name);
  if (!attribute?.initializer) return null;
  if (ts.isStringLiteral(attribute.initializer)) {
    return normalizeTemplateTarget(attribute.initializer.text);
  }
  if (ts.isJsxExpression(attribute.initializer)) {
    const expression = attribute.initializer.expression;
    if (!expression) return null;
    if (
      ts.isStringLiteral(expression) ||
      ts.isNoSubstitutionTemplateLiteral(expression)
    ) {
      return normalizeTemplateTarget(expression.text);
    }
    if (ts.isTemplateExpression(expression)) {
      return expressionRoute(expression, sourceFile);
    }
  }
  return null;
}

function jsxAttributeDynamicKey(
  opening: ts.JsxOpeningLikeElement,
  name: string,
  sourceFile: ts.SourceFile,
): string | null {
  const attribute = jsxAttribute(opening, name);
  if (
    !attribute?.initializer ||
    !ts.isJsxExpression(attribute.initializer) ||
    !attribute.initializer.expression
  ) {
    return null;
  }
  return dynamicExpressionKey(attribute.initializer.expression, sourceFile);
}

function jsxAttribute(
  opening: ts.JsxOpeningLikeElement,
  name: string,
): ts.JsxAttribute | undefined {
  return opening.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === name,
  );
}

function objectStringProperty(
  node: ts.ObjectLiteralExpression,
  names: string[],
  sourceFile: ts.SourceFile,
): string | null {
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name.getText(sourceFile).replace(/["']/g, "");
    if (!names.includes(name)) continue;
    const value = expressionRoute(property.initializer, sourceFile);
    if (value) return value;
    const text = expressionText(property.initializer, sourceFile);
    if (text) return normalizeVisibleText(text);
  }
  return null;
}

function navigationTuple(
  node: ts.ArrayLiteralExpression,
  sourceFile: ts.SourceFile,
): { label: string; targetRoute: string } | null {
  if (node.elements.length !== 2) return null;
  const values = node.elements.map((element) =>
    ts.isExpression(element) ? expressionText(element, sourceFile) : "",
  );
  const routeIndex = values.findIndex((value) => isStaticAppRoute(value));
  if (routeIndex < 0) return null;
  const label = normalizeVisibleText(values[routeIndex === 0 ? 1 : 0] ?? "");
  if (!label || isStaticAppRoute(label)) return null;
  return {
    label,
    targetRoute: normalizeTemplateTarget(values[routeIndex]),
  };
}

function keyedNavigationProperty(
  node: ts.PropertyAssignment,
  sourceFile: ts.SourceFile,
): { label: string; targetRoute: string } | null {
  if (
    ts.isObjectLiteralExpression(node.parent) &&
    node.parent.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        ["href", "route", "to", "path", "url"].includes(
          propertyNameText(property.name, sourceFile),
        ),
    )
  ) {
    return null;
  }
  const key = propertyNameText(node.name, sourceFile);
  const value = expressionText(node.initializer, sourceFile);
  if (isStaticAppRoute(key) && value) {
    return {
      label: normalizeVisibleText(value),
      targetRoute: normalizeTemplateTarget(key),
    };
  }
  if (isStaticAppRoute(value) && key) {
    return {
      label: normalizeVisibleText(key),
      targetRoute: normalizeTemplateTarget(value),
    };
  }
  return null;
}

function isNavigationCollection(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  let current: ts.Node | undefined = node;
  while (current && current !== sourceFile) {
    if (
      ts.isVariableDeclaration(current) &&
      ts.isIdentifier(current.name) &&
      /(?:nav|link|menu|route)/i.test(current.name.text)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function propertyNameText(name: ts.PropertyName, sourceFile: ts.SourceFile): string {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return name.getText(sourceFile).replace(/^["'`]|["'`]$/g, "");
}

function isStaticAppRoute(value: string): boolean {
  return /^\/(?:[^\s]*)$/.test(value.trim());
}

function staticAppRoutes(node: ts.Node): string[] {
  const routes: string[] = [];
  const visit = (current: ts.Node) => {
    if (
      ts.isStringLiteral(current) ||
      ts.isNoSubstitutionTemplateLiteral(current)
    ) {
      if (isStaticAppRoute(current.text)) {
        routes.push(normalizeTemplateTarget(current.text));
      }
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return uniqueStrings(routes);
}

function sourceMentionsEntity(
  source: string,
  entityName: string,
  entityKey: string,
): boolean {
  const normalized = normalizeIdentifier(source);
  return [entityName, entityKey]
    .map(normalizeIdentifier)
    .some((term) => term.length > 2 && normalized.includes(term));
}

function sourceMentionsDataOperation(
  source: string,
  operation: "create" | "update" | "delete",
): boolean {
  const verb =
    operation === "create"
      ? "create|add|saveNew"
      : operation === "update"
        ? "update|edit|saveChanges|set"
        : "delete|remove|archive";
  return new RegExp(
    `\\b(?:${verb})(?:PlatformRecord|[A-Z][A-Za-z0-9_]*)?\\s*\\(`,
  ).test(source);
}

function resolveInternalImport(
  sourcePath: string,
  specifier: string,
  files: FileMap,
): string | null {
  let base: string | null = null;
  if (specifier.startsWith("@/")) {
    base = `src/${specifier.slice(2)}`;
  } else if (specifier.startsWith(".")) {
    const sourceDir = sourcePath.split("/").slice(0, -1).join("/");
    base = normalizeFilePath(`${sourceDir}/${specifier}`);
  }
  if (!base) return null;
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ];
  return candidates.find((candidate) => files[candidate] !== undefined) ?? null;
}

function pagePathToRoute(path: string): string {
  const relative = path.replace(/^src\/app\//, "");
  const directory = relative === "page.tsx" ? "" : relative.replace(/\/page\.tsx$/, "");
  const middle = directory
    .split("/")
    .filter((part) => part && !/^\(.+\)$/.test(part));
  return middle.length === 0 ? "/" : `/${middle.join("/")}`;
}

function layoutPathToRoutePrefix(path: string): string {
  const relative = path.replace(/^src\/app\//, "");
  const directory =
    relative === "layout.tsx" ? "" : relative.replace(/\/layout\.tsx$/, "");
  const middle = directory
    .split("/")
    .filter((part) => part && !/^\(.+\)$/.test(part));
  return middle.length === 0 ? "/" : `/${middle.join("/")}`;
}

function routeUnderLayout(route: string, prefix: string): boolean {
  return prefix === "/" || route === prefix || route.startsWith(`${prefix}/`);
}

function isAnalyzableSource(path: string): boolean {
  return (
    SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension)) &&
    (path.startsWith("src/app/") ||
      path.startsWith("src/components/") ||
      path.startsWith("src/lib/")) &&
    !path.startsWith("src/app/api/") &&
    !/(?:\.test|\.spec)\.tsx?$/.test(path)
  );
}

function isPageFile(path: string): boolean {
  return /^src\/app\/(?:.+\/)?page\.tsx$/.test(path);
}

function isLayoutFile(path: string): boolean {
  return /^src\/app\/(?:.+\/)?layout\.tsx$/.test(path);
}

function isInternalRoute(value: string): boolean {
  return (
    (value.startsWith("/") || value.startsWith(".")) &&
    !value.startsWith("/api/")
  );
}

function isDynamicRoutePart(value: string | undefined): boolean {
  return Boolean(value && (value === "*" || /^\[+.+\]+$/.test(value)));
}

function normalizeTemplateTarget(value: string): string {
  return value.replace(/\$\{[^}]+\}/g, "*").trim();
}

function normalizeRoute(value: string): string {
  const clean = value.trim().replace(/\/{2,}/g, "/");
  if (!clean || clean === "/") return "/";
  return `/${clean.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

function normalizeVisibleText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeLabel(value: string): string {
  return normalizeVisibleText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function labelWords(value: string): string[] {
  return normalizeLabel(value)
    .split(" ")
    .filter((word) => word.length > 1 && !LABEL_STOP_WORDS.has(word));
}

function normalizeIdentifier(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeFilePath(value: string): string {
  const parts: string[] = [];
  for (const part of value.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function stringValue(node: ts.Expression): string | null {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : null;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function uniqueModuleControls(controls: ModuleControl[]): ModuleControl[] {
  const seen = new Set<string>();
  return controls.filter((control) => {
    const key = `${control.ownerComponent ?? ""}:${control.filePath}:${control.sourcePosition}:${control.kind}:${control.label}:${control.dynamicLabelKey ?? ""}:${control.targetRoute ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueControls(
  controls: UiAffordanceControlEvidence[],
): UiAffordanceControlEvidence[] {
  const seen = new Set<string>();
  return controls.filter((control) => {
    const sourcePosition = (
      control as UiAffordanceControlEvidence & { sourcePosition?: number }
    ).sourcePosition ?? control.line;
    const key = `${control.route}:${control.filePath}:${sourcePosition}:${control.kind}:${control.label}:${control.targetRoute ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueSourceControls(
  controls: UiAffordanceControlEvidence[],
): UiAffordanceControlEvidence[] {
  const seen = new Set<string>();
  return controls.filter((control) => {
    const key = `${control.filePath}:${control.line}:${control.kind}:${control.label}:${control.labelConfidence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueNavigation(
  navigation: NavigationEvidence[],
): NavigationEvidence[] {
  const seen = new Set<string>();
  return navigation.filter((item) => {
    const key = `${item.ownerComponent ?? ""}:${item.filePath}:${item.line}:${item.label}:${item.targetRoute}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueComponentReferences(
  references: ComponentReference[],
): ComponentReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.ownerComponent ?? ""}:${reference.targetPath}:${reference.targetComponent ?? ""}:${JSON.stringify(reference.props)}:${reference.roles.join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueRenderedText(
  values: ModuleAnalysis["renderedText"],
): ModuleAnalysis["renderedText"] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.ownerComponent ?? ""}:${value.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueOperations(
  operations: Array<"create" | "read" | "update" | "delete">,
): Array<"create" | "read" | "update" | "delete"> {
  const order = ["create", "read", "update", "delete"] as const;
  const values = new Set(operations);
  return order.filter((operation) => values.has(operation));
}

function roleSort(left: WorkflowContractRole, right: WorkflowContractRole): number {
  return ALL_ROLES.indexOf(left) - ALL_ROLES.indexOf(right);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
