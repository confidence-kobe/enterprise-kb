/**
 * 核心类型定义
 * 精简自 claude-code 的 Tool.ts / types/permissions.ts / types/message.ts
 */
// ─────────────────────────────────────────────
// 工具的 Anthropic API Schema 转换
// ─────────────────────────────────────────────
export function toolToAnthropicSchema(tool) {
    return {
        name: tool.name,
        description: tool.description,
        input_schema: zodToJsonSchema(tool.inputSchema),
    };
}
/**
 * 将 Zod schema 转换为 JSON Schema（简化版，覆盖常用类型）
 */
export function zodToJsonSchema(schema) {
    return extractJsonSchema(schema);
}
function extractJsonSchema(schema) {
    const def = schema._def;
    // ZodObject
    if (def.typeName === 'ZodObject') {
        const shape = def.shape();
        const properties = {};
        const required = [];
        for (const [key, value] of Object.entries(shape)) {
            const fieldSchema = value;
            const fieldDef = fieldSchema._def;
            // 判断是否必填（非 optional/default）
            const isOptional = fieldDef.typeName === 'ZodOptional' ||
                fieldDef.typeName === 'ZodDefault';
            if (!isOptional)
                required.push(key);
            properties[key] = extractJsonSchema(isOptional ? fieldDef.innerType ?? fieldDef.schema ?? fieldSchema : fieldSchema);
            // 添加 description
            const desc = fieldSchema.description ?? (isOptional ? (fieldDef.innerType ?? fieldSchema).description : undefined);
            if (desc) {
                properties[key].description = desc;
            }
        }
        return {
            type: 'object',
            properties,
            ...(required.length > 0 ? { required } : {}),
        };
    }
    // ZodString
    if (def.typeName === 'ZodString') {
        const result = { type: 'string' };
        if (schema.description)
            result.description = schema.description;
        return result;
    }
    // ZodNumber
    if (def.typeName === 'ZodNumber') {
        return { type: 'number' };
    }
    // ZodBoolean
    if (def.typeName === 'ZodBoolean') {
        return { type: 'boolean' };
    }
    // ZodArray
    if (def.typeName === 'ZodArray') {
        return {
            type: 'array',
            items: extractJsonSchema(def.type),
        };
    }
    // ZodEnum
    if (def.typeName === 'ZodEnum') {
        return { type: 'string', enum: def.values };
    }
    // ZodOptional / ZodNullable
    if (def.typeName === 'ZodOptional' || def.typeName === 'ZodNullable') {
        return extractJsonSchema(def.innerType);
    }
    // ZodDefault
    if (def.typeName === 'ZodDefault') {
        const inner = extractJsonSchema(def.innerType ?? def.schema);
        return { ...inner, default: def.defaultValue?.() };
    }
    // ZodUnion
    if (def.typeName === 'ZodUnion') {
        return { oneOf: def.options.map(extractJsonSchema) };
    }
    // fallback
    return { type: 'string' };
}
//# sourceMappingURL=types.js.map