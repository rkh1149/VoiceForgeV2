import ts from "typescript";

export const ACCEPTANCE_TRACE_HELPERS = [
  "workflowJourneyTitle",
  "workflowStepTitle",
  "workflowSaveTitle",
  "workflowHandoffTitle",
  "voiceForgeRoleHeaders",
] as const;

export type AcceptanceTraceHelper =
  (typeof ACCEPTANCE_TRACE_HELPERS)[number];

export type AcceptanceTraceCall = {
  helper: AcceptanceTraceHelper;
  args: string[];
  index: number;
  scopeStart: number | null;
  scopeEnd: number | null;
};

const TRACE_HELPER_SET = new Set<string>(ACCEPTANCE_TRACE_HELPERS);

export function extractAcceptanceTraceCalls(
  source: string,
): AcceptanceTraceCall[] {
  const sourceFile = ts.createSourceFile(
    "generated-acceptance.spec.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const declarations = new Map<string, ts.Expression>();
  const helperAliases = new Map<string, AcceptanceTraceHelper>(
    ACCEPTANCE_TRACE_HELPERS.map((helper) => [helper, helper]),
  );
  const namespaceAliases = new Set<string>();

  const collectBindings = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      declarations.set(node.name.text, node.initializer);
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /(?:^|\/)voiceforge-acceptance$/.test(node.moduleSpecifier.text)
    ) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (TRACE_HELPER_SET.has(importedName)) {
            helperAliases.set(
              element.name.text,
              importedName as AcceptanceTraceHelper,
            );
          }
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        namespaceAliases.add(bindings.name.text);
      }
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(sourceFile);

  const calls: AcceptanceTraceCall[] = [];
  const collectCalls = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const helper = resolveHelperName(
        node.expression,
        helperAliases,
        namespaceAliases,
      );
      if (helper) {
        const scope = acceptanceStepScope(node, sourceFile);
        calls.push({
          helper,
          args: node.arguments.map(
            (argument) =>
              resolveStaticString(argument, declarations, new Set()) ?? "",
          ),
          index: node.getStart(sourceFile),
          scopeStart: scope?.start ?? null,
          scopeEnd: scope?.end ?? null,
        });
      }
    }
    ts.forEachChild(node, collectCalls);
  };
  collectCalls(sourceFile);

  return calls.sort((left, right) => left.index - right.index);
}

function acceptanceStepScope(
  traceCall: ts.CallExpression,
  sourceFile: ts.SourceFile,
): { start: number; end: number } | null {
  let current: ts.Node | undefined = traceCall.parent;
  while (current && current !== sourceFile) {
    if (ts.isCallExpression(current) && isTestStepCall(current)) {
      const callback = current.arguments[1];
      if (
        callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
      ) {
        return {
          start: callback.body.getStart(sourceFile),
          end: callback.body.getEnd(),
        };
      }
      return null;
    }
    current = current.parent;
  }
  return null;
}

function isTestStepCall(call: ts.CallExpression): boolean {
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === "step"
  );
}

export function findAcceptanceTraceCall(
  calls: readonly AcceptanceTraceCall[],
  helper: AcceptanceTraceHelper,
  args: readonly string[],
): AcceptanceTraceCall | null {
  return (
    calls.find(
      (call) =>
        call.helper === helper &&
        args.every((arg, index) => call.args[index] === arg),
    ) ?? null
  );
}

function resolveHelperName(
  expression: ts.LeftHandSideExpression,
  aliases: Map<string, AcceptanceTraceHelper>,
  namespaceAliases: Set<string>,
): AcceptanceTraceHelper | null {
  if (ts.isIdentifier(expression)) {
    return aliases.get(expression.text) ?? null;
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    namespaceAliases.has(expression.expression.text) &&
    TRACE_HELPER_SET.has(expression.name.text)
  ) {
    return expression.name.text as AcceptanceTraceHelper;
  }
  return null;
}

function resolveStaticString(
  expression: ts.Expression,
  declarations: Map<string, ts.Expression>,
  resolving: Set<string>,
): string | null {
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return expression.text;
  }
  if (ts.isIdentifier(expression)) {
    if (resolving.has(expression.text)) return null;
    const declaration = declarations.get(expression.text);
    if (!declaration) return null;
    const nextResolving = new Set(resolving).add(expression.text);
    return resolveStaticString(declaration, declarations, nextResolving);
  }
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return resolveStaticString(expression.expression, declarations, resolving);
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = resolveStaticString(expression.left, declarations, resolving);
    const right = resolveStaticString(expression.right, declarations, resolving);
    return left !== null && right !== null ? left + right : null;
  }
  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text;
    for (const span of expression.templateSpans) {
      const resolved = resolveStaticString(
        span.expression,
        declarations,
        resolving,
      );
      if (resolved === null) return null;
      value += resolved + span.literal.text;
    }
    return value;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return resolveObjectProperty(
      expression.expression,
      expression.name.text,
      declarations,
      resolving,
    );
  }
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression
  ) {
    const property = resolveStaticString(
      expression.argumentExpression,
      declarations,
      resolving,
    );
    return property === null
      ? null
      : resolveObjectProperty(
          expression.expression,
          property,
          declarations,
          resolving,
        );
  }
  return null;
}

function resolveObjectProperty(
  expression: ts.Expression,
  propertyName: string,
  declarations: Map<string, ts.Expression>,
  resolving: Set<string>,
): string | null {
  const objectExpression = unwrapObjectExpression(
    expression,
    declarations,
    resolving,
  );
  if (!objectExpression) return null;
  const property = objectExpression.properties.find((candidate) => {
    if (!ts.isPropertyAssignment(candidate)) return false;
    return propertyAssignmentName(candidate.name) === propertyName;
  });
  return property && ts.isPropertyAssignment(property)
    ? resolveStaticString(property.initializer, declarations, resolving)
    : null;
}

function unwrapObjectExpression(
  expression: ts.Expression,
  declarations: Map<string, ts.Expression>,
  resolving: Set<string>,
): ts.ObjectLiteralExpression | null {
  if (ts.isObjectLiteralExpression(expression)) return expression;
  if (ts.isIdentifier(expression)) {
    if (resolving.has(expression.text)) return null;
    const declaration = declarations.get(expression.text);
    if (!declaration) return null;
    return unwrapObjectExpression(
      declaration,
      declarations,
      new Set(resolving).add(expression.text),
    );
  }
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return unwrapObjectExpression(expression.expression, declarations, resolving);
  }
  return null;
}

function propertyAssignmentName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}
