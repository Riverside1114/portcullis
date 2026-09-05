// A deliberately small YAML subset, enough for policy files and nothing more.
//
// Supported: block maps, block sequences, nested combinations, inline
// sequences, single and double quoted strings, numbers, booleans, null, and
// comments. Not supported: anchors, aliases, tags, multiple documents, block
// scalars, flow maps, and complex keys. Anything unsupported is a parse error
// naming the line, never a silent misreading.
//
// The core ships with no runtime dependencies, and for a tool whose subject is
// supply chain risk that is worth more than full YAML coverage. Policies can
// also be written as JSON, which needs no parser at all.

export type YamlValue = string | number | boolean | null | YamlValue[] | YamlMap;

export interface YamlMap {
  [key: string]: YamlValue;
}

export class YamlError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`);
    this.name = "YamlError";
    this.line = line;
  }
}

interface SourceLine {
  indent: number;
  text: string;
  number: number;
}

export function parseYaml(source: string): YamlValue {
  const lines = readLines(source);
  if (lines.length === 0) return null;

  const [value, next] = parseNode(lines, 0, lines[0]?.indent ?? 0);
  if (next < lines.length) {
    const line = lines[next] as SourceLine;
    throw new YamlError(`unexpected indentation, expected ${lines[0]?.indent ?? 0}`, line.number);
  }
  return value;
}

function readLines(source: string): SourceLine[] {
  const out: SourceLine[] = [];

  source.split(/\r?\n/).forEach((raw, index) => {
    const number = index + 1;

    if (raw.includes("\t") && /^\s*\t/.test(raw)) {
      throw new YamlError("tabs cannot be used for indentation", number);
    }

    const withoutComment = stripComment(raw);
    if (withoutComment.trim() === "") return;

    if (withoutComment.trim() === "---") {
      throw new YamlError("multiple documents are not supported", number);
    }

    out.push({
      indent: withoutComment.length - withoutComment.trimStart().length,
      text: withoutComment.trim(),
      number,
    });
  });

  return out;
}

function stripComment(raw: string): string {
  let quote: string | null = null;

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];

    if (quote) {
      if (char === "\\" && quote === '"') i += 1;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    // Only a # at the start or after whitespace begins a comment, so that
    // values such as an anchor in a URL survive.
    if (char === "#" && (i === 0 || /\s/.test(raw[i - 1] as string))) {
      return raw.slice(0, i);
    }
  }

  return raw;
}

function parseNode(lines: SourceLine[], start: number, indent: number): [YamlValue, number] {
  const line = lines[start];
  if (!line) return [null, start];

  return line.text.startsWith("-") && (line.text.length === 1 || line.text[1] === " ")
    ? parseSequence(lines, start, indent)
    : parseMap(lines, start, indent);
}

function parseSequence(lines: SourceLine[], start: number, indent: number): [YamlValue[], number] {
  const items: YamlValue[] = [];
  let index = start;

  while (index < lines.length) {
    const line = lines[index] as SourceLine;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new YamlError("unexpected indentation inside a list", line.number);
    }
    if (!line.text.startsWith("-")) break;

    const rest = line.text.slice(1).trim();
    const childIndent = indent + 2;

    if (rest === "") {
      const next = lines[index + 1];
      if (!next || next.indent <= indent) {
        items.push(null);
        index += 1;
        continue;
      }
      const [value, after] = parseNode(lines, index + 1, next.indent);
      items.push(value);
      index = after;
      continue;
    }

    // A list item that is itself a map, such as "- name: x" followed by more
    // keys aligned under it. Re-present the inline part at the child indent so
    // the map parser sees one continuous block.
    if (isMapEntry(rest)) {
      const rewritten: SourceLine[] = [
        { indent: childIndent, text: rest, number: line.number },
        ...lines.slice(index + 1),
      ];
      const [value, after] = parseMap(rewritten, 0, childIndent);
      items.push(value);
      index = index + after;
      continue;
    }

    items.push(parseScalar(rest, line.number));
    index += 1;
  }

  return [items, index];
}

function parseMap(lines: SourceLine[], start: number, indent: number): [YamlMap, number] {
  const map: YamlMap = {};
  let index = start;

  while (index < lines.length) {
    const line = lines[index] as SourceLine;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new YamlError("unexpected indentation", line.number);
    }
    if (line.text.startsWith("- ")) break;

    const split = splitKey(line.text);
    if (!split) {
      throw new YamlError(`expected "key: value", found ${JSON.stringify(line.text)}`, line.number);
    }

    const { key, rest } = split;
    if (key in map) {
      throw new YamlError(`duplicate key ${JSON.stringify(key)}`, line.number);
    }

    if (rest !== "") {
      map[key] = parseScalar(rest, line.number);
      index += 1;
      continue;
    }

    const next = lines[index + 1];
    if (!next || next.indent <= indent) {
      map[key] = null;
      index += 1;
      continue;
    }

    const [value, after] = parseNode(lines, index + 1, next.indent);
    map[key] = value;
    index = after;
  }

  return [map, index];
}

function isMapEntry(text: string): boolean {
  return splitKey(text) !== null;
}

function splitKey(text: string): { key: string; rest: string } | null {
  let quote: string | null = null;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quote) {
      if (char === "\\" && quote === '"') i += 1;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === ":" && (i + 1 === text.length || /\s/.test(text[i + 1] as string))) {
      const key = text.slice(0, i).trim();
      if (key === "") return null;
      return { key: unquote(key), rest: text.slice(i + 1).trim() };
    }
  }

  return null;
}

function unquote(text: string): string {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return unescapeDouble(text.slice(1, -1));
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

function parseScalar(text: string, line: number): YamlValue {
  if (text.startsWith("{")) {
    throw new YamlError("inline maps are not supported, use an indented block", line);
  }
  if (text.startsWith("&") || text.startsWith("*")) {
    throw new YamlError("anchors and aliases are not supported", line);
  }
  if (text === "|" || text === ">" || text.startsWith("|") || text.startsWith(">")) {
    throw new YamlError("block scalars are not supported", line);
  }

  if (text.startsWith("[")) {
    if (!text.endsWith("]")) throw new YamlError("inline list is not closed", line);
    return splitFlow(text.slice(1, -1), line).map((item) => parseScalar(item, line));
  }

  if (text.startsWith('"') || text.startsWith("'")) return unquote(text);

  if (text === "null" || text === "~") return null;
  if (text === "true" || text === "yes" || text === "on") return true;
  if (text === "false" || text === "no" || text === "off") return false;

  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d+\.\d+$/.test(text)) return Number.parseFloat(text);

  return text;
}

function splitFlow(text: string, line: number): string[] {
  if (text.trim() === "") return [];

  const items: string[] = [];
  let current = "";
  let quote: string | null = null;
  let depth = 0;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;

    if (quote) {
      current += char;
      if (char === "\\" && quote === '"') {
        current += text[i + 1] ?? "";
        i += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === "[") depth += 1;
    if (char === "]") depth -= 1;

    if (char === "," && depth === 0) {
      items.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (quote) throw new YamlError("unterminated quoted string", line);
  if (current.trim() !== "") items.push(current.trim());
  return items;
}

function unescapeDouble(text: string): string {
  return text.replace(/\\(.)/g, (_, char: string) => {
    switch (char) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "0":
        return "\0";
      default:
        return char;
    }
  });
}
