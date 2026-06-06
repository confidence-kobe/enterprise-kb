/**
 * 所有内置工具的统一导出
 */
export { BashTool } from './bash.js';
export { FileReadTool } from './read.js';
export { FileWriteTool } from './write.js';
export { FileEditTool } from './edit.js';
export { GlobTool } from './glob.js';
export { GrepTool } from './grep.js';
export { WebFetchTool } from './webfetch.js';
export type { BashInput, BashOutput } from './bash.js';
export type { ReadInput, ReadOutput } from './read.js';
export type { WriteInput, WriteOutput } from './write.js';
export type { EditInput, EditOutput } from './edit.js';
export type { GlobInput, GlobOutput } from './glob.js';
export type { GrepInput, GrepOutput } from './grep.js';
export type { WebFetchInput, WebFetchOutput } from './webfetch.js';
import type { Tool } from '../types.js';
/** 所有内置工具的集合，可直接传给 ClaudeExecutor */
export declare const ALL_TOOLS: Tool[];
/** 只读工具集合（适合 plan 模式） */
export declare const READ_ONLY_TOOLS: Tool[];
//# sourceMappingURL=index.d.ts.map