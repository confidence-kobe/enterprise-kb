/**
 * 路径工具函数
 */
import * as path from 'node:path';
/**
 * 检查给定路径是否在允许范围内
 * @param filePath  目标路径（绝对路径）
 * @param cwd       当前工作目录
 * @param extra     额外允许的目录列表
 */
export function isPathAllowed(filePath, cwd, extra) {
    const resolved = path.resolve(filePath);
    const cwdResolved = path.resolve(cwd);
    if (resolved.startsWith(cwdResolved + path.sep) || resolved === cwdResolved) {
        return true;
    }
    if (extra) {
        for (const dir of extra) {
            const d = path.resolve(dir);
            if (resolved.startsWith(d + path.sep) || resolved === d)
                return true;
        }
    }
    return false;
}
//# sourceMappingURL=path.js.map