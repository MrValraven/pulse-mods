// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
// Modified by MrValraven for pulse-mods: moved out of blast-radius.mjs in 0.3.0
// and extended to every part of a command line, wrappers and new patterns.
//
// What counts as risky. Pure functions with no `$`, so tests import them as is.
//
// classify(command) reads every simple command on the line, including the ones
// inside $( ), backticks, here-documents and `bash -c "..."`, and returns a
// plan: one part per simple command, each with the risks found in it. The hook
// measures each risk, then holdVerdict(plan) says whether to hold.
//
// The rule this file keeps: when unsure whether a form is risky, hold it.

import { naiveSplit, splitCommand, tokenize } from "./split.mjs";

export const MAX_DEPTH = 6;

// sudo options that take a value, so the value isn't read as the command.
const SUDO_VALUE_OPTIONS = new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U"]);
// Commands that only read, so a bare word "migrate" in them isn't a migration.
const READ_ONLY = new Set(["ls", "cat", "echo", "printf", "grep", "rg", "find", "less", "head", "tail", "cd", "git"]);
// Shell words that can come before the real command without changing what it does.
const KEYWORD_PREFIXES = new Set(["then", "do", "else", "elif", "if", "while", "until", "!", "{", "("]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "mksh", "fish"]);
// Commands whose quoted arguments are text they print, search or send: a
// quoted "; rm -rf x" there is data. Any other command's quoted argument that
// reads as a risky command is held, since the command may run it.
const DATA_COMMANDS = new Set([
  "echo", "printf", "grep", "egrep", "fgrep", "rg", "ag", "ack", "jq", "yq", "tr", "cut",
  "column", "gh", "glab", "curl", "wget", "cat", "less", "head", "tail", "wc", "test", "[", "[[", "true", "false",
  ":", "sort", "uniq", "diff", "ls", "cd", "pushd", "popd", "printenv", "export", "read", "notify-send", "say",
]);
const GIT_DATA_SUBCOMMANDS = new Set(["commit", "tag", "notes", "log", "shortlog", "show", "grep", "config", "stash", "merge"]);
// Commands that change no files, so a git reset after them still sees what it would discard.
const QUIET_COMMANDS = new Set([
  "cd", "pushd", "popd", "pwd", "ls", "echo", "printf", "true", "false", ":", "test", "[", "[[", "set", "export",
  "unset", "which", "type", "cat", "head", "tail", "grep", "rg", "wc", "sleep", "date", "whoami", "mkdir", "touch",
]);
// fetch and branch are left out: they move the refs a later reset is measured against.
const GIT_QUIET_SUBCOMMANDS = new Set(["status", "log", "diff", "show", "rev-parse", "describe", "ls-files", "blame"]);
const GIT_GLOBAL_VALUE_OPTIONS = new Set(["-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
// Git's own subcommands. Git never lets an alias take one of these names, so
// they mean what they say; isGitRefEdit reads the flags of the ones that can
// edit refs. Any other subcommand (an alias, a git-foo extension) counts as a
// ref edit. filter-branch and fast-import are left out: they rewrite refs.
const GIT_BUILTINS = new Set([
  "add", "am", "annotate", "apply", "archive", "bisect", "blame", "branch", "bundle", "cat-file", "check-attr",
  "check-ignore", "check-mailmap", "check-ref-format", "checkout", "checkout-index", "cherry", "cherry-pick",
  "clean", "clone", "column", "commit", "commit-graph", "commit-tree", "config", "count-objects", "describe",
  "diff", "diff-files", "diff-index", "diff-tree", "difftool", "fetch", "for-each-ref", "format-patch", "fsck",
  "gc", "grep", "hash-object", "help", "init", "interpret-trailers", "log", "ls-files", "ls-remote", "ls-tree",
  "maintenance", "merge", "merge-base", "merge-file", "merge-tree", "mergetool", "mv", "name-rev", "notes",
  "pack-refs", "prune", "pull", "push", "range-diff", "rebase", "reflog", "remote", "repack", "replace", "rerere",
  "reset", "restore", "rev-list", "rev-parse", "revert", "rm", "shortlog", "show", "show-branch", "show-ref",
  "sparse-checkout", "stash", "status", "submodule", "switch", "symbolic-ref", "tag", "update-index", "update-ref",
  "var", "verify-commit", "verify-tag", "version", "whatchanged", "worktree", "write-tree",
]);

const DELETE_COMMANDS = new Set(["rm", "rmdir", "unlink"]);
const PERMISSION_COMMANDS = new Set(["chmod", "chown", "chgrp"]);
const FORMAT_COMMAND = /^(mkfs(\..+)?|mke2fs|newfs(_.+)?|wipefs)$/;
const FIND_EXEC_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const FIND_WRITE_ACTIONS = new Set(["-fprint", "-fprint0", "-fprintf", "-fls"]);
const TRUNCATING = new Set([">", ">|", "&>"]);
const NULL_DEVICES = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;
const SQL_CLIENTS = new Set(["psql", "mysql", "mariadb", "sqlite3"]);
const SQL_DESTRUCTIVE = /\b(drop|truncate)\b|\bdelete\s+from\b/i;
const SQL_OBJECTS = /^(table|database|schema|index|view|user|role|sequence|function|procedure|trigger|type|extension|materialized|column|if)$/i;
const RAILS_DESTRUCTIVE = /\bdb:(drop|reset|schema:load|structure:load|purge|truncate_all|migrate:reset)\b/;
const RAILS_WOULD = {
  drop: "drop the database",
  reset: "drop the database and load the schema again",
  "schema:load": "load the schema over the database, emptying every table",
  "structure:load": "load the structure over the database, emptying every table",
  purge: "empty the database",
  truncate_all: "delete every row in every table",
  "migrate:reset": "drop the database and run every migration again",
};
const DOCKER_VALUE_OPTIONS = new Set(["--context", "-c", "-H", "--host", "--config", "-l", "--log-level", "--tlscacert", "--tlscert", "--tlskey"]);
const KUBECTL_VALUE_FLAGS = new Set(["-n", "--namespace", "--context", "--cluster", "--user", "--kubeconfig", "-s", "--server", "--token", "--as", "--as-group"]);

const XARGS_REASON = "the paths come from what xargs reads on its input, which only exists when the command runs";
const DATABASE_REASON = "Blast Radius does not connect to databases, so the data this would remove is not counted";

/** Every pattern Blast Radius holds, for /blast-radius help and the README. */
export const PATTERNS = [
  {
    family: "Files",
    lines: [
      "rm (with or without flags), rmdir, unlink: the files it would delete, their count and size",
      "shred: the files it would overwrite (and delete, with -u)",
      "find ... -delete, find ... -exec rm: what find matches, from a dry run with -print",
      "xargs rm: held, unmeasured (the paths arrive on xargs input)",
      "> file: held when the file exists and is not empty, or when an earlier part changes files",
      "mv: held when it would replace an existing file, or when an earlier part changes files",
      "dd of=: what it would write over",
      "mkfs, mke2fs, newfs, wipefs: held, unmeasured",
      "chmod -R, chown -R, chgrp -R: how many files it would change",
    ],
  },
  {
    family: "Git",
    lines: [
      "reset --hard, checkout -- <path>, checkout <ref> -- <path>, checkout -f, switch -f / --discard-changes, restore <path>: the uncommitted changes it would discard; runs without a hold when there are none",
      "clean: the untracked paths, from git clean -n",
      "push --force (also -f, --force-with-lease, +ref): the remote commits it would drop",
      "push --delete, push origin :branch: the remote branch and its commits no local branch has",
      "push --mirror, push --prune: held, unmeasured",
      "branch -D, branch -d --force: commits on no other branch",
      "stash drop, stash clear: the stashes it would delete",
      "reflog expire, gc --prune, prune: the entries and loose objects now",
      "filter-branch, filter-repo: held, unmeasured",
      "update-ref -d: the commit the ref points to now",
    ],
  },
  {
    family: "Databases",
    lines: [
      "manage.py migrate, db:migrate, alembic upgrade, prisma migrate: pending migrations (with measureMigrations on)",
      "prisma migrate reset, prisma db push --force-reset / --accept-data-loss: held, unmeasured",
      "rails db:drop / db:reset / db:schema:load (and purge, truncate_all, migrate:reset): held, unmeasured",
      "alembic downgrade, manage.py flush / reset_db: held, unmeasured",
      "DROP, TRUNCATE, DELETE FROM in psql -c, mysql -e, sqlite3, or piped into them: held, unmeasured",
    ],
  },
  {
    family: "Infrastructure",
    lines: [
      "docker system prune, docker volume prune, docker container prune: what docker reports as unused",
      "docker rm, docker volume rm: the containers or volumes named",
      "docker compose down -v: held, unmeasured",
      "kubectl delete (and oc delete): the resources kubectl get lists for the same arguments",
      "terraform destroy (and tofu, apply -destroy): the resources in the state",
    ],
  },
  {
    family: "Wrappers it reads through",
    lines: [
      "bash -c, sh -c, zsh -c \"...\", su -c, eval, $( ), backticks, here-documents",
      "sudo, doas, env (-i, -C dir, -S), timeout N, time -p, nice, nohup, stdbuf, ionice, setsid, command, exec, xargs",
      "( ... ) subshells and name() { ... } functions",
      "ssh host, docker exec, kubectl exec -- and a quoted argument of another program that reads as risky: held, unmeasured",
      "awk system(), getline and print | strings, sed e and s///e",
      "a shell reading its input (| sh, | bash, bash -s) and a command named by an expansion ($CMD, \"$(which rm)\"): held as unreadable",
    ],
  },
];

// ---- The plan -------------------------------------------------------------

/**
 * Reads a whole command line.
 *
 * @returns {{ parts: Part[], notes: string[] }} where a Part is
 *   `{ text, depth, via, risks, isQuiet }` and a risk is
 *   `{ kind, label, would, dir, ... }` plus `notMeasured` (why it is not
 *   measured), `isConditional` (held only if measuring finds something at
 *   stake) and `isQuietBefore` (no part before it changes files).
 */
export function classify(command) {
  const plan = { parts: [], notes: [] };
  classifyScript(String(command ?? ""), null, 0, "", plan, false, true);
  markQuietBefore(plan.parts);
  return plan;
}

/** True when any part of the plan has a risk, so the hook measures it. */
export function hasRisk(plan) {
  return plan.parts.some((part) => part.risks.length > 0);
}

function classifyScript(script, startDir, depth, via, plan, isElsewhere, isStartLinked) {
  if (depth > MAX_DEPTH) {
    plan.parts.push({
      text: script.trim(),
      depth,
      via,
      isQuiet: false,
      risks: [
        {
          kind: "unreadable",
          label: "nested shells",
          would: "run commands nested too deep to read",
          dir: startDir,
          notMeasured: `the command nests shells more than ${MAX_DEPTH} levels deep, deeper than Blast Radius reads`,
        },
      ],
    });
    return;
  }
  const split = splitCommand(script);
  const firstPartIndex = plan.parts.length;
  let dir = startDir; // where a `cd` earlier on the line moved to; null means the session folder
  const scopes = []; // dir to restore when a ( subshell ) closes
  const pushed = []; // pushd stack, for popd
  // Whether every link from the last cd to here is &&: after `cd x; mv a b`
  // a failed cd leaves mv running in the folder before it.
  let isDirLinked = isStartLinked;
  let hasCd = false;
  // Parts that run at the same time as each other: a pipeline (|) or a
  // background job (&) with its neighbours, and everything inside one
  // segment ($( ), <( ), here-documents). A nothing-to-discard pass needs
  // every other member quiet too.
  let unit = null;
  split.segments.forEach((segment, segmentIndex) => {
    if (unit === null || (segment.separatorBefore !== "|" && segment.separatorBefore !== "&")) {
      unit = { members: [] };
    }
    const segmentStart = plan.parts.length;
    const opens = segment.text.match(/^\(+/)?.[0].length ?? 0;
    // Trailing redirects and & don't hide a closing ) : `(cd sub && make) > log`.
    const tail = segment.text.replace(/(?:\s*(?:\d*>>?|&>>?|<)\s*\S+|\s*&)+\s*$/, "");
    const closes = tail.match(/\)+\s*$/)?.[0].trim().length ?? 0;
    if (hasCd && segment.separatorBefore !== "&&") {
      isDirLinked = false;
    }
    for (let count = 0; count < opens; count += 1) {
      scopes.push({ dir, isDirLinked, hasCd });
    }
    const previous = segmentIndex > 0 ? split.segments[segmentIndex - 1] : null;
    const pipedFrom = segment.separatorBefore === "|" && previous !== null ? previous.text : null;
    const reading = readSegment(segment.text, dir, pushed, pipedFrom);
    const risks = isElsewhere ? elsewhereRisks(reading.risks, via) : reading.risks;
    for (const risk of risks) {
      risk.isDirLinked = isDirLinked;
    }
    // A git command says whether it edits refs; any other command that changes
    // files (a script like ./rename-branch.sh) may, so only a quiet one is ref-stable.
    const isQuiet = reading.isQuiet && risks.length === 0;
    plan.parts.push({ text: segment.text, depth, via, risks, isQuiet, isRefStable: reading.isRefStable ?? isQuiet });
    for (const nested of reading.nested) {
      classifyScript(nested.script, nested.dir, depth + 1, nested.via, plan, isElsewhere || nested.isElsewhere === true, isDirLinked);
    }
    for (const substitution of split.substitutions) {
      if (substitution.segmentIndex === segmentIndex) {
        classifyScript(substitution.script, dir, depth + 1, substitution.via, plan, isElsewhere, isDirLinked);
      }
    }
    for (const heredoc of split.heredocs) {
      if (heredoc.segmentIndex === segmentIndex) {
        classifyScript(heredoc.script, dir, depth + 1, "a here-document", plan, isElsewhere, isDirLinked);
      }
    }
    for (const member of plan.parts.slice(segmentStart)) {
      member.units = [...(member.units ?? []), unit];
      unit.members.push(member);
    }
    if (reading.cd !== undefined) {
      dir = reading.cd; // a cd, pushd or popd moved the folder
      hasCd = true;
    }
    for (let count = 0; count < closes && scopes.length > 0; count += 1) {
      ({ dir, isDirLinked, hasCd } = scopes.pop()); // a cd inside ( ... ) doesn't outlive it
    }
  });

  if (split.isUnbalanced) {
    // A quote that never closes swallows the rest of the line, so the line is
    // also read the old way, every quote ignored, and anything risky there held.
    plan.notes.push("A quote or bracket in the command never closes, so Blast Radius also read it with every quote ignored.");
    const knownLabels = new Set(plan.parts.slice(firstPartIndex).flatMap((part) => part.risks.map((risk) => risk.label)));
    for (const piece of naiveSplit(script)) {
      const reading = readSegment(piece, startDir, [], null);
      const risks = reading.risks
        .filter((risk) => !risk.isConditional && !knownLabels.has(risk.label))
        .map((risk) => ({ ...risk, notMeasured: risk.notMeasured ?? "its quotes do not pair up, so its paths can't be read reliably" }));
      if (risks.length > 0) {
        risks.forEach((risk) => knownLabels.add(risk.label));
        plan.parts.push({ text: piece, depth, via: "the line read with quotes ignored", risks, isQuiet: false });
      }
    }
  }
}

/**
 * Risks inside a quoted argument of another program (docker exec, ssh) run
 * where Blast Radius can't measure, so they are held unmeasured. A conditional
 * one (a > redirect, an mv) is dropped there: in `node -e "a > b"` it is code.
 */
function elsewhereRisks(risks, via) {
  return risks
    .filter((risk) => !risk.isConditional)
    .map((risk) => ({
      ...risk,
      notMeasured: risk.notMeasured ?? `it is ${via}, which may run it in another shell, a container or a remote host that Blast Radius does not follow`,
    }));
}

function markQuietBefore(parts) {
  let isAllQuiet = true;
  let isAllRefStable = true;
  for (const part of parts) {
    const peers = (part.units ?? []).flatMap((unit) => unit.members).filter((member) => member !== part);
    const isUnitQuiet = peers.every((member) => member.isQuiet);
    const isUnitRefStable = peers.every((member) => member.isRefStable !== false);
    for (const risk of part.risks) {
      risk.isQuietBefore = isAllQuiet && isUnitQuiet;
      // No git command before it or beside it that edits refs (branch, tag,
      // fetch, stash...), so `git checkout name` means the same branch it did.
      risk.isRefStableBefore = isAllRefStable && isUnitRefStable;
    }
    isAllQuiet = isAllQuiet && part.isQuiet;
    isAllRefStable = isAllRefStable && part.isRefStable !== false;
  }
}

// ---- One simple command ---------------------------------------------------

/** A folder a later `cd arg` moves to, given the folder so far (null = the session folder). */
function joinDir(dir, arg) {
  if (arg === undefined || arg === "~" || arg.startsWith("/") || arg.startsWith("~/")) {
    return arg ?? "~";
  }
  return dir ? `${dir}/${arg}` : arg;
}

/** The command's name: its last path part, with a leading backslash (`\rm`, alias skip) removed. */
function commandName(word) {
  return word.value.replace(/^\\/, "").split("/").pop();
}

/** True when the word, as written, has a $ or a backtick outside double quotes, where the shell splits what it expands. */
function hasUnquotedExpansion(raw) {
  let quote = null;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (quote === "'") {
      quote = char === "'" ? null : quote;
    } else if (char === "\\") {
      index += 1;
    } else if (quote === '"') {
      quote = char === '"' ? null : quote;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "$" || char === "`") {
      return true;
    }
  }
  return false;
}

/** True when only the shell can say what the word becomes: $VAR, $( ), backticks, {a,b}. */
function isUnexpanded(word) {
  return word.hasExpansion || (!word.isQuoted && /\{[^}]*,[^}]*\}/.test(word.raw));
}

/** Removes the ( ) and { } that group commands, leaving the command. */
function stripGrouping(text) {
  let stripped = text.trim().replace(/^(?:\{\s+)+/, "");
  if (stripped === "{" || stripped === "}") {
    return "";
  }
  stripped = stripped.replace(/\s+\}$/, "");
  const opens = (stripped.match(/\(/g) ?? []).length;
  const closes = (stripped.match(/\)/g) ?? []).length;
  for (let count = 0; count < opens - closes && stripped.startsWith("("); count += 1) {
    stripped = stripped.slice(1).trimStart();
  }
  for (let count = 0; count < closes - opens && stripped.endsWith(")"); count += 1) {
    stripped = stripped.slice(0, -1).trimEnd();
  }
  return stripped;
}

const SSH_VALUE_OPTIONS = new Set(["-p", "-i", "-l", "-o", "-F", "-J", "-L", "-R", "-D", "-E", "-b", "-c", "-m", "-O", "-Q", "-S", "-W", "-w", "-e", "-B", "-I"]);
const EXEC_VALUE_OPTIONS = new Set(["-u", "--user", "-w", "--workdir", "-e", "--env", "--env-file", "--detach-keys"]);

/**
 * The command a program runs somewhere else, written unquoted on the line:
 * `ssh host rm -rf /data`, `docker exec web rm -rf /data`, `kubectl exec p -- rm -rf /x`.
 */
function remoteCommand(name, args) {
  // docker and kubectl exec run the words as an argument list, so the words are kept as written.
  const rawFrom = (index) => args.slice(index).map((word) => word.raw).join(" ");
  if (name === "ssh") {
    let index = 0;
    while (index < args.length && args[index].value.startsWith("-")) {
      if (args[index].value === "--") {
        index += 1;
        break;
      }
      index += SSH_VALUE_OPTIONS.has(args[index].value) ? 2 : 1;
    }
    // OpenSSH also reads options after the host (`ssh host -t cmd`, `ssh host -p 22 cmd`).
    let commandStart = index + 1;
    while (commandStart < args.length && args[commandStart].value.startsWith("-")) {
      if (args[commandStart].value === "--") {
        commandStart += 1;
        break;
      }
      commandStart += SSH_VALUE_OPTIONS.has(args[commandStart].value) ? 2 : 1;
    }
    // ssh joins its arguments' values with spaces and the remote shell reads that line.
    const remoteLine = args.slice(commandStart).map((word) => word.value).join(" ");
    return commandStart < args.length ? { script: remoteLine, via: `a command ssh runs on ${args[index].value}` } : null;
  }
  if ((name === "docker" || name === "podman") && args[0]?.value === "exec") {
    let index = 1;
    while (index < args.length && args[index].value.startsWith("-")) {
      index += EXEC_VALUE_OPTIONS.has(args[index].value) ? 2 : 1;
    }
    return index + 1 < args.length ? { script: rawFrom(index + 1), via: `a command ${name} exec runs in ${args[index].value}` } : null;
  }
  if ((name === "kubectl" || name === "oc") && args.some((word) => word.value === "exec")) {
    const dashes = args.findIndex((word) => word.value === "--");
    return dashes !== -1 && dashes + 1 < args.length ? { script: rawFrom(dashes + 1), via: `a command ${name} exec runs in a pod` } : null;
  }
  return null;
}

/**
 * awk and sed programs can run shell commands: awk's system("..."), "cmd" | getline
 * and print | "cmd", and sed's `e command` and the `e` flag of s///. A quoted
 * string with a space in an awk program is read as a command; a sed `e` holds.
 */
function readProgram(name, args, dir, reading) {
  const isAwk = !name.includes("sed");
  for (const word of args) {
    if (isAwk) {
      for (const match of word.value.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
        if (/\s/.test(match[1])) {
          reading.nested.push({ script: match[1], dir, via: `a string in an ${name} program`, isElsewhere: true });
        }
      }
      if (word.isQuoted && /\s/.test(word.value)) {
        reading.nested.push({ script: word.value, dir, via: `a quoted argument of ${name}`, isElsewhere: true });
      }
      continue;
    }
    const execCommand = word.value.match(/(?:^|[;\n{}])\s*(?:\d+|\$|\/[^/]*\/)?\s*e\s+([^;\n}]+)/);
    const hasExecFlag = /(?:^|[;\n{}\s])s(.)(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[gpiImMw0-9]*e/.test(word.value);
    if (execCommand !== null) {
      reading.nested.push({ script: execCommand[1], dir, via: `a sed e command`, isElsewhere: true });
    }
    if (hasExecFlag) {
      reading.risks.push({
        kind: "unreadable",
        label: `${name} s///e`,
        would: "run each matching line as a shell command",
        dir,
        notMeasured: "the e flag runs the text sed builds from its input, which only exists when the command runs",
      });
    }
    if (word.isQuoted && /\s/.test(word.value) && execCommand === null) {
      // `sed -e 's/a/b/; rm -rf x'` read the old way: a quoted program is read as a command line too.
      reading.nested.push({ script: word.value, dir, via: `a quoted argument of ${name}`, isElsewhere: true });
    }
  }
}

/** One segment: its risks, a folder change, and nested scripts to read (bash -c). */
function readSegment(text, dir, pushed, pipedFrom) {
  const reading = { risks: [], cd: undefined, nested: [], isQuiet: false };
  const { words: allWords, redirects } = tokenize(stripGrouping(text));
  for (const redirect of redirects) {
    // `>&file` (no fd number after it) sends stdout and stderr to a file, emptying it like >.
    const isTruncating = TRUNCATING.has(redirect.operator) || (redirect.operator === ">&" && !/^(\d+-?|-)$/.test(redirect.target));
    if (isTruncating && redirect.target !== "" && !NULL_DEVICES.test(redirect.target)) {
      reading.risks.push({
        kind: "truncate",
        label: `> ${redirect.target}`,
        would: `empty ${redirect.target} and write over it`,
        dir,
        target: redirect.target,
        hasUnexpanded: redirect.hasExpansion === true,
        isConditional: true,
      });
    }
  }
  // `name() { ... }` defines a function: the body is the command to read.
  let tokens = allWords;
  if (tokens.length >= 3 && !tokens[0].isGrouping && tokens[1].isGrouping && tokens[1].value === "(" && tokens[2].isGrouping && tokens[2].value === ")") {
    tokens = tokens.slice(3);
  }
  // The ( and ) of a subshell are dropped, so `(rm -rf x)` reads as rm.
  const peeled = peelWrappers(
    tokens.filter((word) => !word.isGrouping),
    dir,
  );
  if (peeled.nested !== null) {
    reading.nested.push(peeled.nested);
    return reading;
  }
  if (peeled.isLookup || peeled.words.length === 0) {
    reading.isQuiet = reading.risks.length === 0;
    return reading;
  }
  const words = peeled.words;
  // `"$HOME/.venv/bin/python"` and `"$(npm bin)/eslint"` name the command by a
  // literal last path part. An unquoted `$X/ls` can split into other words, and
  // a name that is itself an expansion is unknown: both are unreadable.
  const lastPathPart = words[0].value.split("/").pop();
  const isLeadingFolderOnly =
    words[0].value.includes("/") && /^[A-Za-z0-9._+-]+$/.test(lastPathPart) && !hasUnquotedExpansion(words[0].raw);
  if (isUnexpanded(words[0]) && !isLeadingFolderOnly) {
    reading.isRefStable = false;
    // `$CMD -rf x`, `"$(which rm)" x`: only the shell knows what runs.
    reading.risks.push({
      kind: "unreadable",
      label: "a command named by an expansion",
      would: `run ${shorten(words.map((word) => word.raw).join(" "), 60)}`,
      dir,
      notMeasured: `the command name ${shorten(words[0].raw, 40)} comes from a shell variable or command output, which only the shell expands`,
    });
    return reading;
  }
  const name = commandName(words[0]);
  const args = words.slice(1);
  if (name === "git") {
    reading.isRefStable = !isGitRefEdit(args, dir);
  }
  if (SHELLS.has(name) && (pipedFrom !== null || args.some((word) => /^-[a-zA-Z]*s[a-zA-Z]*$/.test(word.value)))) {
    // `curl ... | sh`, `bash -s`: the shell runs what it reads on its input.
    reading.risks.push({
      kind: "unreadable",
      label: `${name} reading its input`,
      would: `run whatever commands ${name} reads on its input`,
      dir,
      notMeasured: `${name} runs the commands it reads on its input, which only exist when the command runs`,
    });
    return reading;
  }
  const remote = remoteCommand(name, args);
  if (remote !== null) {
    reading.nested.push({ script: remote.script, dir: peeled.dir, via: remote.via, isElsewhere: true });
    return reading;
  }
  if (name === "awk" || name === "gawk" || name === "mawk" || name === "nawk" || name === "sed" || name === "gsed") {
    readProgram(name, args, peeled.dir, reading);
    reading.isQuiet = false;
    return reading;
  }
  if (name === "cd") {
    reading.cd = args[0]?.value === "-" ? "-" : joinDir(dir, args[0]?.value);
    reading.isQuiet = true;
    return reading;
  }
  if (name === "pushd") {
    pushed.push(dir);
    reading.cd = joinDir(dir, args[0]?.value);
    reading.isQuiet = true;
    return reading;
  }
  if (name === "popd") {
    reading.cd = pushed.length > 0 ? pushed.pop() : "-";
    reading.isQuiet = true;
    return reading;
  }
  const found = readCommand(name, words, args, peeled.dir, peeled.isViaXargs, pipedFrom);
  if (found !== null && found.length > 0) {
    reading.risks.push(...found);
  } else if (!DATA_COMMANDS.has(name) && !(name === "git" && GIT_DATA_SUBCOMMANDS.has(parseGit(args, dir).sub))) {
    for (const word of args) {
      if (word.isQuoted && /\s/.test(word.value)) {
        reading.nested.push({ script: word.value, dir: peeled.dir, via: `a quoted argument of ${name}`, isElsewhere: true });
      }
    }
  }
  reading.isQuiet = reading.risks.length === 0 && reading.nested.length === 0 && isQuietCommand(name, args, dir);
  return reading;
}

/**
 * Git commands that rename or delete refs, so a later `git checkout name` may
 * mean something else: branch -m/-M/-d/-D, tag -d, update-ref, symbolic-ref,
 * fetch or pull --prune, remote remove/rename/prune, push --delete, config
 * writes, the subcommands that run a command of yours (rebase --exec, bisect
 * run, submodule foreach, difftool --extcmd), and any subcommand outside
 * GIT_BUILTINS: an alias (`git rb` set to `branch -m`) or a git-foo
 * extension may do anything.
 */
function isGitRefEdit(args, dir) {
  const { sub, rest } = parseGit(args, dir);
  if (sub === undefined) {
    return false; // `git` or `git --version` runs no subcommand
  }
  if (!GIT_BUILTINS.has(sub)) {
    return true;
  }
  const values = rest.map((word) => word.value);
  const shortFlags = values.filter((value) => /^-[a-zA-Z]+$/.test(value)).join("");
  const hasOption = (pattern) => values.some((value) => pattern.test(value));
  if (sub === "config") {
    // A config write can add an alias or move core.worktree; only a plain read is stable.
    return !hasOption(/^(--get(-all|-regexp|-urlmatch|-color|colorbool)?|--list|-l|get|list)$/);
  }
  if (sub === "pull") {
    return hasOption(/^--prune/) || shortFlags.includes("p");
  }
  if (sub === "push") {
    // `git push . :foo` deletes the local branch foo.
    return hasOption(/^(--delete|-d|--prune|--mirror)$/) || values.some((value) => value.startsWith(":") || value.includes(":refs/heads/"));
  }
  if (sub === "rebase") {
    return hasOption(/^(--exec|-x)/) || shortFlags.includes("x");
  }
  if (sub === "bisect") {
    return values.includes("run");
  }
  if (sub === "submodule") {
    return values.includes("foreach");
  }
  if (sub === "difftool" || sub === "mergetool") {
    return hasOption(/^(--extcmd|-x)/);
  }
  if (sub === "branch") {
    return /[mMdD]/.test(shortFlags) || values.includes("--delete") || values.includes("--move");
  }
  if (sub === "tag") {
    return shortFlags.includes("d") || values.includes("--delete");
  }
  if (sub === "update-ref" || sub === "symbolic-ref") {
    return true;
  }
  if (sub === "fetch") {
    return values.includes("--prune") || values.includes("--prune-tags") || /[pP]/.test(shortFlags);
  }
  if (sub === "remote") {
    const action = values.find((value) => !value.startsWith("-"));
    return ["remove", "rm", "rename", "prune"].includes(action) || (action === "update" && (values.includes("--prune") || shortFlags.includes("p")));
  }
  return false;
}

function isQuietCommand(name, args, dir) {
  if (name === "git") {
    return GIT_QUIET_SUBCOMMANDS.has(parseGit(args, dir).sub);
  }
  return QUIET_COMMANDS.has(name);
}

/** Skips options at the front of `words`; options in `valueOptions` take the next word too. */
function skipOptions(words, valueOptions = new Set()) {
  while (words.length > 0 && words[0].value.startsWith("-") && words[0].value !== "-") {
    const option = words.shift().value;
    if (option === "--") {
      return;
    }
    if (valueOptions.has(option)) {
      words.shift();
    }
  }
}

/**
 * Peels the words that run another command (sudo, timeout 5, env -i, xargs)
 * off the front. A shell with -c, eval or su -c hands back the string it runs
 * as `nested`, to be read as a script of its own.
 */
function peelWrappers(inputWords, dir) {
  const result = { words: inputWords.slice(), dir, isViaXargs: false, nested: null, isLookup: false };
  const words = result.words;
  for (let guard = 0; guard < 64 && words.length > 0; guard += 1) {
    const word = words[0];
    if (!word.isQuoted && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word.value)) {
      words.shift(); // leading VAR=value
      continue;
    }
    if (!word.isQuoted && KEYWORD_PREFIXES.has(word.value)) {
      words.shift();
      continue;
    }
    if (!word.isQuoted && /^[A-Za-z_][\w.-]*\(\)$/.test(word.value)) {
      words.shift(); // a function definition `name() { ... }`
      continue;
    }
    if (!word.isQuoted && word.value === "function" && words.length > 1) {
      words.splice(0, 2); // `function name { ... }`
      continue;
    }
    const name = commandName(word);
    if (name === "sudo") {
      words.shift();
      skipOptions(words, SUDO_VALUE_OPTIONS);
      continue;
    }
    if (name === "doas") {
      words.shift();
      skipOptions(words, new Set(["-u", "-C"]));
      continue;
    }
    if (name === "nohup" || name === "builtin" || name === "chronic" || name === "unbuffer" || name === "setsid") {
      words.shift();
      skipOptions(words);
      continue;
    }
    if (name === "command") {
      words.shift();
      if (words[0]?.value === "-v" || words[0]?.value === "-V") {
        result.isLookup = true; // `command -v rm` looks rm up and runs nothing
        return result;
      }
      skipOptions(words);
      continue;
    }
    if (name === "exec") {
      words.shift();
      skipOptions(words, new Set(["-a"]));
      continue;
    }
    if (name === "time") {
      words.shift();
      skipOptions(words, new Set(["-o", "-f", "--output", "--format"]));
      continue;
    }
    if (name === "nice") {
      words.shift();
      skipOptions(words, new Set(["-n", "--adjustment"]));
      continue;
    }
    if (name === "ionice") {
      words.shift();
      skipOptions(words, new Set(["-c", "-n", "--class", "--classdata"]));
      continue;
    }
    if (name === "stdbuf") {
      words.shift();
      skipOptions(words, new Set(["-i", "-o", "-e", "--input", "--output", "--error"]));
      continue;
    }
    if (name === "caffeinate") {
      words.shift();
      skipOptions(words, new Set(["-t", "-w"]));
      continue;
    }
    if (name === "timeout") {
      words.shift();
      skipOptions(words, new Set(["-s", "-k", "--signal", "--kill-after"]));
      words.shift(); // the duration
      continue;
    }
    if (name === "env") {
      words.shift();
      while (words.length > 0) {
        const option = words[0].value;
        if (option === "--") {
          words.shift();
          break;
        }
        if (option === "-u" || option === "--unset" || option === "-P") {
          words.splice(0, 2);
        } else if (option === "-C" || option === "--chdir") {
          result.dir = joinDir(result.dir, words[1]?.value);
          words.splice(0, 2);
        } else if (option.startsWith("--chdir=")) {
          result.dir = joinDir(result.dir, option.slice("--chdir=".length));
          words.shift();
        } else if (option === "-S" || option === "--split-string" || option.startsWith("--split-string=")) {
          const splitText = option.startsWith("--split-string=") ? option.slice("--split-string=".length) : words[1]?.value ?? "";
          words.splice(0, option.startsWith("--split-string=") ? 1 : 2, ...tokenize(splitText).words);
          break;
        } else if (option.startsWith("-") && option !== "-") {
          words.shift(); // -i, -0, -v, --ignore-environment, --unset=NAME
        } else if (option === "-") {
          words.shift();
        } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(option)) {
          words.shift();
        } else {
          break;
        }
      }
      continue;
    }
    if (name === "xargs") {
      words.shift();
      skipOptions(
        words,
        new Set(["-I", "-L", "-n", "-P", "-s", "-E", "-d", "-a", "--arg-file", "--delimiter", "--max-args", "--max-procs", "--max-lines", "--max-chars", "--eof", "--replace"]),
      );
      result.isViaXargs = true;
      continue;
    }
    if (SHELLS.has(name)) {
      let index = 1;
      let hasCommandString = false;
      while (index < words.length && /^[-+]/.test(words[index].value) && words[index].value.length > 1) {
        const option = words[index].value;
        if (option === "--") {
          index += 1;
          break;
        }
        if (option === "-o" || option === "+o" || option === "-O" || option === "+O" || option === "--rcfile" || option === "--init-file") {
          index += 2;
          continue;
        }
        if (/^-[a-zA-Z]+$/.test(option) && option.includes("c")) {
          hasCommandString = true;
        }
        index += 1;
      }
      if (hasCommandString && index < words.length) {
        result.nested = { script: words[index].value, dir: result.dir, via: `${name} -c` };
      }
      return result; // `bash script.sh` runs a file, which is not read
    }
    if (name === "eval") {
      result.nested = { script: words.slice(1).map((each) => each.value).join(" "), dir: result.dir, via: "eval" };
      return result;
    }
    if (name === "su") {
      for (let index = 1; index < words.length; index += 1) {
        const option = words[index].value;
        if ((option === "-c" || option === "--command") && index + 1 < words.length) {
          result.nested = { script: words[index + 1].value, dir: result.dir, via: "su -c" };
          return result;
        }
        if (option.startsWith("--command=")) {
          result.nested = { script: option.slice("--command=".length), dir: result.dir, via: "su -c" };
          return result;
        }
      }
      return result;
    }
    return result;
  }
  return result;
}

/** Splits arguments into options and operands; everything after `--` is an operand. */
function splitOptions(args, valueOptions = new Set()) {
  const flags = [];
  const operands = [];
  let isAfterDashes = false;
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (!isAfterDashes && word.value === "--") {
      isAfterDashes = true;
      continue;
    }
    if (!isAfterDashes && word.value.startsWith("-") && word.value !== "-") {
      flags.push(word.value);
      if (valueOptions.has(word.value)) {
        index += 1;
      }
      continue;
    }
    operands.push(word);
  }
  return { flags, operands };
}

export function shorten(text, max = 60) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function describeTargets(values) {
  return values.length === 0 ? "nothing named" : shorten(values.join(" "), 60);
}

/** The risks of one simple command after its wrappers are peeled, or null. */
function readCommand(name, words, args, dir, isViaXargs, pipedFrom) {
  if (DELETE_COMMANDS.has(name)) {
    const { flags, operands } = splitOptions(args);
    return [
      {
        kind: "delete",
        command: name,
        label: `${name} ${flags.join(" ")}`.trim(),
        would: `delete ${describeTargets(operands.map((word) => word.value))}`,
        dir,
        targets: operands.map((word) => word.value),
        unexpanded: operands.filter(isUnexpanded).map((word) => word.value),
        notMeasured: isViaXargs ? XARGS_REASON : undefined,
      },
    ];
  }
  if (name === "shred") {
    const { flags, operands } = splitOptions(args, new Set(["-n", "-s", "--iterations", "--size", "--random-source"]));
    const isRemove = flags.some((flag) => flag === "--remove" || flag.startsWith("--remove=") || /^-[a-zA-Z]*u/.test(flag));
    return [
      {
        kind: "shred",
        label: `shred ${flags.join(" ")}`.trim(),
        would: `overwrite ${describeTargets(operands.map((word) => word.value))}${isRemove ? " and delete it" : ""}`,
        dir,
        targets: operands.map((word) => word.value),
        unexpanded: operands.filter(isUnexpanded).map((word) => word.value),
        isRemove,
        notMeasured: isViaXargs ? XARGS_REASON : undefined,
      },
    ];
  }
  if (name === "find") {
    return findRisks(args, dir);
  }
  if (name === "mv") {
    return moveRisks(args, dir, isViaXargs);
  }
  if (name === "dd") {
    const output = args.find((word) => word.value.startsWith("of="));
    if (output === undefined) {
      return null;
    }
    const target = output.value.slice(3);
    return [{ kind: "dd", label: "dd of=", would: `write over ${target}`, dir, target, hasUnexpanded: isUnexpanded(output) }];
  }
  if (FORMAT_COMMAND.test(name)) {
    const device = splitOptions(args).operands.at(-1)?.value ?? "a device";
    return [
      {
        kind: "format",
        label: name,
        would: `format ${device}, erasing everything on it`,
        dir,
        notMeasured: "formatting erases the whole device, and Blast Radius does not read devices",
      },
    ];
  }
  if (PERMISSION_COMMANDS.has(name)) {
    const isRecursive = args.some((word) => word.value === "--recursive" || /^-[a-zA-Z]*R[a-zA-Z]*$/.test(word.value));
    if (!isRecursive) {
      return null;
    }
    const { flags, operands } = splitOptions(args);
    const hasReference = flags.some((flag) => flag.startsWith("--reference"));
    const targetWords = hasReference || operands.length < 2 ? operands : operands.slice(1);
    const what = name === "chmod" ? "mode" : name === "chown" ? "owner" : "group";
    return [
      {
        kind: "permissions",
        command: name,
        label: `${name} -R`,
        would: `change the ${what} of everything under ${describeTargets(targetWords.map((word) => word.value))}`,
        dir,
        what,
        targets: targetWords.map((word) => word.value),
        unexpanded: targetWords.filter(isUnexpanded).map((word) => word.value),
        notMeasured: isViaXargs ? XARGS_REASON : undefined,
      },
    ];
  }
  if (name === "git" || DATA_COMMANDS.has(name)) {
    // A quoted argument here is text (a commit message, a pattern), so only the
    // unquoted words are read for database and migration commands.
    const gitFound = name === "git" ? gitRisks(args, dir) : null;
    if (gitFound !== null) {
      return gitFound;
    }
    const unquoted = words.filter((word, index) => index === 0 || !word.isQuoted);
    return databaseCommandRisks(unquoted, dir) ?? migrationRisks(name, unquoted, dir);
  }
  return databaseRisks(name, words, args, dir, pipedFrom) ?? infrastructureRisks(name, args, dir) ?? migrationRisks(name, words, dir);
}

// ---- Files ----------------------------------------------------------------

function findRisks(args, dir) {
  const values = args.map((word) => word.value);
  let hasDelete = false;
  const groups = [];
  const writers = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "-delete") {
      hasDelete = true;
    } else if (FIND_EXEC_ACTIONS.has(value)) {
      let end = index + 1;
      while (end < values.length && values[end] !== ";" && values[end] !== "+") {
        end += 1;
      }
      groups.push({ start: index, end, words: args.slice(index + 1, end) });
      index = end;
    } else if (FIND_WRITE_ACTIONS.has(value)) {
      writers.push(value);
    }
  }
  const riskyGroups = [];
  let innerLabel = "";
  for (const group of groups) {
    const innerPlan = classify(group.words.map((word) => word.raw).join(" "));
    const innerRisk = innerPlan.parts.flatMap((part) => part.risks).find((risk) => !risk.isConditional);
    if (innerRisk !== undefined) {
      riskyGroups.push(group);
      innerLabel = innerLabel || innerRisk.label;
    }
  }
  if (!hasDelete && riskyGroups.length === 0) {
    return null;
  }
  const otherActions = [
    ...groups.filter((group) => !riskyGroups.includes(group)).map((group) => `${values[group.start]} ${group.words.map((word) => word.value).join(" ")}`),
    ...writers,
  ];
  let notMeasured;
  if (otherActions.length > 0) {
    notMeasured = `find also runs ${shorten(otherActions.join(", "), 60)}, so Blast Radius did not dry-run it`;
  } else if (args.some(isUnexpanded)) {
    notMeasured = "the find arguments use shell variables or command output, which only the shell expands";
  }
  // The dry run: the first destructive action becomes -print, the rest are dropped.
  const dryRunArgs = [];
  let hasPrint = false;
  for (let index = 0; index < values.length; index += 1) {
    const group = groups.find((each) => each.start === index);
    if (values[index] === "-delete" || group !== undefined) {
      if (!hasPrint) {
        dryRunArgs.push("-print");
        hasPrint = true;
      }
      if (group !== undefined) {
        index = group.end;
      }
      continue;
    }
    dryRunArgs.push(values[index]);
  }
  return [
    {
      kind: "find",
      label: hasDelete ? "find -delete" : `find -exec ${innerLabel}`,
      would: hasDelete ? "delete every path find matches" : `run ${innerLabel} on every path find matches`,
      dir,
      dryRunArgs,
      isDelete: hasDelete,
      innerLabel,
      notMeasured,
    },
  ];
}

function moveRisks(args, dir, isViaXargs) {
  let targetDirectory = null;
  let isNoTargetDirectory = false;
  let lastOverwriteMode = "f"; // of -f, -i and -n, the last one given wins
  let hasBackup = false;
  const operands = [];
  let isAfterDashes = false;
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    const value = word.value;
    if (isAfterDashes || !value.startsWith("-") || value === "-") {
      operands.push(word);
      continue;
    }
    if (value === "--") {
      isAfterDashes = true;
    } else if (value === "-t" || value === "--target-directory") {
      targetDirectory = args[index + 1] ?? null;
      index += 1;
    } else if (value.startsWith("--target-directory=")) {
      targetDirectory = { ...word, value: value.slice("--target-directory=".length) };
    } else if (value === "-S" || value === "--suffix") {
      index += 1;
    } else if (value === "-T" || value === "--no-target-directory") {
      isNoTargetDirectory = true;
    } else if (value === "--no-clobber" || value === "--update=none" || value === "--update=none-fail") {
      lastOverwriteMode = "n";
    } else if (value === "--force" || value === "--interactive") {
      lastOverwriteMode = value === "--force" ? "f" : "i";
    } else if (value.startsWith("--backup")) {
      hasBackup = true;
    } else if (/^-[a-zA-Z]+$/.test(value)) {
      if (value.startsWith("-t") && value.length > 2) {
        targetDirectory = { ...word, value: value.slice(2) };
        continue;
      }
      for (const letter of value.slice(1)) {
        if (letter === "f" || letter === "i" || letter === "n") {
          lastOverwriteMode = letter;
        } else if (letter === "b") {
          hasBackup = true;
        } else if (letter === "T") {
          isNoTargetDirectory = true;
        }
      }
    }
  }
  if (lastOverwriteMode === "n") {
    return null; // mv -n never replaces a file
  }
  if (isViaXargs) {
    return [{ kind: "mv", label: "mv", would: "move paths read from xargs input, possibly over existing files", dir, notMeasured: XARGS_REASON }];
  }
  const destinationWord = targetDirectory ?? operands.at(-1);
  const sourceWords = targetDirectory !== null ? operands : operands.slice(0, -1);
  if (destinationWord === undefined || sourceWords.length === 0) {
    return null;
  }
  return [
    {
      kind: "mv",
      label: "mv",
      would: `move ${describeTargets(sourceWords.map((word) => word.value))} over ${destinationWord.value}`,
      dir,
      destination: destinationWord.value,
      sources: sourceWords.map((word) => word.value),
      mode: targetDirectory !== null ? "into" : isNoTargetDirectory ? "onto" : "auto",
      hasBackup,
      hasUnexpanded: [...sourceWords, destinationWord].some(isUnexpanded),
      isConditional: true,
    },
  ];
}

// ---- Git ------------------------------------------------------------------

/** Git's own options come before the subcommand; -C moves where it runs. */
function parseGit(args, dir) {
  let gitDir = dir;
  const gitOptions = [];
  let index = 0;
  while (index < args.length && args[index].value.startsWith("-")) {
    const option = args[index].value;
    if (option === "-C" && index + 1 < args.length) {
      gitDir = joinDir(gitDir, args[index + 1].value);
      index += 2;
      continue;
    }
    if (GIT_GLOBAL_VALUE_OPTIONS.has(option) && index + 1 < args.length) {
      if (option === "--git-dir" || option === "--work-tree") {
        gitOptions.push(`${option}=${args[index + 1].value}`);
      }
      index += 2;
      continue;
    }
    if (option.startsWith("--git-dir=") || option.startsWith("--work-tree=")) {
      gitOptions.push(option);
    }
    index += 1;
  }
  return { dir: gitDir, gitOptions, sub: args[index]?.value, rest: args.slice(index + 1) };
}

const GIT_VALUE_OPTIONS = {
  checkout: new Set(["-b", "-B", "--orphan", "--conflict"]),
  switch: new Set(["-c", "-C", "--create", "--force-create", "--orphan", "--conflict"]),
  restore: new Set(["-s", "--source", "--conflict"]),
  push: new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]),
  branch: new Set(["-u", "--set-upstream-to", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format"]),
  reflog: new Set(["--expire", "--expire-unreachable"]),
};

/** Options, their values, and the operands before and after `--`. */
function splitGitArgs(rest, valueOptions = new Set()) {
  const options = [];
  const optionValues = new Map();
  const before = [];
  const after = [];
  let hasDashes = false;
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index];
    if (hasDashes) {
      after.push(word);
      continue;
    }
    if (word.value === "--") {
      hasDashes = true;
      continue;
    }
    if (word.value.startsWith("-") && word.value.length > 1) {
      options.push(word.value);
      if (valueOptions.has(word.value) && index + 1 < rest.length) {
        optionValues.set(word.value, rest[index + 1].value);
        index += 1;
      }
      continue;
    }
    before.push(word);
  }
  const shortFlags = options.filter((option) => /^-[a-zA-Z]+$/.test(option)).map((option) => option.slice(1)).join("");
  return { options, optionValues, before, after, hasDashes, shortFlags };
}

function shortPaths(values) {
  return shorten(values.join(" "), 40);
}

function gitRisks(args, dir) {
  const parsed = parseGit(args, dir);
  const { sub, rest, gitOptions } = parsed;
  if (sub === undefined) {
    return null;
  }
  const base = { dir: parsed.dir, gitOptions, args: rest.map((word) => word.value) };
  const { options, optionValues, before, after, hasDashes, shortFlags } = splitGitArgs(rest, GIT_VALUE_OPTIONS[sub]);
  const beforeValues = before.map((word) => word.value);
  const afterValues = after.map((word) => word.value);
  const hasUnexpanded = [...before, ...after].some(isUnexpanded);
  const discard = (mode, fields) => ({ ...base, kind: "git-discard", mode, ref: null, source: null, paths: [], hasUnexpanded, ...fields });

  if (sub === "reset") {
    if (!options.includes("--hard")) {
      return null;
    }
    // `git reset --hard HEAD` is the plain form: no other commit's files come in.
    const ref = beforeValues[0] === undefined || beforeValues[0] === "HEAD" || beforeValues[0] === "@" ? null : beforeValues[0];
    return [
      discard("reset", {
        ref,
        label: "git reset --hard",
        would: ref === null ? "discard every uncommitted change to tracked files" : `discard every uncommitted change and move the branch to ${ref}`,
      }),
    ];
  }
  if (sub === "clean") {
    return [{ ...base, kind: "git-clean", label: "git clean", would: "remove untracked files" }];
  }
  if (sub === "push") {
    const risks = [];
    const remote = beforeValues[0] ?? "origin";
    const refspecs = beforeValues.slice(1);
    const isDeleteFlag = options.includes("--delete") || shortFlags.includes("d");
    const deletedBranches = isDeleteFlag ? refspecs : refspecs.filter((spec) => spec.startsWith(":") && spec.length > 1).map((spec) => spec.slice(1));
    if (isDeleteFlag || deletedBranches.length > 0) {
      risks.push({
        ...base,
        kind: "git-push-delete",
        label: "git push --delete",
        would: `delete ${deletedBranches.length > 0 ? deletedBranches.join(", ") : "branches"} on ${remote}`,
        remote,
        branches: deletedBranches,
      });
    }
    const isForce =
      options.some((option) => option === "--force" || option.startsWith("--force-with-lease")) ||
      shortFlags.includes("f") ||
      base.args.some((value) => /^\+/.test(value));
    if (isForce) {
      risks.push({ ...base, kind: "git-push-force", label: "git push --force", would: `overwrite the branch on ${remote}` });
    }
    if (options.includes("--mirror")) {
      risks.push({
        ...base,
        kind: "git-push-mirror",
        label: "git push --mirror",
        would: `make ${remote} match every local ref, deleting the refs it has that are not here`,
        notMeasured: "Blast Radius does not compare every remote ref with the local ones",
      });
    }
    if (options.includes("--prune")) {
      risks.push({
        ...base,
        kind: "git-push-prune",
        label: "git push --prune",
        would: `delete the branches on ${remote} that have no local branch of the same name`,
        notMeasured: "Blast Radius does not compare every remote ref with the local ones",
      });
    }
    return risks.length > 0 ? risks : null;
  }
  if (sub === "checkout") {
    const isForce = options.includes("--force") || shortFlags.includes("f");
    const createsBranch = options.some((option) => option === "-b" || option === "-B" || option === "--orphan");
    if (options.some((option) => option.startsWith("--pathspec-from-file"))) {
      return [
        discard("checkout-paths", {
          ref: beforeValues[0] ?? null,
          label: "git checkout --pathspec-from-file",
          would: "overwrite the files named in the pathspec file",
          notMeasured: "the paths are listed in a file Blast Radius does not read",
        }),
      ];
    }
    if (hasDashes && afterValues.length > 0) {
      const ref = beforeValues[0] ?? null;
      return [
        discard("checkout-paths", {
          ref,
          paths: afterValues,
          label: ref === null ? `git checkout -- ${shortPaths(afterValues)}` : `git checkout ${ref} -- ${shortPaths(afterValues)}`,
          would: ref === null ? `discard unstaged changes in ${shortPaths(afterValues)}` : `overwrite ${shortPaths(afterValues)} with the version in ${ref}`,
        }),
      ];
    }
    if (isForce) {
      const ref = beforeValues[0] ?? null;
      return [
        discard("checkout-force", {
          ref,
          label: "git checkout -f",
          would: ref === null ? "discard every uncommitted change to tracked files" : `switch to ${ref}, discarding uncommitted changes`,
        }),
      ];
    }
    if (createsBranch || hasDashes) {
      return null; // a new branch, or `git checkout main --`: a branch switch keeps changes or refuses
    }
    if (beforeValues.includes(".")) {
      const ref = beforeValues[0] !== "." ? beforeValues[0] : null;
      const paths = ref === null ? beforeValues : beforeValues.slice(1);
      return [
        discard("checkout-paths", {
          ref,
          paths,
          label: ref === null ? `git checkout ${shortPaths(paths)}` : `git checkout ${ref} ${shortPaths(paths)}`,
          would: ref === null ? `discard unstaged changes in ${shortPaths(paths)}` : `overwrite ${shortPaths(paths)} with the version in ${ref}`,
        }),
      ];
    }
    if (beforeValues.length > 0) {
      // `git checkout name`: a branch (safe) or a path (discards). Measuring tells.
      return [
        discard("checkout-ambiguous", {
          candidates: beforeValues,
          label: `git checkout ${shortPaths(beforeValues)}`,
          would: `discard unstaged changes in ${shortPaths(beforeValues)}, if it names files`,
          isConditional: true,
        }),
      ];
    }
    return null;
  }
  if (sub === "switch") {
    const flag = options.find((option) => option === "-f" || option === "--force" || option === "--discard-changes") ?? (shortFlags.includes("f") ? "-f" : null);
    if (flag === null) {
      return null;
    }
    const ref = beforeValues[0] ?? null;
    return [
      discard("switch-force", {
        ref,
        label: `git switch ${flag}`,
        would: ref === null ? "discard every uncommitted change to tracked files" : `switch to ${ref}, discarding uncommitted changes`,
      }),
    ];
  }
  if (sub === "restore") {
    const isStaged = options.includes("--staged") || shortFlags.includes("S");
    const isWorktree = options.includes("--worktree") || shortFlags.includes("W");
    if (isStaged && !isWorktree) {
      return null; // unstaging keeps the files as they are
    }
    const source =
      optionValues.get("-s") ??
      optionValues.get("--source") ??
      options.find((option) => option.startsWith("--source="))?.slice("--source=".length) ??
      options.find((option) => /^-s.+/.test(option))?.slice(2) ??
      null;
    const paths = [...beforeValues, ...afterValues];
    if (options.some((option) => option.startsWith("--pathspec-from-file"))) {
      return [
        discard("restore", {
          source,
          isStagedToo: isStaged,
          label: "git restore --pathspec-from-file",
          would: "overwrite the files named in the pathspec file",
          notMeasured: "the paths are listed in a file Blast Radius does not read",
        }),
      ];
    }
    if (paths.length === 0) {
      return null;
    }
    return [
      discard("restore", {
        source,
        paths,
        isStagedToo: isStaged,
        label: `git restore ${shortPaths(paths)}`,
        would: source === null ? `discard unstaged changes in ${shortPaths(paths)}` : `overwrite ${shortPaths(paths)} with the version in ${source}`,
      }),
    ];
  }
  if (sub === "branch") {
    const isDelete = shortFlags.includes("d") || shortFlags.includes("D") || options.includes("--delete");
    const isForce = shortFlags.includes("D") || shortFlags.includes("f") || options.includes("--force");
    if (!isDelete || !isForce) {
      return null; // branch -d refuses an unmerged branch by itself
    }
    const names = [...beforeValues, ...afterValues];
    return [
      {
        ...base,
        kind: "git-branch-delete",
        label: "git branch -D",
        would: `delete the branch ${names.join(", ")}`,
        names,
        isRemote: shortFlags.includes("r") || options.includes("--remotes"),
        hasUnexpanded,
      },
    ];
  }
  if (sub === "stash") {
    if (beforeValues[0] === "drop") {
      const stash = beforeValues[1] ?? "stash@{0}";
      return [{ ...base, kind: "git-stash-drop", label: "git stash drop", would: `delete ${stash}`, stash }];
    }
    if (beforeValues[0] === "clear") {
      return [{ ...base, kind: "git-stash-clear", label: "git stash clear", would: "delete every stash" }];
    }
    return null;
  }
  if (sub === "reflog" && (beforeValues[0] === "expire" || beforeValues[0] === "delete")) {
    return [
      {
        ...base,
        kind: "git-reflog",
        label: `git reflog ${beforeValues[0]}`,
        would: beforeValues[0] === "expire" ? "expire reflog entries, the record that lets lost commits be found again" : "delete reflog entries",
      },
    ];
  }
  if (sub === "gc" && options.some((option) => option === "--prune" || (option.startsWith("--prune=") && option !== "--prune=never"))) {
    return [{ ...base, kind: "git-prune", label: "git gc --prune", would: "delete unreachable objects for good" }];
  }
  if (sub === "prune" && !options.includes("-n") && !options.includes("--dry-run")) {
    return [{ ...base, kind: "git-prune", label: "git prune", would: "delete unreachable objects for good" }];
  }
  if (sub === "filter-branch" || sub === "filter-repo") {
    return [
      {
        ...base,
        kind: "git-rewrite",
        label: `git ${sub}`,
        would: "rewrite commits in the history",
        notMeasured: "it runs its filters over every commit, and there is no dry run that lists what changes",
      },
    ];
  }
  if (sub === "update-ref" && options.includes("-d")) {
    const ref = beforeValues[0] ?? "";
    return [{ ...base, kind: "git-update-ref-delete", label: "git update-ref -d", would: `delete the ref ${ref}`, ref }];
  }
  return null;
}

// ---- Databases ------------------------------------------------------------

/** The SQL text a client is given on its command line, or null when none is. */
function sqlTextFor(name, args) {
  const values = args.map((word) => word.value);
  const texts = [];
  if (name === "psql") {
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (value === "-c" || value === "--command" || /^-[a-zA-Z]+c$/.test(value)) {
        texts.push(values[index + 1] ?? "");
        index += 1;
      } else if (value.startsWith("--command=")) {
        texts.push(value.slice("--command=".length));
      } else if (/^-c./.test(value)) {
        texts.push(value.slice(2));
      }
    }
  } else if (name === "mysql" || name === "mariadb") {
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (value === "-e" || value === "--execute" || /^-[a-zA-Z]+e$/.test(value)) {
        texts.push(values[index + 1] ?? "");
        index += 1;
      } else if (value.startsWith("--execute=")) {
        texts.push(value.slice("--execute=".length));
      } else if (/^-e./.test(value)) {
        texts.push(value.slice(2));
      }
    }
  } else if (name === "sqlite3") {
    const positional = [];
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (value === "-cmd") {
        texts.push(values[index + 1] ?? "");
        index += 1;
      } else if (["-separator", "-nullvalue", "-init", "-newline"].includes(value)) {
        index += 1;
      } else if (!value.startsWith("-")) {
        positional.push(value);
      }
    }
    texts.push(...positional.slice(1)); // the first is the database file
  } else {
    return null;
  }
  return texts.length > 0 ? texts.join("; ") : null;
}

/** prisma, rails, alembic and Django commands that drop or empty a database, read from the words. */
function databaseCommandRisks(words, dir) {
  const joined = words.map((word) => word.value).join(" ");
  const risk = (label, would) => [{ kind: "database", label, would, dir, notMeasured: DATABASE_REASON }];
  if (/\bprisma\s+migrate\s+reset\b/.test(joined)) {
    return risk("prisma migrate reset", "drop the database and apply every migration again");
  }
  if (/\bprisma\s+db\s+push\b/.test(joined)) {
    const flag = joined.match(/--force-reset|--accept-data-loss/)?.[0];
    if (flag !== undefined) {
      return risk(`prisma db push ${flag}`, flag === "--force-reset" ? "drop every table and create the schema again" : "push a schema change that drops data");
    }
  }
  const railsTask = joined.match(RAILS_DESTRUCTIVE)?.[1];
  if (railsTask !== undefined) {
    return risk(`db:${railsTask}`, RAILS_WOULD[railsTask]);
  }
  if (/\balembic\b.*\bdowngrade\b/.test(joined)) {
    return risk("alembic downgrade", "undo applied migrations");
  }
  const djangoTask = joined.match(/\bmanage\.py\s+(flush|reset_db)\b/)?.[1];
  if (djangoTask !== undefined) {
    return risk(`manage.py ${djangoTask}`, djangoTask === "flush" ? "delete every row in the database" : "drop the database and create it again");
  }
  return null;
}

function databaseRisks(name, words, args, dir, pipedFrom) {
  const fromCommand = databaseCommandRisks(words, dir);
  if (fromCommand !== null) {
    return fromCommand;
  }
  const joined = words.map((word) => word.value).join(" ");
  const sql = sqlTextFor(name, args);
  if (sql !== null) {
    const keyword = sql.match(SQL_DESTRUCTIVE)?.[0];
    if (keyword !== undefined) {
      return [{ kind: "sql", label: `${name} ${keyword.toUpperCase().replace(/\s+/g, " ")}`, would: `run ${shorten(sql, 80)}`, dir, notMeasured: DATABASE_REASON }];
    }
  } else if (SQL_CLIENTS.has(name) && pipedFrom !== null) {
    const keyword = pipedFrom.match(SQL_DESTRUCTIVE)?.[0];
    if (keyword !== undefined) {
      return [
        {
          kind: "sql",
          label: `${name} ${keyword.toUpperCase().replace(/\s+/g, " ")} (piped in)`,
          would: "run the SQL piped in from the command before it",
          dir,
          notMeasured: DATABASE_REASON,
        },
      ];
    }
  }
  // A line that reads as SQL (usually a here-document fed to a client):
  // DROP <object>, TRUNCATE TABLE, DELETE FROM. "Drop support for X" in a
  // commit message names no SQL object, so it is not held.
  const nextWord = args[0]?.value ?? "";
  if (
    (/^drop$/i.test(name) && SQL_OBJECTS.test(nextWord)) ||
    (/^truncate$/i.test(name) && /^table$/i.test(nextWord)) ||
    (/^delete$/i.test(name) && /^from$/i.test(nextWord))
  ) {
    return [
      {
        kind: "sql",
        label: `SQL ${name.toUpperCase()}`,
        would: `run ${shorten(joined, 80)}`,
        dir,
        notMeasured: `${DATABASE_REASON} (this line reads as SQL, usually inside a here-document)`,
      },
    ];
  }
  return null;
}

// ---- Infrastructure -------------------------------------------------------

function infrastructureRisks(name, args, dir) {
  const values = args.map((word) => word.value);
  const hasUnexpanded = args.some(isUnexpanded);
  if (name === "docker" || name === "podman") {
    let index = 0;
    const globalOptions = [];
    while (index < args.length && values[index].startsWith("-")) {
      globalOptions.push(values[index]);
      if (DOCKER_VALUE_OPTIONS.has(values[index]) && index + 1 < args.length) {
        globalOptions.push(values[index + 1]);
        index += 2;
      } else {
        index += 1;
      }
    }
    const sub = values[index];
    const rest = values.slice(index + 1);
    const operands = rest.filter((value) => !value.startsWith("-"));
    const base = { kind: "docker", command: name, dir, globalOptions, hasUnexpanded };
    if (sub === "system" && rest[0] === "prune") {
      const isAll = rest.includes("-a") || rest.includes("--all");
      const hasVolumes = rest.includes("--volumes");
      return [
        {
          ...base,
          scope: "system",
          label: `${name} system prune`,
          would: `remove stopped containers, unused networks, ${isAll ? "every unused image" : "dangling images"} and build cache${hasVolumes ? ", and unused volumes" : ""}`,
        },
      ];
    }
    if ((sub === "volume" || sub === "container") && rest[0] === "prune") {
      return [{ ...base, scope: `${sub}-prune`, label: `${name} ${sub} prune`, would: sub === "volume" ? "delete unused volumes and the data in them" : "remove every stopped container" }];
    }
    if (sub === "rm" || (sub === "container" && (rest[0] === "rm" || rest[0] === "remove"))) {
      const names = sub === "rm" ? operands : operands.slice(1);
      return [{ ...base, scope: "rm", names, label: `${name} rm`, would: `remove the containers ${names.join(", ")}` }];
    }
    if (sub === "volume" && (rest[0] === "rm" || rest[0] === "remove")) {
      const names = operands.slice(1);
      return [{ ...base, scope: "volume-rm", names, label: `${name} volume rm`, would: `delete the volumes ${names.join(", ")} and the data in them` }];
    }
    if (sub === "compose" && rest.includes("down") && rest.some(isVolumesFlag)) {
      return [composeRisk(`${name} compose down -v`, dir)];
    }
    return null;
  }
  if (name === "docker-compose" && values.includes("down") && values.some(isVolumesFlag)) {
    return [composeRisk("docker-compose down -v", dir)];
  }
  if (name === "kubectl" || name === "oc") {
    let index = 0;
    const globalArgs = [];
    while (index < args.length && values[index].startsWith("-")) {
      globalArgs.push(values[index]);
      if (KUBECTL_VALUE_FLAGS.has(values[index]) && index + 1 < args.length) {
        globalArgs.push(values[index + 1]);
        index += 2;
      } else {
        index += 1;
      }
    }
    if (values[index] !== "delete") {
      return null;
    }
    const deleteArgs = values.slice(index + 1);
    return [
      {
        kind: "kubectl-delete",
        command: name,
        label: `${name} delete`,
        would: `delete ${shorten(deleteArgs.join(" "), 60)}`,
        dir,
        globalArgs,
        deleteArgs,
        hasUnexpanded,
      },
    ];
  }
  if (name === "terraform" || name === "tofu") {
    const sub = values.find((value) => !value.startsWith("-"));
    const isDestroy = sub === "destroy" || (sub === "apply" && values.some((value) => value === "-destroy" || value === "--destroy"));
    if (!isDestroy) {
      return null;
    }
    return [
      {
        kind: "terraform-destroy",
        command: name,
        label: `${name} destroy`,
        would: "destroy every resource in the Terraform state",
        dir,
        chdir: values.find((value) => value.startsWith("-chdir=")) ?? null,
      },
    ];
  }
  return null;
}

function isVolumesFlag(value) {
  return value === "-v" || value === "--volumes" || /^-[a-zA-Z]*v[a-zA-Z]*$/.test(value);
}

function composeRisk(label, dir) {
  return {
    kind: "docker",
    scope: "compose-down",
    label,
    would: "stop the compose project and delete its volumes and the data in them",
    dir,
    notMeasured: "Blast Radius does not read compose files to list the volumes",
  };
}

// ---- Migrations -----------------------------------------------------------

function migrationRisks(name, words, dir) {
  const joined = words.map((word) => word.value).join(" ");
  const values = words.slice(1).map((word) => word.value);
  if (/\balembic\s+upgrade\b/.test(joined)) {
    return [{ kind: "migrate", tool: "alembic", label: "alembic upgrade", would: "apply pending migrations", dir }];
  }
  if (/\bdb:migrate(?!:status\b)/.test(joined)) {
    return [{ kind: "migrate", tool: "rails", label: "db:migrate", would: "apply pending migrations", dir }];
  }
  if (/\bprisma\s+migrate\b/.test(joined)) {
    return [{ kind: "migrate", tool: "prisma", label: "prisma migrate", would: "apply pending migrations", dir }];
  }
  if (/\bmanage\.py\s+migrate\b/.test(joined)) {
    return [{ kind: "migrate", tool: "django", label: "manage.py migrate", would: "apply pending migrations", dir }];
  }
  // A git alias or extension (`git m migrate`) may run anything, so it reads like any other command.
  const isGitExtension = name === "git" && !GIT_BUILTINS.has(parseGit(words.slice(1), dir).sub ?? "status");
  if ((!READ_ONLY.has(name) || isGitExtension) && values.includes("migrate")) {
    return [{ kind: "migrate", tool: "unknown", label: "migrate", would: "run migrations", dir }];
  }
  return null;
}

// ---- Verdicts -------------------------------------------------------------

/** `git status --porcelain` lines as `{ index, worktree, path }`. */
export function parsePorcelain(stdout) {
  return String(stdout ?? "")
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => ({ index: line[0], worktree: line[1], path: line.slice(3) }));
}

/**
 * reset --hard, checkout -f, switch -f, checkout <ref> -- <path> and
 * restore --staged --worktree overwrite the index too: staged changes go.
 */
export function isIndexToo(risk) {
  return (
    risk.mode === "reset" ||
    risk.mode === "checkout-force" ||
    risk.mode === "switch-force" ||
    (risk.mode === "checkout-paths" && Boolean(risk.ref)) ||
    (risk.mode === "restore" && risk.isStagedToo === true)
  );
}

/**
 * What a git discard would lose, from its status rows in scope, and whether
 * it would discard nothing at all, so it may run without a hold.
 *
 * @param risk a `git-discard` risk (its mode resolved: no `checkout-ambiguous`)
 * @param rows parsePorcelain rows for the paths in scope
 * @param droppedCommitCount commits a reset to another ref leaves behind; -1 unknown
 * @param overwrite for a ref or --source form: `{ paths }` on disk it would write over, or `{ isUnknown: true }`
 */
export function discardVerdict(risk, rows, droppedCommitCount = 0, overwrite = null) {
  const tracked = rows.filter((row) => row.index !== "?" && row.index !== "!");
  const lost = isIndexToo(risk) ? tracked : tracked.filter((row) => row.worktree !== " ");
  // Taking files from another commit can write over untracked or ignored files
  // of the same name. `overwrite` lists the files on disk the other commit
  // would bring in ({ paths } or { isUnknown }); without it, every untracked row counts.
  const isFromOtherCommit = Boolean(risk.ref) || Boolean(risk.source);
  let untracked = [];
  if (isFromOtherCommit) {
    untracked =
      overwrite === null || overwrite.isUnknown
        ? rows.filter((row) => row.index === "?" || row.index === "!")
        : overwrite.paths.map((path) => ({ index: "?", worktree: "?", path }));
  }
  const isOverwriteUnknown = isFromOtherCommit && overwrite !== null && overwrite.isUnknown === true;
  const isNothingAtStake = lost.length === 0 && untracked.length === 0 && droppedCommitCount === 0 && !isOverwriteUnknown;
  return { lost, untracked, isNothingAtStake, isNothingToDiscard: isNothingAtStake && risk.isQuietBefore === true };
}

/**
 * Whether the measured plan holds. Each risk carries `result.status`
 * ("measured", "not-measured" or "safe") and `result.isNothingToDiscard`.
 * A risk with no result is held.
 */
export function holdVerdict(plan) {
  const risks = plan.parts.flatMap((part) => part.risks);
  const heldRisks = risks.filter((risk) => risk.result?.status !== "safe" && risk.result?.isNothingToDiscard !== true);
  if (heldRisks.length === 0) {
    return { isHeld: false, isAutoPass: risks.some((risk) => risk.result?.isNothingToDiscard === true), heldRisks, label: "", summary: "" };
  }
  const labels = [...new Set(heldRisks.map((risk) => risk.label))];
  return {
    isHeld: true,
    isAutoPass: false,
    heldRisks,
    label: shorten(labels.join(", "), 120),
    summary: heldRisks.map((risk) => risk.result?.summary ?? risk.would).join("; "),
  };
}
