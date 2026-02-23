// generate.ts
//
// Usage:
//   ts-node generate.ts ./api-spec/dump.json ./src
//
// It will create 3 files in the target directory:
//   - types.ts
//   - queries.ts
//   - hooks.ts

import fs from "fs";
import path from "path";
import { BASE_URL } from "./constants";

type HttpMethod = "get" | "post" | "patch" | "delete" | "put";

type OpenAPISpec = {
  paths: {
    [p: string]: {
      [m in HttpMethod]?: any;
    };
  };
  components?: {
    schemas?: Record<string, any>;
  };
};

type OperationMeta = {
  method: HttpMethod;
  path: string;
  operation: any;
  operationName: string; // e.g. getCalendarMonth
  baseKey: string; // e.g. calendarMonth
  pathParams: { name: string; schema: any; required: boolean }[];
  queryParams: { name: string; schema: any; required: boolean }[];
};

// ---------------------------------------------------------
// Helpers: name building
// ---------------------------------------------------------

function pascalCase(str: string): string {
  return str
    .replace(/^[^a-zA-Z]+/, "")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

function camelCase(str: string): string {
  const p = pascalCase(str);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

// /user-api/calendar/day/{day} + method GET
// -> baseName: "calendarDayByDay"
// -> operationName: "getCalendarDayByDay"
// -> key: "calendarDayByDay"
function buildNames(
  method: HttpMethod,
  rawPath: string
): { operationName: string; baseKey: string } {
  let path = rawPath;
  if (path.startsWith("/")) path = path.slice(1);
  if (path.startsWith("user-api/")) path = path.slice("user-api/".length);

  const segments = path.split("/").filter(Boolean);
  const nameParts: string[] = [];

  for (const seg of segments) {
    const match = seg.match(/^\{(.+)\}$/);
    if (match) {
      const paramName = match[1];
      nameParts.push("By" + pascalCase(paramName));
    } else {
      nameParts.push(pascalCase(seg));
    }
  }

  const baseName = camelCase(nameParts.join(""));
  const operationName = method.toLowerCase() + pascalCase(baseName);

  if (!baseName || !operationName) {
    console.warn(
      `[buildNames] ⚠️ Generated empty name for ${method} ${rawPath}`
    );
  }

  return { operationName, baseKey: baseName };
}

// ---------------------------------------------------------
// Helpers: schema resolution and TS type generation
// ---------------------------------------------------------

function resolveRef(ref: string, spec: OpenAPISpec): any {
  // Example: "#/components/schemas/BalanceResponse"
  const pathParts = ref.replace(/^#\//, "").split("/");
  let current: any = spec;
  for (const part of pathParts) {
    if (!current || typeof current !== "object") {
      console.warn(
        `[resolveRef] ⚠️ Failed to resolve ref "${ref}" at part "${part}"`
      );
      return {};
    }
    current = current[part];
  }
  return current;
}

function isNullSchema(schema: any): boolean {
  return schema && schema.type === "null";
}

function stripNullFromAnyOf(schema: any): any {
  if (!schema || !schema.anyOf) return schema;
  const withoutNull = schema.anyOf.filter((s: any) => !isNullSchema(s));
  if (withoutNull.length === 1) return withoutNull[0];
  return { anyOf: withoutNull };
}

function isNullable(schema: any): boolean {
  if (!schema) return false;
  if (schema.type === "null") return true;
  if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
  if (schema.anyOf && schema.anyOf.some((s: any) => isNullSchema(s)))
    return true;
  return false;
}

function schemaToTsType(
  schema: any,
  spec: OpenAPISpec,
  depth = 0,
  seenRefs: Set<string> = new Set()
): string {
  if (!schema) return "any";

  // $ref
  if (schema.$ref) {
    // Check for circular reference
    if (seenRefs.has(schema.$ref)) {
      // Extract type name from ref for better readability
      const refName = schema.$ref.split("/").pop() || "any";
      console.log(
        `[schemaToTsType] ⚠️ Circular reference detected: ${schema.$ref}, using ${refName}`
      );
      return refName;
    }

    if (depth === 0) {
      console.log(`[schemaToTsType] Resolving $ref: ${schema.$ref}`);
    }

    // Add this ref to the seen set before resolving
    const newSeenRefs = new Set(seenRefs);
    newSeenRefs.add(schema.$ref);

    const resolved = resolveRef(schema.$ref, spec);
    if (!resolved) {
      console.warn(
        `[schemaToTsType] ⚠️ Could not resolve $ref: ${schema.$ref}`
      );
    }
    return schemaToTsType(resolved, spec, depth + 1, newSeenRefs);
  }

  // anyOf
  if (schema.anyOf) {
    const types = schema.anyOf.map((s: any) =>
      schemaToTsType(s, spec, depth + 1, seenRefs)
    );
    return Array.from(new Set(types)).join(" | ");
  }

  // oneOf / allOf: naive union / intersection
  if (schema.oneOf) {
    const types = schema.oneOf.map((s: any) =>
      schemaToTsType(s, spec, depth + 1, seenRefs)
    );
    return Array.from(new Set(types)).join(" | ");
  }

  if (schema.allOf) {
    const types = schema.allOf.map((s: any) =>
      schemaToTsType(s, spec, depth + 1, seenRefs)
    );
    return types.join(" & ");
  }

  // primitives
  if (schema.type === "string") {
    if (schema.enum) {
      return schema.enum.map((v: string) => JSON.stringify(v)).join(" | ");
    }
    if (schema.format === "date" || schema.format === "date-time") {
      return "string";
    }
    return "string";
  }

  if (schema.type === "integer" || schema.type === "number") {
    return "number";
  }

  if (schema.type === "boolean") {
    return "boolean";
  }

  if (schema.type === "array" || schema.items) {
    const itemType = schemaToTsType(
      schema.items || {},
      spec,
      depth + 1,
      seenRefs
    );
    return `${itemType}[]`;
  }

  // object
  if (
    schema.type === "object" ||
    schema.properties ||
    schema.additionalProperties
  ) {
    const props = schema.properties || {};
    const required: string[] = schema.required || [];
    const hasProperties = Object.keys(props).length > 0;

    // If only additionalProperties (no named properties), use Record<string, Type>
    if (!hasProperties && schema.additionalProperties) {
      const apType =
        schema.additionalProperties === true
          ? "any"
          : schemaToTsType(
              schema.additionalProperties,
              spec,
              depth + 1,
              seenRefs
            );
      return `Record<string, ${apType}>`;
    }

    const lines: string[] = [];

    for (const [propName, propSchemaRaw] of Object.entries<any>(props)) {
      const nullable = isNullable(propSchemaRaw);
      const propSchema = nullable
        ? stripNullFromAnyOf(propSchemaRaw)
        : propSchemaRaw;

      const isRequired = required.includes(propName) && !nullable;
      const tsType = schemaToTsType(propSchema, spec, depth + 1, seenRefs);
      const optionalMark = isRequired ? "" : "";

      lines.push(`${JSON.stringify(propName)}${optionalMark}: ${tsType};`);
    }

    // If object has both properties AND additionalProperties, use intersection
    if (schema.additionalProperties) {
      const apType =
        schema.additionalProperties === true
          ? "any"
          : schemaToTsType(
              schema.additionalProperties,
              spec,
              depth + 1,
              seenRefs
            );
      const indent = "  ".repeat(depth);
      const innerIndent = "  ".repeat(depth + 1);
      const propsObj = `{\n${innerIndent}${lines.join(
        `\n${innerIndent}`
      )}\n${indent}}`;
      return `${propsObj} & Record<string, ${apType}>`;
    }

    if (!lines.length) return "{}";

    const indent = "  ".repeat(depth);
    const innerIndent = "  ".repeat(depth + 1);
    return `{\n${innerIndent}${lines.join(`\n${innerIndent}`)}\n${indent}}`;
  }

  // fallback
  return "any";
}

// param schema simplification
function schemaToTsTypeForParam(schema: any): string {
  if (!schema) return "any";
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "array") {
    return (schema.items && schemaToTsTypeForParam(schema.items)) + "[]";
  }
  if (schema.enum) {
    return schema.enum.map((v: any) => JSON.stringify(v)).join(" | ");
  }
  return "string";
}

// ---------------------------------------------------------
// Collect operations from spec
// ---------------------------------------------------------

function collectOperations(spec: OpenAPISpec): OperationMeta[] {
  console.log(
    "[collectOperations] Starting to collect operations from spec paths..."
  );
  const result: OperationMeta[] = [];

  const methods: HttpMethod[] = ["get", "post", "patch", "delete", "put"];
  const pathCount = Object.keys(spec.paths || {}).length;
  console.log(`[collectOperations] Found ${pathCount} paths in spec`);

  let pathIndex = 0;
  for (const [rawPath, pathItem] of Object.entries(spec.paths || {})) {
    pathIndex++;
    console.log(
      `[collectOperations] Processing path ${pathIndex}/${pathCount}: ${rawPath}`
    );

    for (const method of methods) {
      const operation = (pathItem as any)[method];
      if (!operation) continue;

      console.log(`[collectOperations]   Found ${method.toUpperCase()} method`);

      let operationName: string;
      let baseKey: string;
      try {
        const names = buildNames(method, rawPath);
        operationName = names.operationName;
        baseKey = names.baseKey;
        console.log(
          `[collectOperations]   → operationName: ${operationName}, baseKey: ${baseKey}`
        );
      } catch (err) {
        console.error(
          `[collectOperations]   ❌ Failed to build names for ${method} ${rawPath}:`,
          err
        );
        throw err;
      }

      const parameters = operation.parameters || [];
      const pathParams: OperationMeta["pathParams"] = [];
      const queryParams: OperationMeta["queryParams"] = [];

      for (const p of parameters) {
        const param = p; // already resolved in spec
        const target =
          param.in === "path"
            ? pathParams
            : param.in === "query"
            ? queryParams
            : null;
        if (!target) continue;
        target.push({
          name: param.name,
          schema: param.schema || {},
          required: !!param.required,
        });
      }

      if (pathParams.length > 0 || queryParams.length > 0) {
        console.log(
          `[collectOperations]   → pathParams: [${pathParams
            .map((p) => p.name)
            .join(", ")}], queryParams: [${queryParams
            .map((q) => q.name)
            .join(", ")}]`
        );
      }

      result.push({
        method,
        path: rawPath,
        operation,
        operationName,
        baseKey,
        pathParams,
        queryParams,
      });
    }
  }

  console.log(`[collectOperations] Sorting ${result.length} operations...`);
  // Keep stable order
  result.sort((a, b) => {
    if (a.operationName < b.operationName) return -1;
    if (a.operationName > b.operationName) return 1;
    return 0;
  });

  console.log("[collectOperations] Done collecting operations");
  return result;
}

// ---------------------------------------------------------
// Generate types.ts
// Convention:
//   - GET: I<operationName> = response schema
//   - POST/PATCH/PUT/DELETE: I<operationName>Request = requestBody schema
//                            I<operationName>Response = response schema
// ---------------------------------------------------------

function generateTypes(spec: OpenAPISpec, operations: OperationMeta[]): string {
  console.log("[generateTypes] Starting type generation...");
  const lines: string[] = [];

  lines.push("// AUTO-GENERATED. DO NOT EDIT BY HAND.");
  lines.push("// Source: OpenAPI spec");
  lines.push("");

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    console.log(
      `[generateTypes] Processing ${i + 1}/${operations.length}: ${
        op.operationName
      }`
    );

    if (op.method === "get") {
      // GET: only response type
      console.log(
        `[generateTypes]   Extracting response schema for ${op.method.toUpperCase()}`
      );
      const responseSchema = extractResponseSchema(op.operation);

      if (!responseSchema) {
        console.log(
          `[generateTypes]   ⚠️ No response schema found, will use 'any'`
        );
      }

      let tsType: string;
      try {
        tsType = schemaToTsType(responseSchema, spec);
        console.log(
          `[generateTypes]   ✅ Generated response type (${tsType.length} chars)`
        );
      } catch (err) {
        console.error(
          `[generateTypes]   ❌ Failed to generate type for ${op.operationName}:`,
          err
        );
        throw err;
      }

      const typeName = `I${op.operationName}`;
      lines.push(`export type ${typeName} = ${tsType};`);
      lines.push("");
    } else {
      // POST/PATCH/PUT/DELETE: both request and response types
      console.log(
        `[generateTypes]   Extracting request & response schemas for ${op.method.toUpperCase()}`
      );

      // Request type
      const reqBody = op.operation.requestBody?.content?.["application/json"];
      const requestSchema = reqBody?.schema;

      let requestTsType: string;
      try {
        if (!requestSchema) {
          console.log(
            `[generateTypes]   ⚠️ No request body schema found, will use 'any'`
          );
        }
        requestTsType = schemaToTsType(requestSchema, spec);
        console.log(
          `[generateTypes]   ✅ Generated request type (${requestTsType.length} chars)`
        );
      } catch (err) {
        console.error(
          `[generateTypes]   ❌ Failed to generate request type for ${op.operationName}:`,
          err
        );
        throw err;
      }

      const requestTypeName = `I${op.operationName}Request`;
      lines.push(`export type ${requestTypeName} = ${requestTsType};`);
      lines.push("");

      // Response type
      const responseSchema = extractResponseSchema(op.operation);

      let responseTsType: string;
      try {
        if (!responseSchema) {
          console.log(
            `[generateTypes]   ⚠️ No response schema found, will use 'any'`
          );
        }
        responseTsType = schemaToTsType(responseSchema, spec);
        console.log(
          `[generateTypes]   ✅ Generated response type (${responseTsType.length} chars)`
        );
      } catch (err) {
        console.error(
          `[generateTypes]   ❌ Failed to generate response type for ${op.operationName}:`,
          err
        );
        throw err;
      }

      const responseTypeName = `I${op.operationName}Response`;
      lines.push(`export type ${responseTypeName} = ${responseTsType};`);
      lines.push("");
    }
  }

  console.log("[generateTypes] Done generating types");
  return lines.join("\n");
}

// Helper to extract response schema from 2xx status codes
function extractResponseSchema(operation: any): any {
  const responses = operation.responses || {};
  const statusCodes = Object.keys(responses).sort();
  let picked: any;
  for (const code of statusCodes) {
    if (code.startsWith("2")) {
      picked = responses[code];
      console.log(`[generateTypes]   Using status code: ${code}`);
      break;
    }
  }
  const content = picked?.content?.["application/json"];
  return content?.schema;
}

// ---------------------------------------------------------
// Generate queries.ts
// - axios instance
// - one function per operation
//   getX / postX / patchX / deleteX
// ---------------------------------------------------------

function generateQueries(
  spec: OpenAPISpec,
  operations: OperationMeta[]
): string {
  console.log("[generateQueries] Starting query generation...");
  const lines: string[] = [];

  console.log("[generateQueries] Writing imports and axios setup...");
  lines.push("// AUTO-GENERATED. DO NOT EDIT BY HAND.");
  lines.push("// Source: OpenAPI spec");
  lines.push("");
  lines.push('import axios, { AxiosInstance, AxiosResponse } from "axios";');
  lines.push('import { isTMA, tgToken } from "@/lib/utils";');
  lines.push("import {");
  for (const op of operations) {
    if (op.method === "get") {
      lines.push(`  type I${op.operationName},`);
    } else {
      lines.push(`  type I${op.operationName}Request,`);
      lines.push(`  type I${op.operationName}Response,`);
    }
  }
  lines.push('} from "./types";');
  lines.push("");
  lines.push(`export const baseUrl = "${BASE_URL}";`);
  lines.push("");
  lines.push("const token = isTMA()");
  lines.push("  ? tgToken");
  lines.push(
    '  : " tma query_id=AAGYfQdBAAAAAJh9B0ES0jeL&user=%7B%22id%22%3A1091009944%2C%22first_name%22%3A%22bum%22%2C%22last_name%22%3A%22%22%2C%22username%22%3A%22xorg88%22%2C%22language_code%22%3A%22en%22%2C%22is_premium%22%3Atrue%2C%22allows_write_to_pm%22%3Atrue%2C%22photo_url%22%3A%22https%3A%5C%2F%5C%2Ft.me%5C%2Fi%5C%2Fuserpic%5C%2F320%5C%2FmQEmFaB783lFApIuXNGqTo3Zcy-lqejD38t3_zYXLyo.svg%22%7D&auth_date=1764938612&signature=OGIBXryxq78qZ4_GMVwJYg-miQ-aiHjgPt0Upk6_sZDFCPrwXp50Mxv2URqHFIjw4QDyHLV--ydG9_jY4RhgDw&hash=db565f24b4263d1f18c615c3492487d6ec4f7e50b0e2c88de25f4da0744c81f3";'
  );
  lines.push("");
  lines.push("export const axiosInstance: AxiosInstance = axios.create({");
  lines.push("  baseURL: baseUrl,");
  lines.push("  headers: {");
  lines.push('    "Content-Type": "application/json",');
  lines.push('    Accept: "application/json",');
  lines.push("    Authorization: token,");
  lines.push("  },");
  lines.push("});");
  lines.push("");
  console.log("[generateQueries] Axios setup complete");

  console.log("[generateQueries] Generating query functions...");
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    console.log(
      `[generateQueries] Processing ${i + 1}/${operations.length}: ${
        op.operationName
      }`
    );

    try {
      const fnName = op.operationName;

      let pathExpr = op.path.replace(/^\/user-api/, "");
      for (const p of op.pathParams) {
        pathExpr = pathExpr.replace(`{${p.name}}`, `\${${p.name}}`);
      }
      pathExpr = "`" + pathExpr + "`";
      console.log(`[generateQueries]   Path expression: ${pathExpr}`);

      const paramFields: string[] = [];
      for (const p of op.pathParams) {
        const tsType = schemaToTsTypeForParam(p.schema);
        // params are also imperative -> no ?
        paramFields.push(`${p.name}: ${tsType}`);
      }
      for (const q of op.queryParams) {
        const tsType = schemaToTsTypeForParam(q.schema);
        paramFields.push(`${q.name}: ${tsType}`);
      }

      const hasParams = paramFields.length > 0;
      const paramsType = hasParams ? `{ ${paramFields.join("; ")} }` : "void";

      if (op.method === "get") {
        // GET: only response type (I{operationName})
        const responseType = `I${op.operationName}`;
        console.log(
          `[generateQueries]   Generating ${op.method.toUpperCase()} query function`
        );
        const axiosMethod = op.method;
        const argsSignature = hasParams ? `(params: ${paramsType})` : "()";

        const queryParamsObject =
          op.queryParams.length > 0
            ? `{
      params: { ${op.queryParams.map((q) => q.name).join(", ")} },
    }`
            : "undefined";

        lines.push(`export const ${fnName} = async ${argsSignature} => {`);
        if (hasParams) {
          const allNames = [
            ...op.pathParams.map((p) => p.name),
            ...op.queryParams.map((q) => q.name),
          ];
          lines.push(`  const { ${allNames.join(", ")} } = params;`);
        }
        if (op.queryParams.length > 0) {
          lines.push(
            `  const response: AxiosResponse<${responseType}> = await axiosInstance.${axiosMethod}(${pathExpr}, ${queryParamsObject});`
          );
        } else {
          lines.push(
            `  const response: AxiosResponse<${responseType}> = await axiosInstance.${axiosMethod}(${pathExpr});`
          );
        }
        lines.push("  return response.data;");
        lines.push("};");
        lines.push("");
      } else if (op.method === "delete") {
        // DELETE: Request and Response types
        const responseType = `I${op.operationName}Response`;
        console.log(
          `[generateQueries]   Generating ${op.method.toUpperCase()} query function`
        );
        const axiosMethod = op.method;
        const argsSignature = hasParams ? `(params: ${paramsType})` : "()";

        const queryParamsObject =
          op.queryParams.length > 0
            ? `{
      params: { ${op.queryParams.map((q) => q.name).join(", ")} },
    }`
            : "undefined";

        lines.push(`export const ${fnName} = async ${argsSignature} => {`);
        if (hasParams) {
          const allNames = [
            ...op.pathParams.map((p) => p.name),
            ...op.queryParams.map((q) => q.name),
          ];
          lines.push(`  const { ${allNames.join(", ")} } = params;`);
        }
        if (op.queryParams.length > 0) {
          lines.push(
            `  const response: AxiosResponse<${responseType}> = await axiosInstance.${axiosMethod}(${pathExpr}, ${queryParamsObject});`
          );
        } else {
          lines.push(
            `  const response: AxiosResponse<${responseType}> = await axiosInstance.${axiosMethod}(${pathExpr});`
          );
        }
        lines.push("  return response.data;");
        lines.push("};");
        lines.push("");
      } else {
        // POST/PATCH/PUT: Request and Response types
        const requestType = `I${op.operationName}Request`;
        const responseType = `I${op.operationName}Response`;
        console.log(
          `[generateQueries]   Generating ${op.method.toUpperCase()} mutation function`
        );
        const axiosMethod = op.method;

        if (!hasParams) {
          lines.push(
            `export const ${fnName} = async (body: ${requestType}) => {`
          );
          lines.push(
            `  const response: AxiosResponse<${responseType}> = await axiosInstance.${axiosMethod}(${pathExpr}, body);`
          );
          lines.push("  return response.data;");
          lines.push("};");
          lines.push("");
        } else {
          lines.push(
            `export const ${fnName} = async (params: ${paramsType}, body: ${requestType}) => {`
          );
          const allNames = [
            ...op.pathParams.map((p) => p.name),
            ...op.queryParams.map((q) => q.name),
          ];
          lines.push(`  const { ${allNames.join(", ")} } = params;`);

          const queryParamsObject =
            op.queryParams.length > 0
              ? `{
      params: { ${op.queryParams.map((q) => q.name).join(", ")} },
    }`
              : "undefined";

          if (op.queryParams.length > 0) {
            lines.push(
              `  const response: AxiosResponse<${responseType}> = await axiosInstance.${axiosMethod}(${pathExpr}, body, ${queryParamsObject});`
            );
          } else {
            lines.push(
              `  const response: AxiosResponse<${responseType}> = await axiosInstance.${axiosMethod}(${pathExpr}, body);`
            );
          }
          lines.push("  return response.data;");
          lines.push("};");
          lines.push("");
        }
      }
      console.log(`[generateQueries]   ✅ Generated ${fnName}`);
    } catch (err) {
      console.error(
        `[generateQueries]   ❌ Failed to generate query for ${op.operationName}:`,
        err
      );
      throw err;
    }
  }

  console.log("[generateQueries] Done generating queries");
  return lines.join("\n");
}

// ---------------------------------------------------------
// Generate hooks.ts
// - useQuery for GET/DELETE
// - useMutation for POST/PATCH/PUT
// key: baseKey (camel notation of endpoint)
// ---------------------------------------------------------

function generateHooks(
  _spec: OpenAPISpec,
  operations: OperationMeta[]
): string {
  console.log("[generateHooks] Starting hook generation...");
  const lines: string[] = [];

  console.log("[generateHooks] Writing imports...");
  lines.push("// AUTO-GENERATED. DO NOT EDIT BY HAND.");
  lines.push("// Source: OpenAPI spec");
  lines.push("");
  lines.push('import { useQuery, useMutation } from "@tanstack/react-query";');
  lines.push("import {");
  for (const op of operations) {
    lines.push(`  ${op.operationName},`);
  }
  lines.push('} from "./queries";');

  // Import request types for mutations that have params
  const requestTypesToImport: string[] = [];
  for (const op of operations) {
    if (op.method !== "get" && op.method !== "delete") {
      // Check if mutation has params (path/query params)
      const hasParams = op.pathParams.length > 0 || op.queryParams.length > 0;
      if (hasParams) {
        const requestType = `I${op.operationName}Request`;
        requestTypesToImport.push(requestType);
      }
    }
  }

  if (requestTypesToImport.length > 0) {
    lines.push("import {");
    for (const typeName of requestTypesToImport) {
      lines.push(`  ${typeName},`);
    }
    lines.push('} from "./types";');
  }

  lines.push("");

  console.log("[generateHooks] Generating hook functions...");
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    console.log(
      `[generateHooks] Processing ${i + 1}/${operations.length}: ${
        op.operationName
      }`
    );

    try {
      const hookName = "use" + pascalCase(op.operationName);
      const fnName = op.operationName;
      const key = op.baseKey;

      const paramFields: string[] = [];
      for (const p of op.pathParams) {
        const tsType = schemaToTsTypeForParam(p.schema);
        const optionalMark = p.required ? "" : "";
        paramFields.push(`${p.name}${optionalMark}: ${tsType}`);
      }
      for (const q of op.queryParams) {
        const tsType = schemaToTsTypeForParam(q.schema);
        const optionalMark = q.required ? "" : "";
        paramFields.push(`${q.name}${optionalMark}: ${tsType}`);
      }
      const hasParams = paramFields.length > 0;
      const paramsType = hasParams ? `{ ${paramFields.join("; ")} }` : "void";

      if (op.method === "get" || op.method === "delete") {
        console.log(`[generateHooks]   Generating useQuery hook: ${hookName}`);
        if (!hasParams) {
          lines.push(`export const ${hookName} = () => {`);
          lines.push("  return useQuery({");
          lines.push(`    queryKey: ["${key}"],`);
          lines.push(`    queryFn: ${fnName},`);
          lines.push("  });");
          lines.push("};");
          lines.push("");
        } else {
          const allNames = [
            ...op.pathParams.map((p) => p.name),
            ...op.queryParams.map((q) => q.name),
          ];
          lines.push(`export const ${hookName} = (params: ${paramsType}) => {`);
          lines.push("  return useQuery({");
          lines.push(
            `    queryKey: ["${key}", ${allNames
              .map((n) => `params.${n}`)
              .join(", ")}],`
          );
          lines.push(`    queryFn: () => ${fnName}(params),`);
          lines.push("  });");
          lines.push("};");
          lines.push("");
        }
      } else {
        console.log(
          `[generateHooks]   Generating useMutation hook: ${hookName}`
        );
        // write methods => mutation
        // Check if mutation has params (path/query params)
        if (!hasParams) {
          // No params, only body
          lines.push(`export const ${hookName} = () => {`);
          lines.push("  return useMutation({");
          lines.push(`    mutationFn: ${fnName},`);
          lines.push("  });");
          lines.push("};");
          lines.push("");
        } else {
          // Has params and body
          const requestType = `I${op.operationName}Request`;
          const allNames = [
            ...op.pathParams.map((p) => p.name),
            ...op.queryParams.map((q) => q.name),
          ];

          // Build the param destructuring signature
          const paramProps = allNames.map((n) => `  ${n}`).join(",\n");
          const paramTypes = paramFields.map((pf) => `  ${pf}`).join(";\n");

          lines.push(`export const ${hookName} = ({`);
          lines.push(paramProps + ",");
          lines.push("  body,");
          lines.push("}: {");
          lines.push(paramTypes + ";");
          lines.push(`  body: ${requestType};`);
          lines.push("}) => {");
          lines.push("  return useMutation({");
          lines.push(
            `    mutationFn: () => ${fnName}({ ${allNames.join(", ")} }, body),`
          );
          lines.push("  });");
          lines.push("};");
          lines.push("");
        }
      }
      console.log(`[generateHooks]   ✅ Generated ${hookName}`);
    } catch (err) {
      console.error(
        `[generateHooks]   ❌ Failed to generate hook for ${op.operationName}:`,
        err
      );
      throw err;
    }
  }

  console.log("[generateHooks] Done generating hooks");
  return lines.join("\n");
}

// ---------------------------------------------------------
// Main
// ---------------------------------------------------------

function main() {
  console.log("[generate] 🚀 Starting code generation...");

  const [, , specPath, outDirArg] = process.argv;
  console.log(`[generate] 📂 Spec path: ${specPath}`);
  console.log(`[generate] 📂 Output directory: ${outDirArg}`);

  if (!specPath || !outDirArg) {
    console.error(
      "Usage: ts-node generate-gym24-client.ts <openapi.json> <outputDir>"
    );
    process.exit(1);
  }

  console.log("[generate] 📖 Reading OpenAPI spec file...");
  let raw: string;
  try {
    raw = fs.readFileSync(specPath, "utf8");
    console.log(
      `[generate] ✅ Spec file read successfully (${raw.length} bytes)`
    );
  } catch (err) {
    console.error("[generate] ❌ Failed to read spec file:", err);
    throw err;
  }

  console.log("[generate] 🔄 Parsing JSON...");
  let spec: OpenAPISpec;
  try {
    spec = JSON.parse(raw);
    console.log("[generate] ✅ JSON parsed successfully");
  } catch (err) {
    console.error("[generate] ❌ Failed to parse JSON:", err);
    throw err;
  }

  console.log("[generate] 📊 Collecting operations from spec...");
  let operations: OperationMeta[];
  try {
    operations = collectOperations(spec);
    console.log(`[generate] ✅ Found ${operations.length} operations`);
    operations.forEach((op, i) => {
      console.log(
        `[generate]    ${i + 1}. ${op.method.toUpperCase()} ${op.path} → ${
          op.operationName
        }`
      );
    });
  } catch (err) {
    console.error("[generate] ❌ Failed to collect operations:", err);
    throw err;
  }

  const outDir = path.resolve(outDirArg);
  console.log(`[generate] 📁 Resolved output directory: ${outDir}`);

  if (!fs.existsSync(outDir)) {
    console.log("[generate] 📁 Creating output directory...");
    fs.mkdirSync(outDir, { recursive: true });
    console.log("[generate] ✅ Output directory created");
  } else {
    console.log("[generate] ✅ Output directory already exists");
  }

  console.log("[generate] 🔨 Generating types.ts...");
  let typesContent: string;
  try {
    typesContent = generateTypes(spec, operations);
    console.log(
      `[generate] ✅ types.ts generated (${typesContent.length} bytes)`
    );
  } catch (err) {
    console.error("[generate] ❌ Failed to generate types.ts:", err);
    throw err;
  }

  console.log("[generate] 🔨 Generating queries.ts...");
  let queriesContent: string;
  try {
    queriesContent = generateQueries(spec, operations);
    console.log(
      `[generate] ✅ queries.ts generated (${queriesContent.length} bytes)`
    );
  } catch (err) {
    console.error("[generate] ❌ Failed to generate queries.ts:", err);
    throw err;
  }

  console.log("[generate] 🔨 Generating hooks.ts...");
  let hooksContent: string;
  try {
    hooksContent = generateHooks(spec, operations);
    console.log(
      `[generate] ✅ hooks.ts generated (${hooksContent.length} bytes)`
    );
  } catch (err) {
    console.error("[generate] ❌ Failed to generate hooks.ts:", err);
    throw err;
  }

  console.log("[generate] 💾 Writing output files...");

  try {
    const typesPath = path.join(outDir, "types.ts");
    fs.writeFileSync(typesPath, typesContent, "utf8");
    console.log(`[generate] ✅ Written: ${typesPath}`);
  } catch (err) {
    console.error("[generate] ❌ Failed to write types.ts:", err);
    throw err;
  }

  try {
    const queriesPath = path.join(outDir, "queries.ts");
    fs.writeFileSync(queriesPath, queriesContent, "utf8");
    console.log(`[generate] ✅ Written: ${queriesPath}`);
  } catch (err) {
    console.error("[generate] ❌ Failed to write queries.ts:", err);
    throw err;
  }

  try {
    const hooksPath = path.join(outDir, "hooks.ts");
    fs.writeFileSync(hooksPath, hooksContent, "utf8");
    console.log(`[generate] ✅ Written: ${hooksPath}`);
  } catch (err) {
    console.error("[generate] ❌ Failed to write hooks.ts:", err);
    throw err;
  }

  console.log("[generate] 🎉 Code generation completed successfully!");
}

main();
