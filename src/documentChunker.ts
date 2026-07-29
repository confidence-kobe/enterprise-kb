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
 * Split documents on paragraph and heading boundaries while carrying section context
 * into subsequent chunks. Line numbers are zero-based to match the existing Read tool.
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
