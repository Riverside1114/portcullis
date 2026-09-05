// Pattern matching for policy rules. Three forms:
//
//   src/**/*.ts   glob, the default
//   re:^abc$      regex, optionally re:/abc/i to pass flags
//   !pattern      negated, applied to either of the above
//
// Globs use path semantics: * stops at a separator, ** crosses them.
//
// Regexes are marked with a prefix rather than slash delimiters because policy
// patterns are usually absolute paths, and /home/me/** would otherwise be read
// as a regex with nonsense flags.

export interface Pattern {
  readonly source: string;
  readonly negated: boolean;
  test(value: string): boolean;
}

export class PatternError extends Error {
  constructor(source: string, detail: string) {
    super(`invalid pattern ${JSON.stringify(source)}: ${detail}`);
    this.name = "PatternError";
  }
}

export function compilePattern(source: string): Pattern {
  const negated = source.startsWith("!");
  const body = negated ? source.slice(1) : source;

  const regex = body.startsWith(REGEX_PREFIX)
    ? parseRegex(source, body.slice(REGEX_PREFIX.length))
    : globToRegExp(source, body);

  return {
    source,
    negated,
    test: (value) => regex.test(value) !== negated,
  };
}

export function compilePatterns(sources: readonly string[]): Pattern[] {
  return sources.map(compilePattern);
}

/** True when every negated pattern passes and at least one positive one matches. */
export function matchesAny(patterns: readonly Pattern[], value: string): boolean {
  const positives = patterns.filter((p) => !p.negated);
  const negatives = patterns.filter((p) => p.negated);

  if (negatives.some((p) => !p.test(value))) return false;
  if (positives.length === 0) return true;
  return positives.some((p) => p.test(value));
}

const REGEX_PREFIX = "re:";

function parseRegex(source: string, body: string): RegExp {
  let pattern = body;
  let flags = "";

  // re:/abc/i carries flags; re:abc is the bare form.
  const delimited = /^\/(.*)\/([a-z]*)$/s.exec(body);
  if (delimited) {
    pattern = delimited[1] as string;
    flags = delimited[2] as string;
    if (!/^[imsu]*$/.test(flags)) {
      throw new PatternError(source, `unsupported regex flags ${JSON.stringify(flags)}`);
    }
  }

  if (pattern === "") throw new PatternError(source, "regex is empty");

  try {
    return new RegExp(pattern, flags);
  } catch (cause) {
    throw new PatternError(source, (cause as Error).message);
  }
}

function globToRegExp(source: string, glob: string): RegExp {
  let out = "";
  let index = 0;
  const braces: number[] = [];

  while (index < glob.length) {
    const char = glob[index] as string;

    switch (char) {
      case "*": {
        if (glob[index + 1] === "*") {
          index += 2;
          // Consume the separator after ** so that a/**/b also matches a/b.
          if (glob[index] === "/") {
            index += 1;
            out += "(?:.*/)?";
          } else {
            out += ".*";
          }
          continue;
        }
        out += "[^/]*";
        index += 1;
        continue;
      }

      case "?": {
        out += "[^/]";
        index += 1;
        continue;
      }

      case "[": {
        const close = glob.indexOf("]", index + 1);
        if (close === -1) throw new PatternError(source, "character class is not closed");
        let body = glob.slice(index + 1, close);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        out += `[${body.replace(/\\/g, "\\\\")}]`;
        index = close + 1;
        continue;
      }

      case "{": {
        braces.push(index);
        out += "(?:";
        index += 1;
        continue;
      }

      case "}": {
        if (braces.length === 0) throw new PatternError(source, "unmatched closing brace");
        braces.pop();
        out += ")";
        index += 1;
        continue;
      }

      case ",": {
        out += braces.length > 0 ? "|" : ",";
        index += 1;
        continue;
      }

      default: {
        out += escapeLiteral(char);
        index += 1;
      }
    }
  }

  if (braces.length > 0) throw new PatternError(source, "unmatched opening brace");

  return new RegExp(`^${out}$`);
}

function escapeLiteral(char: string): string {
  return /[.+^$(){}|[\]\\]/.test(char) ? `\\${char}` : char;
}
