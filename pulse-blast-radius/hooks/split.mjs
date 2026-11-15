// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
// Modified by MrValraven for pulse-mods: this file is new in 0.3.0.
//
// Reads a shell command line the way the shell splits it, well enough to find
// the commands in it. Pure functions with no `$`, so tests import them as is.
//
// splitCommand: splits on ; && || | & and newlines outside quotes and escapes,
//   and hands back the commands that run inside $( ), backticks, <( ), >( )
//   and here-documents, so the classifier can read them as commands too.
// tokenize: splits one simple command into words and redirects, honouring
//   quotes and escapes.

/**
 * Splits a command line into its simple commands.
 *
 * @returns {{
 *   segments: { text: string, separatorBefore: string | null }[],
 *   substitutions: { script: string, segmentIndex: number, via: string }[],
 *   heredocs: { script: string, segmentIndex: number, delimiter: string }[],
 *   isUnbalanced: boolean,
 * }}
 */
export function splitCommand(command) {
  const text = String(command ?? "");
  const segments = [];
  const substitutions = [];
  const heredocs = [];
  const pendingHeredocs = [];
  let current = "";
  let separatorBefore = null;
  let quote = null; // "'", '"' or "$'"
  let isUnbalanced = false;

  const pushSegment = (separator) => {
    const trimmed = current.trim();
    if (trimmed !== "") {
      segments.push({ text: trimmed, separatorBefore });
    }
    current = "";
    separatorBefore = separator;
  };
  const recordSubstitution = (script, via) => {
    substitutions.push({ script, segmentIndex: segments.length, via });
  };

  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (quote === "'") {
      current += char;
      if (char === "'") {
        quote = null;
      }
      index += 1;
      continue;
    }
    if (quote === "$'") {
      if (char === "\\" && nextChar !== undefined) {
        current += char + nextChar;
        index += 2;
        continue;
      }
      current += char;
      if (char === "'") {
        quote = null;
      }
      index += 1;
      continue;
    }
    if (quote === '"') {
      if (char === "\\" && nextChar !== undefined) {
        current += char + nextChar;
        index += 2;
        continue;
      }
      if (char === '"') {
        quote = null;
        current += char;
        index += 1;
        continue;
      }
      if (char === "$" && nextChar === "(") {
        const read = readBalanced(text, index + 2);
        current += text.slice(index, read.end);
        recordSubstitution(read.inner, "$( )");
        isUnbalanced = isUnbalanced || !read.isClosed;
        index = read.end;
        continue;
      }
      if (char === "$" && nextChar === "{") {
        const end = readBrace(text, index + 2);
        current += text.slice(index, end);
        index = end;
        continue;
      }
      if (char === "`") {
        const read = readBacktick(text, index + 1);
        current += text.slice(index, read.end);
        recordSubstitution(read.inner, "backticks");
        isUnbalanced = isUnbalanced || !read.isClosed;
        index = read.end;
        continue;
      }
      current += char;
      index += 1;
      continue;
    }

    // Outside quotes.
    if (char === "\\") {
      if (nextChar === "\n") {
        current += " "; // a line continuation joins the two lines
        index += 2;
        continue;
      }
      current += nextChar === undefined ? char : char + nextChar;
      index += nextChar === undefined ? 1 : 2;
      continue;
    }
    if (char === "'") {
      quote = "'";
      current += char;
      index += 1;
      continue;
    }
    if (char === "$" && nextChar === "'") {
      quote = "$'";
      current += "$'";
      index += 2;
      continue;
    }
    if (char === '"') {
      quote = '"';
      current += char;
      index += 1;
      continue;
    }
    if (char === "$" && nextChar === "(") {
      const read = readBalanced(text, index + 2);
      current += text.slice(index, read.end);
      recordSubstitution(read.inner, "$( )");
      isUnbalanced = isUnbalanced || !read.isClosed;
      index = read.end;
      continue;
    }
    if (char === "$" && nextChar === "{") {
      const end = readBrace(text, index + 2);
      current += text.slice(index, end);
      index = end;
      continue;
    }
    if (char === "`") {
      const read = readBacktick(text, index + 1);
      current += text.slice(index, read.end);
      recordSubstitution(read.inner, "backticks");
      isUnbalanced = isUnbalanced || !read.isClosed;
      index = read.end;
      continue;
    }
    if ((char === "<" || char === ">") && nextChar === "(") {
      const read = readBalanced(text, index + 2);
      current += text.slice(index, read.end);
      recordSubstitution(read.inner, `${char}( )`);
      isUnbalanced = isUnbalanced || !read.isClosed;
      index = read.end;
      continue;
    }
    // A comment runs to the end of its line and never runs, so its quotes and
    // separators are not read (an apostrophe in `# don't` opens no quote).
    // Only a # that starts a word after a space or a separator: zsh reads
    // `(#i)` as a glob flag, so a # right after ( stays part of the command.
    if (char === "#" && (index === 0 || /[\s;&|]/.test(text[index - 1]))) {
      const lineEnd = text.indexOf("\n", index);
      index = lineEnd === -1 ? text.length : lineEnd;
      continue;
    }
    if (char === "<" && nextChar === "<" && text[index + 2] !== "<") {
      const heredoc = readHeredocStart(text, index + 2);
      current += text.slice(index, heredoc.end);
      if (heredoc.delimiter !== "") {
        pendingHeredocs.push({ delimiter: heredoc.delimiter, shouldStripTabs: heredoc.shouldStripTabs, segmentIndex: segments.length });
      }
      index = heredoc.end;
      continue;
    }
    if (char === "\n") {
      pushSegment("\n");
      index += 1;
      if (pendingHeredocs.length > 0) {
        index = readHeredocBodies(text, index, pendingHeredocs, heredocs);
        pendingHeredocs.length = 0;
      }
      continue;
    }
    if (char === ";") {
      pushSegment(";");
      index += nextChar === ";" ? 2 : 1;
      continue;
    }
    if (char === "&" && nextChar === "&") {
      pushSegment("&&");
      index += 2;
      continue;
    }
    if (char === "|" && nextChar === "|") {
      pushSegment("||");
      index += 2;
      continue;
    }
    if (char === "|" && text[index - 1] === ">") {
      current += char; // `>|` writes over a file even with noclobber set
      index += 1;
      continue;
    }
    if (char === "|") {
      pushSegment("|");
      index += nextChar === "&" ? 2 : 1;
      continue;
    }
    if (char === "&") {
      // `2>&1`, `>&2`, `<&3` and `&>file` are redirects; a lone & ends a command.
      const previous = text[index - 1];
      if (previous === ">" || previous === "<" || nextChar === ">") {
        current += char;
        index += 1;
        continue;
      }
      pushSegment("&");
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  if (quote !== null) {
    isUnbalanced = true;
  }
  pushSegment(null);
  if (pendingHeredocs.length > 0) {
    // A here-document named on the last line with no body: nothing to read.
    pendingHeredocs.length = 0;
  }
  return { segments, substitutions, heredocs, isUnbalanced };
}

/**
 * Reads from just inside an opening `(` to its matching `)`, skipping quoted
 * text and here-document bodies (`$(cat <<'EOF' ... EOF)`, where an apostrophe
 * in the body opens no quote).
 */
function readBalanced(text, start) {
  let depth = 1;
  let cursor = start;
  let quote = null;
  let pendingHeredocs = [];
  while (cursor < text.length) {
    const char = text[cursor];
    if (quote === "'") {
      if (char === "'") {
        quote = null;
      }
      cursor += 1;
      continue;
    }
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      }
      cursor += 1;
      continue;
    }
    if (char === "<" && text[cursor + 1] === "<" && text[cursor + 2] !== "<") {
      const heredoc = readHeredocStart(text, cursor + 2);
      if (heredoc.delimiter !== "") {
        pendingHeredocs.push({ delimiter: heredoc.delimiter, shouldStripTabs: heredoc.shouldStripTabs, segmentIndex: 0 });
      }
      cursor = Math.max(heredoc.end, cursor + 2);
      continue;
    }
    if (char === "\n" && pendingHeredocs.length > 0) {
      cursor = readHeredocBodies(text, cursor + 1, pendingHeredocs, []);
      pendingHeredocs = [];
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return { inner: text.slice(start, cursor), end: cursor + 1, isClosed: true };
      }
    }
    cursor += 1;
  }
  return { inner: text.slice(start), end: text.length, isClosed: false };
}

/** Reads from just inside an opening backtick to the closing one. */
function readBacktick(text, start) {
  let cursor = start;
  let inner = "";
  while (cursor < text.length) {
    const char = text[cursor];
    if (char === "\\" && cursor + 1 < text.length) {
      inner += text[cursor + 1] === "`" ? "`" : char + text[cursor + 1];
      cursor += 2;
      continue;
    }
    if (char === "`") {
      return { inner, end: cursor + 1, isClosed: true };
    }
    inner += char;
    cursor += 1;
  }
  return { inner, end: text.length, isClosed: false };
}

/** Reads a `${...}` expansion from just inside its brace; returns the index after `}`. */
function readBrace(text, start) {
  const close = text.indexOf("}", start);
  return close === -1 ? text.length : close + 1;
}

/** Reads the delimiter after `<<` (or `<<-`). A quoted delimiter is unquoted here. */
function readHeredocStart(text, start) {
  let cursor = start;
  let shouldStripTabs = false;
  if (text[cursor] === "-") {
    shouldStripTabs = true;
    cursor += 1;
  }
  while (text[cursor] === " " || text[cursor] === "\t") {
    cursor += 1;
  }
  let delimiter = "";
  while (cursor < text.length && !/[\s;&|<>()]/.test(text[cursor])) {
    const char = text[cursor];
    if (char === "'" || char === '"') {
      const close = text.indexOf(char, cursor + 1);
      const end = close === -1 ? text.length : close;
      delimiter += text.slice(cursor + 1, end);
      cursor = end + 1;
      continue;
    }
    if (char === "\\" && cursor + 1 < text.length) {
      delimiter += text[cursor + 1];
      cursor += 2;
      continue;
    }
    delimiter += char;
    cursor += 1;
  }
  return { delimiter, shouldStripTabs, end: Math.min(cursor, text.length) };
}

/** Reads each pending here-document's body from `start`; returns where the command line goes on. */
function readHeredocBodies(text, start, pending, heredocs) {
  let cursor = start;
  for (const heredoc of pending) {
    const bodyLines = [];
    while (cursor < text.length) {
      const lineEnd = text.indexOf("\n", cursor);
      const line = text.slice(cursor, lineEnd === -1 ? text.length : lineEnd);
      cursor = lineEnd === -1 ? text.length : lineEnd + 1;
      const compared = heredoc.shouldStripTabs ? line.replace(/^\t+/, "") : line;
      if (compared === heredoc.delimiter) {
        break;
      }
      bodyLines.push(line);
    }
    heredocs.push({ script: bodyLines.join("\n"), segmentIndex: heredoc.segmentIndex, delimiter: heredoc.delimiter });
  }
  return cursor;
}

/**
 * The old splitter, kept for one job: when a quote never closes, the command
 * is also read this way, with every quote ignored, so nothing risky hides
 * behind a stray quote.
 */
export function naiveSplit(command) {
  return String(command ?? "")
    .split(/&&|\|\||;|\||\n/)
    .map((piece) => piece.replace(/["'`]/g, " ").trim())
    .filter((piece) => piece !== "");
}

const REDIRECT_OPERATORS = [">>", ">|", ">&", "<<<", "<<-", "<<", "<>", "<&", ">", "<"];

const ANSI_ESCAPES = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };

/**
 * Decodes one backslash escape inside $'...' the way bash does, so `$'\x72m'`
 * reads as rm: \n \t and the other letters, \NNN octal, \xHH, \uHHHH,
 * \UHHHHHHHH and \cX. An escape bash does not know keeps its backslash.
 * `source[start]` is the backslash; returns the text and the index after it.
 */
function readAnsiEscape(source, start) {
  const letter = source[start + 1];
  if (letter === undefined) {
    return { text: "\\", end: start + 1 };
  }
  if (Object.hasOwn(ANSI_ESCAPES, letter)) {
    return { text: ANSI_ESCAPES[letter], end: start + 2 };
  }
  const readDigits = (from, pattern, maxCount) => {
    let digits = "";
    while (digits.length < maxCount && from + digits.length < source.length && pattern.test(source[from + digits.length])) {
      digits += source[from + digits.length];
    }
    return digits;
  };
  if (/[0-7]/.test(letter)) {
    const digits = readDigits(start + 1, /[0-7]/, 3);
    return { text: String.fromCharCode(parseInt(digits, 8) & 0xff), end: start + 1 + digits.length };
  }
  const hexCounts = { x: 2, u: 4, U: 8 };
  if (Object.hasOwn(hexCounts, letter)) {
    const digits = readDigits(start + 2, /[0-9a-fA-F]/, hexCounts[letter]);
    const codePoint = parseInt(digits, 16);
    if (digits === "" || codePoint > 0x10ffff) {
      return { text: `\\${letter}${digits}`, end: start + 2 + digits.length };
    }
    return { text: letter === "x" ? String.fromCharCode(codePoint) : String.fromCodePoint(codePoint), end: start + 2 + digits.length };
  }
  if (letter === "c" && start + 2 < source.length && source[start + 2] !== "'") {
    const control = source[start + 2];
    return { text: String.fromCharCode(control === "?" ? 0x7f : control.toUpperCase().charCodeAt(0) & 0x1f), end: start + 3 };
  }
  return { text: `\\${letter}`, end: start + 2 };
}

/**
 * Splits one simple command into words and redirects.
 *
 * A word is `{ value, raw, isQuoted, hasExpansion }`: `value` with quotes and
 * escapes removed, `raw` as written, `hasExpansion` when it holds `$` or a
 * backtick that only the shell can expand. A redirect is
 * `{ operator, fd, target }`, such as `{ operator: ">", fd: "2", target: "log" }`.
 */
export function tokenize(text) {
  const source = String(text ?? "");
  const words = [];
  const redirects = [];
  let word = null;
  let pendingRedirect = null;

  const ensureWord = () => {
    if (word === null) {
      word = { value: "", raw: "", isQuoted: false, hasExpansion: false };
    }
    return word;
  };
  const finishWord = () => {
    if (word === null) {
      return;
    }
    if (pendingRedirect !== null) {
      redirects.push({ ...pendingRedirect, target: word.value, hasExpansion: word.hasExpansion });
      pendingRedirect = null;
    } else {
      words.push(word);
    }
    word = null;
  };

  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const nextChar = source[index + 1];
    if (/\s/.test(char)) {
      finishWord();
      index += 1;
      continue;
    }
    if (char === "\\") {
      const current = ensureWord();
      if (nextChar !== undefined) {
        current.value += nextChar;
        current.raw += char + nextChar;
        current.isQuoted = true;
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (char === "'") {
      const current = ensureWord();
      const close = source.indexOf("'", index + 1);
      const end = close === -1 ? source.length : close;
      current.value += source.slice(index + 1, end);
      current.raw += source.slice(index, end + 1);
      current.isQuoted = true;
      index = end + 1;
      continue;
    }
    if (char === "$" && nextChar === "'") {
      const current = ensureWord();
      let cursor = index + 2;
      let hasEnded = false; // bash ends the string at a NUL: $'rm\0x' is rm
      while (cursor < source.length && source[cursor] !== "'") {
        const escape = source[cursor] === "\\" && cursor + 1 < source.length ? readAnsiEscape(source, cursor) : null;
        const decoded = escape === null ? source[cursor] : escape.text;
        cursor = escape === null ? cursor + 1 : escape.end;
        if (decoded.includes("\0")) {
          current.value += hasEnded ? "" : decoded.slice(0, decoded.indexOf("\0"));
          hasEnded = true;
        } else if (!hasEnded) {
          current.value += decoded;
        }
      }
      current.raw += source.slice(index, cursor + 1);
      current.isQuoted = true;
      index = cursor + 1;
      continue;
    }
    if (char === '"') {
      const current = ensureWord();
      let cursor = index + 1;
      while (cursor < source.length && source[cursor] !== '"') {
        const inner = source[cursor];
        if (inner === "\\" && cursor + 1 < source.length && '"\\$`\n'.includes(source[cursor + 1])) {
          current.value += source[cursor + 1];
          cursor += 2;
          continue;
        }
        if (inner === "$" && source[cursor + 1] === "(") {
          const read = readBalanced(source, cursor + 2);
          current.value += source.slice(cursor, read.end);
          current.hasExpansion = true;
          cursor = read.end;
          continue;
        }
        if (inner === "`") {
          const read = readBacktick(source, cursor + 1);
          current.value += source.slice(cursor, read.end);
          current.hasExpansion = true;
          cursor = read.end;
          continue;
        }
        if (inner === "$" && /[A-Za-z_{@*#?$!0-9-]/.test(source[cursor + 1] ?? "")) {
          current.hasExpansion = true;
        }
        current.value += inner;
        cursor += 1;
      }
      current.raw += source.slice(index, cursor + 1);
      current.isQuoted = true;
      index = cursor + 1;
      continue;
    }
    if (char === "$" && nextChar === "(") {
      const current = ensureWord();
      const read = readBalanced(source, index + 2);
      current.value += source.slice(index, read.end);
      current.raw += source.slice(index, read.end);
      current.hasExpansion = true;
      index = read.end;
      continue;
    }
    if (char === "$" && nextChar === "{") {
      const current = ensureWord();
      const end = readBrace(source, index + 2);
      current.value += source.slice(index, end);
      current.raw += source.slice(index, end);
      current.hasExpansion = true;
      index = end;
      continue;
    }
    if (char === "$" && /[A-Za-z_@*#?$!0-9-]/.test(nextChar ?? "")) {
      const current = ensureWord();
      current.value += char;
      current.raw += char;
      current.hasExpansion = true;
      index += 1;
      continue;
    }
    if (char === "`") {
      const current = ensureWord();
      const read = readBacktick(source, index + 1);
      current.value += source.slice(index, read.end);
      current.raw += source.slice(index, read.end);
      current.hasExpansion = true;
      index = read.end;
      continue;
    }
    if ((char === "<" || char === ">") && nextChar === "(") {
      // Process substitution is a word (a /dev/fd path) to the command.
      const current = ensureWord();
      const read = readBalanced(source, index + 2);
      current.value += source.slice(index, read.end);
      current.raw += source.slice(index, read.end);
      current.hasExpansion = true;
      index = read.end;
      continue;
    }
    if (char === ">" || char === "<") {
      let fd = null;
      if (word !== null && !word.isQuoted && /^\d+$/.test(word.raw) && pendingRedirect === null) {
        fd = word.raw;
        word = null;
      } else {
        finishWord();
      }
      const operator = REDIRECT_OPERATORS.find((candidate) => source.startsWith(candidate, index));
      if (pendingRedirect !== null) {
        redirects.push({ ...pendingRedirect, target: "", hasExpansion: false });
      }
      pendingRedirect = { operator, fd };
      index += operator.length;
      continue;
    }
    if (char === "&" && nextChar === ">") {
      finishWord();
      const operator = source[index + 2] === ">" ? "&>>" : "&>";
      if (pendingRedirect !== null) {
        redirects.push({ ...pendingRedirect, target: "", hasExpansion: false });
      }
      pendingRedirect = { operator, fd: null };
      index += operator.length;
      continue;
    }
    if (char === "(" || char === ")") {
      // A subshell's ( and ) are words of their own, so `(rm -rf x)` reads as rm.
      finishWord();
      words.push({ value: char, raw: char, isQuoted: false, hasExpansion: false, isGrouping: true });
      index += 1;
      continue;
    }
    const current = ensureWord();
    current.value += char;
    current.raw += char;
    index += 1;
  }
  finishWord();
  if (pendingRedirect !== null) {
    redirects.push({ ...pendingRedirect, target: "", hasExpansion: false });
  }
  return { words, redirects };
}
