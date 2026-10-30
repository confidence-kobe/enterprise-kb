/**
 * 文档分块：把一篇文档切成适合检索的小段。
 *
 * 为什么要切：整篇放进全文索引，检索只能告诉你"这篇文档里有"，定位不到具体段落，
 * 大模型也得把整篇读进来。切成段之后，检索结果能精确到行号，回答也能标出处。
 *
 * 怎么切：在 Markdown 标题、中文章节标题（第一章、第二节等）和编号标题（1.2、1.2.3 等）处断开，每段最多约 1200 字，
 * 过长再细分并保留两行重叠。每段都带上所属标题，单看一段也知道它在讲哪一章。
 */

export interface DocumentChunk {
  content: string
  startLine: number
  endLine: number
  heading: string | null
}

interface LineEntry {
  text: string
  line: number
}

const MARKDOWN_HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/
const SECTION_HEADING = /^\s*(?:第[一二三四五六七八九十百千万0-9]+[章节篇部分]|[0-9]+(?:\.[0-9]+){1,3})[\s、.．:：-]+(.+)$/

function headingText(line: string): string | null {
  return line.match(MARKDOWN_HEADING)?.[1]?.trim()
    ?? line.match(SECTION_HEADING)?.[1]?.trim()
    ?? null
}

function renderChunk(entries: LineEntry[], heading: string | null): DocumentChunk | null {
  if (!entries.length) return null
  if (!entries.some(entry => entry.text.trim() && !headingText(entry.text))) return null
  const body = entries.map(entry => entry.text).join('\n').trim()
  if (body.length < 10) return null

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
 * 按段落和标题边界切分文档，并把所在章节的标题带到后续分块里。
 * 行号从 0 开始，与 Read 工具一致。
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

  const flushCurrent = () => {
    const chunk = renderChunk(current, currentHeading)
    if (chunk) chunks.push(chunk)
    current = current.slice(-overlapLines)
  }

  const appendParagraph = (entries: LineEntry[]) => {
    const expanded = entries.flatMap(entry => {
      const budget = Math.max(200, maxChars - (currentHeading?.length ?? 0) - 4)
      if (entry.text.length <= budget) return [entry]
      const parts: LineEntry[] = []
      for (let offset = 0; offset < entry.text.length; offset += budget) {
        parts.push({ text: entry.text.slice(offset, offset + budget), line: entry.line })
      }
      return parts
    })

    for (const entry of expanded) {
      const headingPrefixLength = currentHeading ? currentHeading.length + 4 : 0
      const currentLength = current.reduce((sum, item) => sum + item.text.length + 1, headingPrefixLength)
      if (current.length && currentLength + entry.text.length + 1 > maxChars) {
        flushCurrent()
        const overlapLength = current.reduce((sum, item) => sum + item.text.length + 1, headingPrefixLength)
        if (overlapLength + entry.text.length + 1 > maxChars) current = []
      }
      current.push(entry)
    }
  }

  const flushParagraph = () => {
    appendParagraph(paragraph)
    paragraph = []
  }

  for (let line = 0; line < lines.length; line++) {
    const textLine = lines[line]
    const heading = headingText(textLine)

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

    if (!textLine.trim()) {
      flushParagraph()
      continue
    }

    paragraph.push({ text: textLine, line })
  }

  flushParagraph()
  const finalChunk = renderChunk(current, currentHeading)
  if (finalChunk) chunks.push(finalChunk)
  return chunks
}
