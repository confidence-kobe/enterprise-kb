/**
 * 文档智能分块切分模块 (Document Chunker)
 *
 * 核心设计目标：
 * 1. 结构化切分：基于段落自然空行、Markdown 标题（# ~ ######）及中文/数字章节编号（如"第一章"、"1.2.3"）进行语义切分；
 * 2. 上下文透传：自动捕获当前块所属的章节标题，并将其以 Markdown 一级标题形式注入切片头部，避免分块脱离上下文导致检索失真；
 * 3. 精确行号映射：输出从 0 开始的原始文本物理行号（startLine ~ endLine），与后续的 `Read` 工具参数完全无缝对齐；
 * 4. 滑动窗口与超长行防护：支持跨分块重叠行 (overlapLines) 以保留上下文连续性，同时对无换行的超长单行进行安全截断。
 */

/**
 * 文档切分片段 (Chunk) 结构定义
 */
export interface DocumentChunk {
  /** 格式化后的分块文本内容（包含章节标题前缀，供向量化及全文检索使用） */
  content: string
  /** 该分块在原文档中的起始行号（0-based，与 Read 工具行号对应） */
  startLine: number
  /** 该分块在原文档中的结束行号（0-based，含该行） */
  endLine: number
  /** 所属章节/段落标题名称（若未识别出标题则为 null） */
  heading: string | null
}

/**
 * 内部行条目结构，记录单行文本及其原始行号
 */
interface LineEntry {
  /** 行文本内容 */
  text: string
  /** 物理行号 (0-based) */
  line: number
}

/** 正则：匹配 Markdown 标准标题（如 "# 标题", "### 子标题"） */
const MARKDOWN_HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/
/** 正则：匹配中文书籍/论文/公文章节格式（如 "第一章 概述", "2.1.3 安装部署"） */
const SECTION_HEADING = /^\s*(?:第[一二三四五六七八九十百千万0-9]+[章节篇部分]|[0-9]+(?:\.[0-9]+){1,3})[\s、.．:：-]+(.+)$/

/**
 * 解析并提取单行文本中的章节标题内容
 *
 * @param line 单行原始文本
 * @returns 提取出的标题文本；若不是标题行则返回 null
 */
function headingText(line: string): string | null {
  return line.match(MARKDOWN_HEADING)?.[1]?.trim()
    ?? line.match(SECTION_HEADING)?.[1]?.trim()
    ?? null
}

/**
 * 将一组行条目渲染组装为标准 DocumentChunk
 *
 * 处理逻辑：
 * 1. 过滤空行，若有效文本小于 10 个字符或仅包含标题则跳过（避免生成无意义碎片）；
 * 2. 若识别出了外部所属标题，且内容本身未显式包含该标题，则在头部注入 `# 标题\n\n` 补充语义。
 *
 * @param entries 行条目数组
 * @param heading 当前归属的标题名称
 * @returns 组装好的分块对象，不符合有效切片要求时返回 null
 */
function renderChunk(entries: LineEntry[], heading: string | null): DocumentChunk | null {
  if (!entries.length) return null
  // 必须包含非空且非纯标题行的实质性文本
  if (!entries.some(entry => entry.text.trim() && !headingText(entry.text))) return null
  const body = entries.map(entry => entry.text).join('\n').trim()
  if (body.length < 10) return null

  // 避免重复追加已存在的标题
  const alreadyContainsHeading = heading
    && entries.some(entry => headingText(entry.text) === heading)
  const content = heading && !alreadyContainsHeading
    ? `# ${heading}\n\n${body}`
    : body

  return {
    content,
    startLine: entries[0].line,
    endLine: entries[entries.length - 1].line,
    heading,
  }
}

/**
 * 文档语义分块函数 (chunkDocument)
 *
 * 切分算法：
 * 1. 标准化换行符 (\r\n -> \n) 并逐行扫描；
 * 2. 遇到新标题行时，立即 flush 先前段落并开启新的分块上下文，更新当前所属标题；
 * 3. 遇到连续空行时，结束当前自然段落，尝试将段落追加至当前切片；
 * 4. 当切片字符数累积达到 `maxChars` 时，输出切片并保留末尾 `overlapLines` 行作为下一个切片的重叠前缀；
 * 5. 针对单行字符极长（超出字符预算）的场景，进行分段拆分以防止内存溢出或超长 token。
 *
 * @param text 待切分的完整纯文本内容
 * @param maxChars 单个切片的最大字符数预算，默认 1,200 字符（约合 500~800 中文字符/Token）
 * @param overlapLines 相邻切片之间的重叠行数，默认 2 行，保证语义上下文连续不断层
 * @returns 切分后的 DocumentChunk 数组
 */
export function chunkDocument(
  text: string,
  maxChars = 1_200,
  overlapLines = 2,
): DocumentChunk[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const chunks: DocumentChunk[] = []
  let current: LineEntry[] = []
  let currentHeading: string | null = null
  let paragraph: LineEntry[] = []

  /** 输出当前累积切片，并根据 overlapLines 裁剪保留重叠部分 */
  const flushCurrent = () => {
    const chunk = renderChunk(current, currentHeading)
    if (chunk) chunks.push(chunk)
    current = current.slice(-overlapLines)
  }

  /** 将收集到的段落追加到当前分块中，超长行在此进行等额分段拆分 */
  const appendParagraph = (entries: LineEntry[]) => {
    const expanded = entries.flatMap(entry => {
      const budget = Math.max(200, maxChars - (currentHeading?.length ?? 0) - 4)
      if (entry.text.length <= budget) return [entry]
      // 超长行分片切割
      const parts: LineEntry[] = []
      for (let offset = 0; offset < entry.text.length; offset += budget) {
        parts.push({ text: entry.text.slice(offset, offset + budget), line: entry.line })
      }
      return parts
    })

    for (const entry of expanded) {
      const headingPrefixLength = currentHeading ? currentHeading.length + 4 : 0
      const currentLength = current.reduce((sum, item) => sum + item.text.length + 1, headingPrefixLength)
      // 若加入该行后超出最大字符预算，先提交当前切片
      if (current.length && currentLength + entry.text.length + 1 > maxChars) {
        flushCurrent()
        const overlapLength = current.reduce((sum, item) => sum + item.text.length + 1, headingPrefixLength)
        if (overlapLength + entry.text.length + 1 > maxChars) current = []
      }
      current.push(entry)
    }
  }

  /** 段落结束（遇到空行或新标题时），将当前段落行全部灌入分块流程 */
  const flushParagraph = () => {
    appendParagraph(paragraph)
    paragraph = []
  }

  // 逐行扫描文档
  for (let line = 0; line < lines.length; line++) {
    const textLine = lines[line]
    const heading = headingText(textLine)

    // 遇到新标题行：先提交之前的内容，再重设上下文标题
    if (heading) {
      flushParagraph()
      if (current.length) {
        const chunk = renderChunk(current, currentHeading)
        if (chunk) chunks.push(chunk)
        current = []
      }
      currentHeading = heading
      current.push({ text: textLine, line })
      continue
    }

    // 遇到自然空行：提交当前段落
    if (!textLine.trim()) {
      flushParagraph()
      continue
    }

    // 普通正文行，追加至当前段落
    paragraph.push({ text: textLine, line })
  }

  // 处理文档末尾残留的段落与分块
  flushParagraph()
  const finalChunk = renderChunk(current, currentHeading)
  if (finalChunk) chunks.push(finalChunk)
  return chunks
}
