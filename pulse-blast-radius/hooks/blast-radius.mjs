// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
// Modified by MrValraven for pulse-mods (0.3.0): every part of a command line
// is read and measured, new patterns, band notifications, a decision log,
// the nothing-to-discard pass, the measureMigrations setting and the pulse palette.
//
// Blast Radius: holds a risky Bash command and shows what it would change.
//
// tool.call (Bash): classify.mjs reads every part of the command line. If any
// part is risky, each risky part is measured (read-only: list, stat, du, git
// status and diff), and if something is at stake a pane opens with Run command
// and Cancel command, and the call is held until one is pressed.
// ui.render (Pane): draws the report. If the surface won't place the pane (a
// narrow terminal), the same report is drawn in the AbovePrompt band instead,
// with a toast and a notification saying how to reach the buttons.
// command.run: /blast-radius shows the last 50 holds; /blast-radius help lists
// the patterns, settings and keys.
//
// Holding: a hook has 10 s of its own time, but time spent inside a `$` call is
// free (a `$.clock.sleep` is not). So the hold loop waits on a short
// `$.process.run(["sleep", ...])` until a button's onPress sets the decision.
//
// The host reads `on(...)` and `$.noun.method(...)` from source, so they are
// spelled literally, and helpers that take `$` are top-level functions.

import { classify, discardVerdict, hasRisk, holdVerdict, isIndexToo, parsePorcelain, PATTERNS, shorten } from "./classify.mjs";

const PANE_ID = "blast-radius";
const POLL_SECONDS = "0.25";
const HOLD_LIMIT_MS = 10 * 60 * 1000;
const LIST_MAX = 10;
const MEASURE_MAX = 12;
const PARTS_DRAWN_MAX = 200;
const LOG_KEY = "decisions";
const LOG_MAX = 50;

// The pulse palette, the values pulse-cache-tax defines: coral for danger,
// jade for safe, lilac for labels.
const CORAL = "#e8775a";
const JADE = "#4a8c6f";
const LILAC = "#8a72cf";

// The call being held, or null. One at a time: Bash calls in a turn run in order.
let held = null;

export function register(on, options) {
  const settings = { measureMigrations: options?.measureMigrations === "on" ? "on" : "off" };

  on("session.start", async ($, e, next) => {
    try {
      await $.command.register({
        name: "blast-radius",
        description: "Blast Radius: the last 50 held commands and what you decided; help lists what it holds",
        argumentHint: "[help]",
        immediate: true,
      });
    } catch (error) {
      $.ui.log(`Blast Radius could not register /blast-radius: ${errorText(error)}`);
    }
    return next(e);
  });

  on("command.run", { command: "blast-radius" }, async ($, e) => {
    const words = String(e.args ?? "").trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      return { text: await logText($) };
    }
    if (words[0] === "help") {
      return { text: helpText(settings) };
    }
    return { text: `/blast-radius takes no argument, or help. "${words.join(" ")}" is neither: /blast-radius shows the last ${LOG_MAX} holds and /blast-radius help lists what it holds.` };
  });

  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const command = String(e.command ?? "");
    let plan;
    try {
      plan = classify(command);
    } catch (error) {
      plan = unreadablePlan(command, error);
    }
    if (!hasRisk(plan)) {
      return next(e);
    }
    // One hold at a time. If another risky call is already held (a subagent's,
    // say), wait until it is answered. `held` is claimed with no await between
    // the check and the claim, so two waiting calls can't both get through.
    while (held !== null) {
      if (next.signal.aborted) {
        return { deny: "Blast Radius held this command and did not run it: the turn was interrupted. Do not retry it unless the user asks you to." };
      }
      await $.process.run(["sleep", POLL_SECONDS], { timeoutMs: 5000 });
    }
    const mine = { command, plan, verdict: null, decision: null, where: "pane", failure: "" };
    held = mine;

    let opened = { isPlaced: false };
    let hasOpened = false;
    try {
      const sessionCwd = await $.session.cwd();
      await measurePlan($, plan, sessionCwd, settings);
      mine.verdict = holdVerdict(plan);
      if (!mine.verdict.isHeld) {
        mine.decision = mine.verdict.isAutoPass ? "auto" : "clear";
      } else {
        hasOpened = true;
        opened = await $.ui.open({ id: PANE_ID, title: "Blast Radius", focus: true, rows: paneRows(mine) });
        if (!opened.isPlaced) {
          mine.where = "band";
        }
        $.ui.invalidate("ui.render");
        if (mine.where === "band") {
          await announceBand($, mine);
        }
        const startedAt = await $.clock.now();
        while (mine.decision === null) {
          if (next.signal.aborted) {
            mine.decision = "interrupted";
            break;
          }
          if ((await $.clock.now()) - startedAt > HOLD_LIMIT_MS) {
            mine.decision = "timeout";
            break;
          }
          await $.process.run(["sleep", POLL_SECONDS], { timeoutMs: 5000 });
        }
      }
    } catch (error) {
      mine.decision = "error"; // anything unexpected refuses the command
      mine.failure = errorText(error);
    } finally {
      // Close this call's pane before releasing the hold, so the next call's
      // pane can't be the one that gets closed. An unplaced pane is closed too,
      // or it shows up empty later when the terminal grows.
      try {
        if (hasOpened) {
          await $.ui.close({ id: PANE_ID });
        }
      } catch {
        // the pane is already gone
      }
      if (held === mine) {
        held = null;
      }
      $.ui.invalidate("ui.render");
    }

    const decision = mine.decision;
    const label = mine.verdict?.label || "a risky command";
    if (decision === "clear") {
      return next(e); // every risky-looking part turned out to have nothing at stake
    }
    if (decision === "auto") {
      await recordDecision($, mine, "auto");
      const result = await next(e);
      $.ui.toast(`Blast Radius: nothing to discard, ran ${shorten(command, 160)}`);
      return result;
    }
    await recordDecision($, mine, decision);
    if (decision === "proceed") {
      $.ui.toast(`Blast Radius: running ${label}`);
      return next(e);
    }
    if (decision === "cancel") {
      $.ui.toast(`Blast Radius cancelled ${label}; the command did not run`);
    } else if (decision === "timeout") {
      $.ui.toast(`Blast Radius refused ${label} after 10 minutes without an answer`);
    } else if (decision === "interrupted") {
      $.ui.toast(`Blast Radius refused ${label}: the turn was interrupted before you answered`);
    } else {
      $.ui.toast(`Blast Radius refused ${label}: it hit an error while holding it (${mine.failure || "no answer was recorded"})`);
    }
    const why = {
      cancel: "the user pressed Cancel command",
      timeout: "no answer within 10 minutes",
      interrupted: "the turn was interrupted",
      error: `Blast Radius hit an error while holding it (${mine.failure || "no message"})`,
    }[decision] ?? "no answer was recorded";
    const summary = mine.verdict?.summary || label;
    return {
      deny: `Blast Radius held this command and did not run it: ${why}. It would have: ${summary}. Do not retry it unless the user asks you to.`,
    };
  }).catch(($, e, next) => {
    if (next.called) {
      return next(e);
    }
    const cause = next.error?.kind === "timeout" ? "its check ran out of time" : `its check threw: ${String(next.error?.message ?? "no message").split("\n")[0].slice(0, 200)}`;
    return { deny: `Blast Radius did not run this command: ${cause}. Do not retry it unless the user asks you to.` };
  });

  on("ui.render", { component: "Pane" }, ($, e, next) => {
    if (e.requestId !== PANE_ID || held === null || held.verdict?.isHeld !== true) {
      return next(e);
    }
    return draw($.ui.resolve(e), held);
  });

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
    if (held === null || held.verdict?.isHeld !== true || held.where !== "band") {
      return next(e);
    }
    return draw($.ui.resolve(e), held);
  });
}

function unreadablePlan(command, error) {
  return {
    notes: [],
    parts: [
      {
        text: command,
        depth: 0,
        via: "",
        isQuiet: false,
        risks: [
          {
            kind: "unreadable",
            label: "an unreadable command",
            would: "run a command Blast Radius could not read",
            dir: null,
            notMeasured: `Blast Radius could not read this command: ${errorText(error)}`,
          },
        ],
      },
    ],
  };
}

function errorText(error) {
  return String(error?.message ?? error).split("\n")[0].slice(0, 200);
}

/** The band can't take the keys by itself: say how to reach the buttons. */
async function announceBand($, mine) {
  const text = `Blast Radius is holding ${mine.verdict.label}. Click the band above the prompt or press ctrl+x tab, then press 1 to run the command or 2 to cancel it.`;
  $.ui.toast(text, { timeoutMs: 15000 });
  try {
    await $.ui.notify(text, { title: "Blast Radius" });
  } catch (error) {
    $.ui.log(`Blast Radius could not send a notification about the held command: ${errorText(error)}`);
  }
}

// ---- Decision log ---------------------------------------------------------

async function readLog($) {
  const value = await $.store.get(LOG_KEY);
  return Array.isArray(value) ? value.filter((entry) => entry && typeof entry.at === "number" && typeof entry.decision === "string") : [];
}

async function recordDecision($, mine, decision) {
  try {
    const entries = await readLog($);
    entries.push({
      at: await $.clock.now(),
      command: shorten(mine.command, 500),
      label: mine.verdict?.label || "a risky command",
      decision,
    });
    await $.store.set(LOG_KEY, entries.slice(-LOG_MAX));
  } catch (error) {
    $.ui.log(`Blast Radius could not save its decision log: ${errorText(error)}`);
  }
}

function age(milliseconds) {
  const minutes = Math.max(0, Math.round(milliseconds / 60000));
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

async function logText($) {
  let entries;
  try {
    entries = await readLog($);
  } catch (error) {
    return `Blast Radius could not read its decision log: ${errorText(error)}`;
  }
  if (entries.length === 0) {
    return "Blast Radius has not held a command yet. /blast-radius help lists what it holds.";
  }
  const now = await $.clock.now();
  const rows = entries
    .slice()
    .reverse()
    .map((entry) => `  ${age(now - entry.at).padEnd(9)} ${entry.decision.padEnd(12)} ${shorten(entry.label, 28).padEnd(28)}  ${shorten(entry.command, 80)}`);
  return [
    `Blast Radius holds, newest first (the last ${LOG_MAX} are kept):`,
    ...rows,
    "",
    "proceed: you pressed Run command. cancel: you pressed Cancel command. timeout: no answer within 10 minutes, so it was refused.",
    "auto: nothing to discard, so it ran without a hold. interrupted: the turn stopped before you answered. error: Blast Radius failed while holding it.",
  ].join("\n");
}

function helpText(settings) {
  const lines = ["Blast Radius holds a risky Bash command, shows what it would change, and waits for your answer.", "", "What it holds:"];
  for (const group of PATTERNS) {
    lines.push(`${group.family}`);
    for (const line of group.lines) {
      lines.push(`  ${line}`);
    }
  }
  lines.push(
    "",
    "Settings (/config, pulse-blast-radius):",
    `  Measure migrations (measureMigrations): ${settings.measureMigrations} (off or on). off: a held migration says its pending migrations are not listed, because listing them runs your project's code. on: Blast Radius runs the tool's status command (manage.py showmigrations, bin/rails db:migrate:status, alembic history, prisma migrate status) to list them.`,
    "",
    "Keys while a command is held:",
    "  1 runs the command (Run command), 2 refuses it (Cancel command). Cancel command has the focus, so Enter refuses.",
    "  Tab moves between the buttons, and a click presses one.",
    "  In the band above the prompt (a narrow terminal), click the band or press ctrl+x tab first.",
    "  No answer within 10 minutes refuses the command, and so does interrupting the turn with Esc.",
    "",
    "Commands:",
    `  /blast-radius        the last ${LOG_MAX} holds and what you decided`,
    "  /blast-radius help   this list",
  );
  return lines.join("\n");
}

// ---- Measuring the blast radius -------------------------------------------
//
// Every measuring command only reads: bash with find, du, stat-like tests and
// compgen; git status, diff, log, rev-parse, ls-files, stash list, reflog,
// count-objects; docker ps, inspect, df; kubectl get; terraform state list.
// Paths always go in as arguments, so nothing in them runs as shell.
// The one exception is measureMigrations=on, which the person turns on.

function notMeasuredResult(risk, reason) {
  return { status: "not-measured", summary: risk.would, lines: [], more: 0, note: `Not measured: ${reason}.` };
}

function measuredResult(summary, lines = [], total = lines.length, note = "") {
  const shown = lines.slice(0, LIST_MAX);
  return { status: "measured", summary, lines: shown, more: Math.max(0, total - shown.length), note };
}

function safeResult(summary, note = "") {
  return { status: "safe", summary, lines: [], more: 0, note };
}

function plural(count, word, many = `${word}s`) {
  return count === 1 ? word : many;
}

function firstLine(text) {
  return String(text ?? "").trim().split("\n")[0].slice(0, 200);
}

/** Runs a read-only command. `failure` names the exit code and stderr's first line, the time limit, or why it did not start. */
async function runRead($, argv, cwd, timeoutMs = 15000) {
  try {
    const run = await $.process.run(argv, { cwd, timeoutMs });
    const stderrLine = firstLine(run.stderr);
    return {
      ...run,
      failure: run.exitCode === 0 ? null : `exited with code ${run.exitCode}${stderrLine ? `: ${stderrLine}` : ""}`,
    };
  } catch (error) {
    const message = errorText(error);
    const isTimeout = /time|still running|killed/i.test(message);
    return {
      exitCode: -1,
      stdout: "",
      stderr: message,
      failure: isTimeout ? `ran past the ${Math.round(timeoutMs / 1000)} s limit and was stopped (${message})` : `could not start: ${message}`,
    };
  }
}

function gitArgv(risk, ...rest) {
  return ["git", ...(risk.gitOptions ?? []), ...rest];
}

function outputLines(text) {
  return String(text ?? "").split("\n").filter((line) => line.trim() !== "");
}

// Resolves a `cd` target to an absolute folder.
// The target is passed as an argument, so nothing in it runs as shell.
// Prints the folder, or "missing" (exit 3) when nothing is there, or "unreachable" (exit 4).
const CD_SCRIPT = `unset CDPATH; d="$1"; case "$d" in "~") d="$HOME";; "~/"*) d="$HOME/\${d#\\~/}";; esac
if [ ! -e "$d" ] && [ ! -L "$d" ]; then echo missing; exit 3; fi
cd -- "$d" 2>/dev/null && pwd -P || { echo unreachable; exit 4; }`;

/** `{ path }`, `{ isMissing: true }` when nothing is at that folder now, or `{ reason }` when it can't be told. */
async function resolveDir($, sessionCwd, dir) {
  if (dir === "-") {
    return { reason: "cd - depends on the shell's history, so the folder is unknown" };
  }
  if (/[$`*?[]/.test(dir) || /\{[^}]*,[^}]*\}/.test(dir) || /^~[^/]/.test(dir)) {
    return { reason: `the folder ${dir} uses a shell variable, command output, a glob or ~user, which only the shell expands` };
  }
  const run = await runRead($, ["bash", "-c", CD_SCRIPT, "blast-radius", dir], sessionCwd, 5000);
  const out = run.stdout.trim();
  if (run.exitCode === 0 && out !== "") {
    return { path: out };
  }
  if (run.exitCode === 3) {
    return { isMissing: true };
  }
  return { reason: `the folder ${dir} exists but cd into it ${run.failure ?? "printed nothing"}` };
}

/** Measures every risk in the plan, the first MEASURE_MAX of them, in the folder each runs in. */
async function measurePlan($, plan, sessionCwd, settings) {
  const folders = new Map();
  let measuredCount = 0;
  for (const part of plan.parts) {
    for (const risk of part.risks) {
      if (risk.notMeasured !== undefined) {
        risk.result = notMeasuredResult(risk, risk.notMeasured);
        continue;
      }
      if (measuredCount >= MEASURE_MAX) {
        risk.result = notMeasuredResult(risk, `Blast Radius measures the first ${MEASURE_MAX} risky parts of one command line`);
        continue;
      }
      measuredCount += 1;
      let folder = { path: sessionCwd };
      if (risk.dir) {
        if (!folders.has(risk.dir)) {
          folders.set(risk.dir, await resolveDir($, sessionCwd, risk.dir));
        }
        folder = folders.get(risk.dir);
      }
      if (folder.path === undefined) {
        // A folder with nothing there yet holds nothing a conditional part could replace.
        if (folder.isMissing && risk.isDirLinked === false) {
          // `cd missing; mv a b`: the cd fails and the line goes on in the folder before it.
          risk.result = notMeasuredResult(risk, `cd ${risk.dir} would fail, and the line goes on without && so it runs in the folder before it`);
        } else {
          risk.result = folder.isMissing
            ? safeResult(`${risk.would}: the folder ${risk.dir} does not exist yet, so nothing in it is replaced`)
            : notMeasuredResult(risk, folder.reason);
        }
        if (folder.isMissing && !risk.isConditional) {
          risk.result = notMeasuredResult(risk, `the folder ${risk.dir} was not found`);
        }
      } else {
        risk.result = await measure($, risk, folder.path, settings);
      }
      risk.result = requireQuietBefore(risk, risk.result);
    }
  }
}

/**
 * A conditional part counts as safe only when nothing before it on the line
 * (or running beside it) changes files: `mv a b && mv c b` replaces b even
 * though b is missing now. A branch switch stays safe after other changes,
 * unless a git command before it edits refs: after `git branch -m foo foo2`,
 * `git checkout foo` restores the file foo and drops its edits.
 */
function requireQuietBefore(risk, result) {
  if (!risk.isConditional || result.status !== "safe" || risk.isQuietBefore === true) {
    return result;
  }
  if (result.isBranchSwitch && risk.isRefStableBefore === true) {
    return result;
  }
  return {
    status: "measured",
    summary: `${result.summary} now, but earlier parts of the line run first and may change that`,
    lines: [],
    more: 0,
    note: "Held because a part before it, or one running beside it, can change files first.",
  };
}

/** { status, summary, lines, more, note } for one risk. Never throws: a failed read goes in the note. */
async function measure($, risk, cwd, settings) {
  try {
    switch (risk.kind) {
      case "delete":
      case "shred":
      case "permissions":
        return await measureFiles($, risk, cwd);
      case "find":
        return await measureFind($, risk, cwd);
      case "truncate":
        return await measureTruncate($, risk, cwd);
      case "mv":
        return await measureMove($, risk, cwd);
      case "dd":
        return await measureDd($, risk, cwd);
      case "git-discard":
        return await measureDiscard($, risk, cwd);
      case "git-clean":
        return await measureClean($, risk, cwd);
      case "git-push-force":
        return await measurePush($, risk, cwd);
      case "git-push-delete":
        return await measurePushDelete($, risk, cwd);
      case "git-branch-delete":
        return await measureBranchDelete($, risk, cwd);
      case "git-stash-drop":
      case "git-stash-clear":
        return await measureStash($, risk, cwd);
      case "git-reflog":
        return await measureReflog($, risk, cwd);
      case "git-prune":
        return await measureObjects($, risk, cwd);
      case "git-update-ref-delete":
        return await measureRef($, risk, cwd);
      case "migrate":
        return await measureMigrations($, risk, cwd, settings);
      case "docker":
        return await measureDocker($, risk, cwd);
      case "kubectl-delete":
        return await measureKubectl($, risk, cwd);
      case "terraform-destroy":
        return await measureTerraform($, risk, cwd);
      default:
        return notMeasuredResult(risk, `Blast Radius has no measure for ${risk.label}`);
    }
  } catch (error) {
    return notMeasuredResult(risk, `measuring stopped: ${errorText(error)}`);
  }
}

// The paths are passed to bash as arguments, so nothing in them runs as
// shell. compgen -G expands a glob without command substitution.
const RM_SCRIPT = `
shopt -s nullglob dotglob
paths=()
for p in "$@"; do
  case "$p" in "~"|"~/"*) p="$HOME\${p#\\~}";; esac
  if [[ "$p" == *[*?[]* ]]; then
    while IFS= read -r m; do paths+=("$m"); done < <(compgen -G "$p")
  elif [[ -e "$p" || -L "$p" ]]; then
    paths+=("$p")
  fi
done
if (( \${#paths[@]} == 0 )); then echo "0 0 0"; exit 0; fi
# A relative path gets ./ in front, so find never reads a name like -delete as an action.
for i in "\${!paths[@]}"; do case "\${paths[$i]}" in /*) ;; *) paths[$i]="./\${paths[$i]}";; esac; done
files=$(find "\${paths[@]}" \\( -type f -o -type l \\) 2>/dev/null | wc -l | tr -d ' ')
kb=$(du -skc "\${paths[@]}" 2>/dev/null | tail -n1 | cut -f1)
echo "$files $(( \${kb:-0} * 1024 )) \${#paths[@]}"
find "\${paths[@]}" \\( -type f -o -type l \\) 2>/dev/null | head -n ${LIST_MAX}
`;

async function measureFiles($, risk, cwd) {
  if (risk.targets.length === 0) {
    return measuredResult(`${risk.label} names no paths, so it acts on nothing`);
  }
  const expandable = risk.targets.filter((target) => !risk.unexpanded.includes(target));
  if (expandable.length === 0) {
    return notMeasuredResult(risk, `the paths use shell variables or command output (${shorten(risk.unexpanded.join(" "), 80)}), which only the shell expands`);
  }
  const skippedNote =
    risk.unexpanded.length > 0 ? ` ${shorten(risk.unexpanded.join(" "), 80)} uses a shell variable or command output, which only the shell expands, so it is not counted.` : "";
  const run = await runRead($, ["bash", "-c", RM_SCRIPT, "blast-radius", ...expandable], cwd, 15000);
  if (run.failure !== null) {
    return notMeasuredResult(risk, `counting the files ${run.failure}`);
  }
  const [head, ...rest] = outputLines(run.stdout);
  const [files, bytes, found] = (head ?? "0 0 0").split(" ").map(Number);
  const verb = risk.kind === "delete" ? "delete" : risk.kind === "shred" ? (risk.isRemove ? "overwrite and delete" : "overwrite") : `change the ${risk.what} of`;
  const pathsNote = `Paths: ${shorten(risk.targets.join(" "), 200)}.${skippedNote}`;
  if (!found) {
    return measuredResult(`${verb} nothing: no file matches ${shorten(expandable.join(" "), 80)}`, [], 0, `The paths don't exist, so ${risk.label} has nothing to act on.${skippedNote}`);
  }
  if (!files) {
    return measuredResult(`${verb} ${found} ${plural(found, "path")} with no files in ${found === 1 ? "it" : "them"}`, [], 0, pathsNote);
  }
  return measuredResult(
    `${verb} ${files} ${plural(files, "file")} (about ${size(bytes)})`,
    rest.map((line) => line.replace(/^\.\//, "")),
    files,
    pathsNote,
  );
}

// find with the destructive action swapped for -print; awk keeps the first few and counts the rest.
const FIND_SCRIPT = `find "$@" 2>/dev/null | awk -v max=${LIST_MAX} 'NR <= max { print } END { print "#count " NR }'`;

async function measureFind($, risk, cwd) {
  const run = await runRead($, ["bash", "-c", FIND_SCRIPT, "blast-radius", ...risk.dryRunArgs], cwd, 20000);
  if (run.failure !== null) {
    return notMeasuredResult(risk, `the find dry run ${run.failure}`);
  }
  const lines = outputLines(run.stdout);
  const countLine = lines.pop() ?? "#count 0";
  const count = Number(countLine.replace("#count ", "")) || 0;
  const what = risk.isDelete ? "delete" : `run ${risk.innerLabel} on`;
  const note = `From find ${shorten(risk.dryRunArgs.join(" "), 120)}.`;
  if (count === 0) {
    return measuredResult(`${what} nothing: find matches no path`, [], 0, note);
  }
  return measuredResult(`${what} ${count} matching ${plural(count, "path")}`, lines.map((line) => line.replace(/^\.\//, "")), count, note);
}

// What is at a path now: "file <bytes>", "other" (a folder, a device) or "none".
const STAT_SCRIPT = `p="$1"; case "$p" in "~"|"~/"*) p="$HOME\${p#\\~}";; esac
if [ -L "$p" ] && [ ! -e "$p" ]; then echo none
elif [ -f "$p" ]; then printf 'file %s\\n' "$(wc -c < "$p" | tr -d ' ')"
elif [ -e "$p" ]; then echo other
else echo none; fi`;

async function statPath($, path, cwd) {
  const run = await runRead($, ["bash", "-c", STAT_SCRIPT, "blast-radius", path], cwd, 5000);
  if (run.failure !== null) {
    return { failure: run.failure };
  }
  const [kind, bytes] = run.stdout.trim().split(" ");
  return { kind, bytes: Number(bytes) || 0 };
}

async function measureTruncate($, risk, cwd) {
  if (risk.hasUnexpanded) {
    return notMeasuredResult(risk, `the path ${risk.target} uses a shell variable or command output, which only the shell expands`);
  }
  const found = await statPath($, risk.target, cwd);
  if (found.failure) {
    return notMeasuredResult(risk, `checking ${risk.target} ${found.failure}`);
  }
  if (found.kind === "none") {
    return safeResult(`${risk.target} does not exist yet, so nothing is emptied`);
  }
  if (found.kind === "file" && found.bytes === 0) {
    return safeResult(`${risk.target} is already empty`);
  }
  if (found.kind === "file") {
    return measuredResult(`empty ${risk.target} (${size(found.bytes)} now) and write over it`, [], 0, "A > redirect empties the file before the command runs; >> appends to it instead.");
  }
  return measuredResult(`write to ${risk.target}, which is not a regular file`);
}

// Which existing paths mv would replace. Arguments: mode (into, onto or auto), destination, sources.
const MOVE_SCRIPT = `
shopt -s nullglob dotglob
expand() { case "$1" in "~"|"~/"*) printf '%s' "$HOME\${1#\\~}";; *) printf '%s' "$1";; esac; }
mode="$1"; dest=$(expand "$2"); shift 2
into=0
if [ "$mode" = into ] || { [ "$mode" = auto ] && [ -d "$dest" ]; }; then into=1; fi
for source in "$@"; do
  source=$(expand "$source")
  if [[ "$source" == *[*?[]* ]]; then matches=$(compgen -G "$source"); else matches="$source"; fi
  while IFS= read -r match; do
    [ -z "$match" ] && continue
    if [ "$into" = 1 ]; then target="$dest/$(basename -- "$match")"; else target="$dest"; fi
    if [ -e "$target" ] || [ -L "$target" ]; then
      if [ -d "$target" ] && [ ! -L "$target" ]; then echo "folder $target"; else echo "file $target"; fi
    fi
  done <<< "$matches"
done
`;

async function measureMove($, risk, cwd) {
  if (risk.hasUnexpanded) {
    return notMeasuredResult(risk, "a path uses a shell variable or command output, which only the shell expands");
  }
  const run = await runRead($, ["bash", "-c", MOVE_SCRIPT, "blast-radius", risk.mode, risk.destination, ...risk.sources], cwd, 10000);
  if (run.failure !== null) {
    return notMeasuredResult(risk, `checking ${risk.destination} ${run.failure}`);
  }
  const replaced = [...new Set(outputLines(run.stdout))].map((line) => {
    const [kind, ...pathParts] = line.split(" ");
    return `${pathParts.join(" ")}${kind === "folder" ? " (folder)" : ""}`;
  });
  if (replaced.length === 0) {
    return safeResult(`no existing path at ${risk.destination} would be replaced`);
  }
  return measuredResult(
    `replace ${replaced.length} existing ${plural(replaced.length, "path")}`,
    replaced,
    replaced.length,
    risk.hasBackup ? "mv --backup keeps a copy of each replaced file." : "A replaced file can't be recovered.",
  );
}

async function measureDd($, risk, cwd) {
  if (risk.hasUnexpanded) {
    return notMeasuredResult(risk, `the path ${risk.target} uses a shell variable or command output, which only the shell expands`);
  }
  const found = await statPath($, risk.target, cwd);
  if (found.failure) {
    return notMeasuredResult(risk, `checking ${risk.target} ${found.failure}`);
  }
  if (found.kind === "none") {
    return measuredResult(`write a new file ${risk.target}`);
  }
  if (found.kind === "file") {
    return measuredResult(`write over ${risk.target} (${size(found.bytes)} now)`, [], 0, "dd replaces the bytes it writes; what it overwrites can't be recovered.");
  }
  return measuredResult(`write straight to ${risk.target}, a device or other special file`, [], 0, "Writing to a disk device can erase its file systems.");
}

/** `git checkout name`: null when `name` is a branch (a switch keeps changes or refuses), else the paths form. */
async function resolveCheckout($, risk, cwd) {
  const [first, ...others] = risk.candidates;
  const asCommit = await runRead($, gitArgv(risk, "rev-parse", "--verify", "--quiet", `${first}^{commit}`), cwd, 10000);
  if (asCommit.exitCode === 0) {
    return others.length === 0 ? null : { ...risk, mode: "checkout-paths", ref: first, paths: others };
  }
  const tracked = await runRead($, gitArgv(risk, "ls-files", "--", first), cwd, 10000);
  if (others.length === 0 && tracked.stdout.trim() === "") {
    return null; // no file of that name: git makes a branch from a remote one, or refuses
  }
  return { ...risk, mode: "checkout-paths", ref: null, paths: risk.candidates };
}

// Which of the given repo-relative paths exist on disk now. Run from the repo's top folder.
const EXISTS_SCRIPT = `for p in "$@"; do if [ -e "$p" ] || [ -L "$p" ]; then printf '%s\\n' "$p"; fi; done`;

/**
 * Files on disk, untracked or ignored, that taking files from `commit` would
 * write over: the files `commit` has and HEAD lacks, where one exists now.
 * `{ paths }`, or `{ isUnknown: true }` when git could not say.
 */
async function filesWrittenOver($, risk, cwd, commit, paths) {
  if (commit.startsWith("-")) {
    return { isUnknown: true };
  }
  const top = await runRead($, gitArgv(risk, "rev-parse", "--show-toplevel"), cwd, 10000);
  const added = await runRead($, gitArgv(risk, "diff", "--name-only", "--no-renames", "--diff-filter=A", "HEAD", commit, "--", ...paths), cwd, 15000);
  if (top.failure !== null || added.failure !== null) {
    return { isUnknown: true };
  }
  const candidates = outputLines(added.stdout);
  if (candidates.length === 0) {
    return { paths: [] };
  }
  if (candidates.length > 2000) {
    return { isUnknown: true };
  }
  const present = await runRead($, ["bash", "-c", EXISTS_SCRIPT, "blast-radius", ...candidates], top.stdout.trim(), 15000);
  return present.failure === null ? { paths: outputLines(present.stdout) } : { isUnknown: true };
}

async function measureDiscard($, risk, cwd) {
  if (risk.hasUnexpanded) {
    return notMeasuredResult(risk, "a path or ref uses a shell variable or command output, which only the shell expands");
  }
  let resolved = risk;
  if (risk.mode === "checkout-ambiguous") {
    resolved = await resolveCheckout($, risk, cwd);
    if (resolved === null) {
      return { ...safeResult(`switch to ${risk.candidates[0]}; git keeps uncommitted changes or refuses to switch`), isBranchSwitch: true };
    }
  }
  // --untracked-files=all overrides a status.showUntrackedFiles=no in the repo's config.
  const status = await runRead($, gitArgv(risk, "status", "--porcelain", "--untracked-files=all", "--", ...resolved.paths), cwd, 15000);
  if (status.failure !== null) {
    return notMeasuredResult(risk, `git status ${status.failure}`);
  }
  const rows = parsePorcelain(status.stdout);
  let dropped = [];
  let droppedCount = 0;
  if (resolved.mode === "reset" && resolved.ref) {
    const log = await runRead($, gitArgv(risk, "log", "--oneline", "--no-decorate", `${resolved.ref}..HEAD`, "--"), cwd, 15000);
    if (log.failure !== null) {
      droppedCount = -1;
    } else {
      dropped = outputLines(log.stdout);
      droppedCount = dropped.length;
    }
  }
  const otherCommit = resolved.ref || resolved.source;
  const overwrite = otherCommit ? await filesWrittenOver($, risk, cwd, otherCommit, resolved.paths) : null;
  const verdict = discardVerdict(resolved, rows, droppedCount, overwrite);
  if (verdict.isNothingToDiscard) {
    return { ...safeResult("discard nothing: no uncommitted changes"), isNothingToDiscard: true };
  }
  if (verdict.isNothingAtStake) {
    return measuredResult("discard nothing now, but earlier parts of the line run first and may change files before it", [], 0, "From git status --porcelain.");
  }
  const lines = [
    ...verdict.lost.map((row) => `${row.index}${row.worktree} ${row.path}`),
    ...verdict.untracked.map((row) => `?? ${row.path} (untracked, may be written over)`),
    ...dropped.map((line) => `commit ${line} (left behind by the reset)`),
  ];
  const pieces = [];
  if (verdict.lost.length > 0) {
    pieces.push(`discard uncommitted changes in ${verdict.lost.length} ${plural(verdict.lost.length, "file")}`);
  }
  if (verdict.untracked.length > 0) {
    pieces.push(`may write over ${verdict.untracked.length} untracked or ignored ${plural(verdict.untracked.length, "path")}`);
  } else if (overwrite?.isUnknown) {
    pieces.push(`take files from ${otherCommit}, and git could not list which untracked files that writes over`);
  }
  if (droppedCount > 0) {
    pieces.push(`leave ${droppedCount} ${plural(droppedCount, "commit")} behind on the branch`);
  } else if (droppedCount === -1) {
    pieces.push(`move the branch to ${resolved.ref}, which git log could not compare with HEAD`);
  }
  const stat = await runRead($, gitArgv(risk, "diff", "--shortstat", ...(isIndexToo(resolved) ? ["HEAD"] : []), "--", ...resolved.paths), cwd, 15000);
  const shortstat = stat.failure === null ? stat.stdout.trim() : "";
  return measuredResult(
    pieces.join(", "),
    lines,
    lines.length,
    shortstat !== "" ? `${shortstat}. Uncommitted changes can't be recovered.` : "From git status --porcelain. Uncommitted changes can't be recovered.",
  );
}

async function measureClean($, risk, cwd) {
  const flags = [];
  const paths = [];
  for (let i = 0; i < risk.args.length; i += 1) {
    const a = risk.args[i];
    if (a === "--") {
      paths.push(...risk.args.slice(i + 1));
      break;
    }
    if (a === "-e" || a === "--exclude") {
      flags.push(a, risk.args[i + 1] ?? "");
      i += 1;
    } else if (a.startsWith("--exclude=") || /^-e./.test(a)) {
      flags.push(a);
    } else if (/^-[a-zA-Z]+$/.test(a)) {
      const kept = a.replace(/[finq]/g, ""); // -n is added below; -f, -i and -q would change the dry run
      if (kept !== "-") {
        flags.push(kept);
      }
    } else if (!a.startsWith("-")) {
      paths.push(a);
    }
  }
  const run = await runRead($, gitArgv(risk, "clean", "-n", ...flags, "--", ...paths), cwd, 15000);
  if (run.failure !== null) {
    return notMeasuredResult(risk, `the dry run git clean -n ${run.failure}`);
  }
  const gone = run.stdout.split("\n").filter((l) => l.startsWith("Would remove ")).map((l) => l.slice(13));
  return measuredResult(
    gone.length === 0 ? "remove nothing: no untracked files match" : `remove ${gone.length} untracked ${plural(gone.length, "path")}`,
    gone,
    gone.length,
    "From git clean -n. Untracked files are not in git, so they can't be recovered.",
  );
}

async function measurePush($, risk, cwd) {
  const positional = risk.args.filter((a) => !a.startsWith("-"));
  const remote = positional[0] ?? "origin";
  // A refspec is src:dst. With no colon, the local branch of the same name is pushed.
  const spec = (positional[1] ?? "").replace(/^\+/, "");
  let [source, branch] = spec.includes(":") ? spec.split(":") : [spec, spec];
  branch = (branch ?? "").replace(/^refs\/heads\//, "");
  if (!branch || branch === "HEAD") {
    // `git push origin HEAD`, or no refspec: the current branch to its namesake.
    const head = await runRead($, gitArgv(risk, "rev-parse", "--abbrev-ref", "HEAD"), cwd, 10000);
    branch = head.stdout.trim();
    source = "HEAD";
  }
  source = source || "HEAD";
  if (source.startsWith("-") || branch.startsWith("-") || remote.startsWith("-")) {
    // git would read a name starting with - as an option, so it is never passed on.
    return notMeasuredResult(risk, `the refspec ${shorten(spec, 60)} starts with -, which git would read as an option`);
  }
  const ref = `${remote}/${branch}`;
  const known = await runRead($, gitArgv(risk, "rev-parse", "--verify", "--quiet", ref), cwd, 10000);
  if (known.exitCode !== 0) {
    return measuredResult(`force-push to ${ref}`, [], 0, `No local copy of ${ref}, so the commits the push would drop can't be listed. Run git fetch first.`);
  }
  const log = await runRead($, gitArgv(risk, "log", "--oneline", "--no-decorate", `${source}..${ref}`, "--"), cwd, 15000);
  if (log.failure !== null) {
    return notMeasuredResult(risk, `git log ${source}..${ref} ${log.failure}`);
  }
  const dropped = outputLines(log.stdout);
  return measuredResult(
    dropped.length === 0 ? `force-push to ${ref}: drops no commits` : `force-push to ${ref}: drops ${dropped.length} ${plural(dropped.length, "commit")}`,
    dropped,
    dropped.length,
    `Commits on ${ref} that ${source} doesn't have, as of the last fetch.`,
  );
}

async function measurePushDelete($, risk, cwd) {
  if (risk.branches.length === 0) {
    return notMeasuredResult(risk, "the command names no branch to delete");
  }
  const lines = [];
  let onlyThere = 0;
  for (const name of risk.branches.slice(0, 5)) {
    const ref = `${risk.remote}/${name.replace(/^refs\/heads\//, "")}`;
    const known = await runRead($, gitArgv(risk, "rev-parse", "--verify", "--quiet", ref), cwd, 10000);
    if (known.exitCode !== 0) {
      lines.push(`${ref}: no local copy; git fetch would show its commits`);
      continue;
    }
    const log = await runRead($, gitArgv(risk, "log", "--oneline", "--no-decorate", ref, "--not", "--branches", "--tags", "--"), cwd, 15000);
    const commits = log.failure === null ? outputLines(log.stdout) : [];
    onlyThere += commits.length;
    lines.push(`${ref}: ${log.failure === null ? `${commits.length} ${plural(commits.length, "commit")} on no local branch` : `git log ${log.failure}`}`);
    lines.push(...commits.slice(0, 3).map((line) => `  ${line}`));
  }
  const count = risk.branches.length;
  return measuredResult(
    `delete ${count} ${plural(count, "branch", "branches")} on ${risk.remote}${onlyThere > 0 ? `; ${onlyThere} of their commits are on no local branch` : ""}`,
    lines,
    lines.length,
    "As of the last fetch. Commits only on a deleted remote branch are gone for everyone once the remote prunes them.",
  );
}

async function measureBranchDelete($, risk, cwd) {
  if (risk.hasUnexpanded) {
    return notMeasuredResult(risk, "a branch name uses a shell variable or command output, which only the shell expands");
  }
  const lines = [];
  let unique = 0;
  for (const name of risk.names.slice(0, 5)) {
    const fullRef = risk.isRemote ? `refs/remotes/${name}` : `refs/heads/${name}`;
    const known = await runRead($, gitArgv(risk, "rev-parse", "--verify", "--quiet", fullRef), cwd, 10000);
    if (known.exitCode !== 0) {
      lines.push(`${name}: no such branch here`);
      continue;
    }
    // Commits on this branch and on no other branch, remote or tag.
    const exclusions = risk.isRemote ? ["--branches", `--exclude=${name}`, "--remotes"] : [`--exclude=${name}`, "--branches", "--remotes"];
    const log = await runRead($, gitArgv(risk, "log", "--oneline", "--no-decorate", fullRef, "--not", ...exclusions, "--tags", "--"), cwd, 15000);
    if (log.failure !== null) {
      lines.push(`${name}: git log ${log.failure}`);
      continue;
    }
    const commits = outputLines(log.stdout);
    unique += commits.length;
    lines.push(`${name}: ${commits.length} ${plural(commits.length, "commit")} on no other branch`);
    lines.push(...commits.slice(0, 3).map((line) => `  ${line}`));
  }
  const count = risk.names.length;
  return measuredResult(
    `delete ${count} ${plural(count, "branch", "branches")}${unique > 0 ? `; ${unique} ${plural(unique, "commit")} on no other branch or remote` : "; every commit is on another branch or remote"}`,
    lines,
    lines.length,
    "A deleted branch's commits can be found in git reflog for a while.",
  );
}

async function measureStash($, risk, cwd) {
  const list = await runRead($, gitArgv(risk, "stash", "list"), cwd, 10000);
  if (list.failure !== null) {
    return notMeasuredResult(risk, `git stash list ${list.failure}`);
  }
  const stashes = outputLines(list.stdout);
  const note = "A dropped stash can only be found again by its commit hash, with git fsck --unreachable.";
  if (risk.kind === "git-stash-clear") {
    return measuredResult(
      stashes.length === 0 ? "delete nothing: there are no stashes" : `delete ${stashes.length} ${plural(stashes.length, "stash", "stashes")}`,
      stashes,
      stashes.length,
      note,
    );
  }
  const stash = /^\d+$/.test(risk.stash) ? `stash@{${risk.stash}}` : risk.stash;
  const entry = stashes.find((line) => line.startsWith(`${stash}:`));
  if (entry === undefined) {
    return measuredResult(`delete ${stash}, which git stash list does not show`, [], 0, note);
  }
  const show = await runRead($, gitArgv(risk, "stash", "show", "--stat", stash), cwd, 10000);
  const statLines = show.failure === null ? outputLines(show.stdout) : [];
  return measuredResult(`delete ${shorten(entry, 100)}`, statLines, statLines.length, note);
}

async function measureReflog($, risk, cwd) {
  const run = await runRead($, gitArgv(risk, "reflog", "show", "--format=%h", "HEAD", "--"), cwd, 10000);
  if (run.failure !== null) {
    return notMeasuredResult(risk, `git reflog ${run.failure}`);
  }
  const count = outputLines(run.stdout).length;
  return measuredResult(
    `${risk.would}; HEAD's reflog has ${count} ${plural(count, "entry", "entries")} now`,
    [],
    0,
    "Commits that only the reflog remembers can't be recovered once their entries are gone and git gc runs.",
  );
}

async function measureObjects($, risk, cwd) {
  const run = await runRead($, gitArgv(risk, "count-objects", "-v"), cwd, 15000);
  if (run.failure !== null) {
    return notMeasuredResult(risk, `git count-objects ${run.failure}`);
  }
  const fields = Object.fromEntries(outputLines(run.stdout).map((line) => line.split(": ")));
  const loose = Number(fields.count) || 0;
  const kib = Number(fields.size) || 0;
  return measuredResult(
    `delete unreachable objects; the repo has ${loose} loose ${plural(loose, "object")} (${size(kib * 1024)})`,
    [],
    0,
    "Unreachable commits, such as ones only the reflog remembered, can't be recovered after this.",
  );
}

async function measureRef($, risk, cwd) {
  const known = await runRead($, gitArgv(risk, "rev-parse", "--verify", "--quiet", risk.ref), cwd, 10000);
  if (known.exitCode !== 0) {
    return measuredResult(`delete ${risk.ref}, which does not exist here`);
  }
  const log = await runRead($, gitArgv(risk, "log", "-1", "--oneline", "--no-decorate", risk.ref, "--"), cwd, 10000);
  return measuredResult(
    `delete ${risk.ref}, now at ${log.failure === null ? shorten(log.stdout.trim(), 80) : known.stdout.trim().slice(0, 12)}`,
    [],
    0,
    "The commit stays reachable only through other refs or the reflog.",
  );
}

const MIGRATION_LISTERS = {
  django: { argv: ["python3", "manage.py", "showmigrations", "--plan"], pending: (l) => l.startsWith("[ ]"), strip: (l) => l.slice(4) },
  alembic: { argv: ["alembic", "history", "-r", "current:head"], pending: (l) => l.includes("->"), strip: (l) => l },
  rails: { argv: ["bin/rails", "db:migrate:status"], pending: (l) => /^\s*down\b/.test(l), strip: (l) => l.trim() },
  prisma: { argv: ["npx", "--no-install", "prisma", "migrate", "status"], pending: (l) => /^\s{2}\S/.test(l), strip: (l) => l.trim() },
};

async function measureMigrations($, risk, cwd, settings) {
  const lister = MIGRATION_LISTERS[risk.tool];
  if (lister === undefined) {
    return notMeasuredResult(risk, "Blast Radius can't list the pending migrations for this tool");
  }
  if (settings.measureMigrations !== "on") {
    return {
      status: "not-measured",
      summary: `run ${risk.label}`,
      lines: [],
      more: 0,
      note: `Pending migrations are not listed, because listing them runs your project's code (${lister.argv.join(" ")}). Set measureMigrations to on in /config to list them.`,
    };
  }
  const run = await runRead($, lister.argv, cwd, 20000);
  if (run.failure !== null) {
    return {
      status: "not-measured",
      summary: `run ${risk.label}`,
      lines: [],
      more: 0,
      note: `Couldn't list pending migrations: ${lister.argv.join(" ")} ${run.failure}.`,
    };
  }
  const pending = run.stdout.split("\n").filter(lister.pending).map(lister.strip);
  return measuredResult(
    pending.length === 0 ? `run ${risk.label}: nothing pending` : `apply ${pending.length} pending ${plural(pending.length, "migration")}`,
    pending,
    pending.length,
    `From ${lister.argv.join(" ")}.`,
  );
}

async function measureDocker($, risk, cwd) {
  if (risk.hasUnexpanded) {
    return notMeasuredResult(risk, "a name uses a shell variable or command output, which only the shell expands");
  }
  const docker = [risk.command, ...risk.globalOptions];
  let argv;
  let describe;
  if (risk.scope === "system") {
    argv = [...docker, "system", "df"];
    describe = () => risk.would;
  } else if (risk.scope === "volume-prune") {
    argv = [...docker, "volume", "ls", "--filter", "dangling=true", "--format", "{{.Name}}"];
    describe = (count) => `delete ${count} unused ${plural(count, "volume")} and the data in them`;
  } else if (risk.scope === "container-prune") {
    argv = [...docker, "ps", "-a", "--filter", "status=exited", "--filter", "status=created", "--format", "{{.Names}}  {{.Status}}"];
    describe = (count) => `remove ${count} stopped ${plural(count, "container")}`;
  } else if (risk.scope === "rm") {
    if (risk.names.length === 0) {
      return notMeasuredResult(risk, "the command names no container");
    }
    argv = [...docker, "inspect", "--format", "{{.Name}}  {{.State.Status}}  {{.Config.Image}}", ...risk.names];
    describe = () => `remove ${risk.names.length} ${plural(risk.names.length, "container")}`;
  } else if (risk.scope === "volume-rm") {
    if (risk.names.length === 0) {
      return notMeasuredResult(risk, "the command names no volume");
    }
    argv = [...docker, "volume", "inspect", "--format", "{{.Name}}  {{.Mountpoint}}", ...risk.names];
    describe = () => `delete ${risk.names.length} ${plural(risk.names.length, "volume")} and the data in them`;
  } else {
    return notMeasuredResult(risk, `Blast Radius has no measure for ${risk.label}`);
  }
  const run = await runRead($, argv, cwd, 15000);
  if (run.failure !== null) {
    return notMeasuredResult(risk, `${argv.slice(0, 3).join(" ")} ${run.failure}`);
  }
  const lines = outputLines(run.stdout);
  return measuredResult(describe(lines.length), lines, lines.length, `From ${shorten(argv.join(" "), 100)}.`);
}

const KUBECTL_KEPT_WITH_VALUE = new Set(["-n", "--namespace", "-l", "--selector", "-f", "--filename", "--field-selector", "--context"]);
const KUBECTL_KEPT_ALONE = new Set(["-A", "--all-namespaces", "-R", "--recursive"]);

async function measureKubectl($, risk, cwd) {
  if (risk.hasUnexpanded) {
    return notMeasuredResult(risk, "an argument uses a shell variable or command output, which only the shell expands");
  }
  // The same resources, read with get: names and selectors kept, delete-only flags dropped.
  const getArgs = [];
  for (let index = 0; index < risk.deleteArgs.length; index += 1) {
    const value = risk.deleteArgs[index];
    if (KUBECTL_KEPT_WITH_VALUE.has(value)) {
      getArgs.push(value, risk.deleteArgs[index + 1] ?? "");
      index += 1;
    } else if (KUBECTL_KEPT_ALONE.has(value) || [...KUBECTL_KEPT_WITH_VALUE].some((flag) => flag.startsWith("--") && value.startsWith(`${flag}=`))) {
      getArgs.push(value);
    } else if (!value.startsWith("-")) {
      getArgs.push(value);
    }
  }
  const argv = [risk.command, ...risk.globalArgs, "get", ...getArgs, "-o", "name"];
  const run = await runRead($, argv, cwd, 20000);
  if (run.failure !== null) {
    return notMeasuredResult(risk, `${risk.command} get ${run.failure}`);
  }
  const lines = outputLines(run.stdout);
  return measuredResult(`delete ${lines.length} ${plural(lines.length, "resource")}`, lines, lines.length, `From ${shorten(argv.join(" "), 100)}.`);
}

async function measureTerraform($, risk, cwd) {
  const argv = [risk.command, ...(risk.chdir ? [risk.chdir] : []), "state", "list"];
  const run = await runRead($, argv, cwd, 30000);
  if (run.failure !== null) {
    return notMeasuredResult(risk, `${argv.join(" ")} ${run.failure}`);
  }
  const lines = outputLines(run.stdout);
  return measuredResult(`destroy ${lines.length} ${plural(lines.length, "resource")} in the state`, lines, lines.length, `From ${argv.join(" ")}.`);
}

function size(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${bytes || 0} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = -1;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

// ---- Drawing --------------------------------------------------------------

function partsToDraw(plan) {
  return plan.parts.map((part, index) => ({ part, index })).filter(({ part, index }) => index < PARTS_DRAWN_MAX || part.risks.length > 0);
}

function paneRows(state) {
  const riskRows = state.plan.parts.reduce((total, part) => total + part.risks.reduce((sum, risk) => sum + 2 + (risk.result?.lines.length ?? 0), 0), 0);
  return Math.min(24, 10 + partsToDraw(state.plan).length + riskRows);
}

function statusWord(result) {
  if (result === undefined || result.status === "not-measured") {
    return "not measured";
  }
  return result.status === "safe" ? "safe" : "at stake";
}

function draw(elements, state) {
  const { Box, Text, Button } = elements;
  const { plan, verdict } = state;
  // The buttons answer the call this pane was drawn for, even if another is held by now.
  const decide = (choice) => () => {
    if (state.decision === null) {
      state.decision = choice;
    }
  };
  const isBand = state.where === "band";

  const partRows = [];
  const drawn = partsToDraw(plan);
  for (const { part, index } of drawn) {
    const indent = "  ".repeat(part.depth);
    const isPartHeld = part.risks.some((risk) => verdict.heldRisks.includes(risk));
    partRows.push(
      Text({
        mono: true,
        key: `part-${index}`,
        wrap: "wrap",
        children: [
          Text({ mono: true, bold: true, color: isPartHeld ? CORAL : JADE, children: isPartHeld ? "held " : "safe " }),
          Text({ mono: true, children: ` ${indent}${part.text}` }),
          ...(part.via ? [Text({ mono: true, dimColor: true, children: `  (in ${part.via})` })] : []),
        ],
      }),
    );
    part.risks.forEach((risk, riskIndex) => {
      const result = risk.result;
      const word = statusWord(result);
      const pad = `      ${indent}`;
      partRows.push(
        Text({
          mono: true,
          key: `risk-${index}-${riskIndex}`,
          wrap: "wrap",
          children: [
            Text({ mono: true, color: word === "safe" ? JADE : word === "at stake" ? CORAL : LILAC, children: `${pad}${word}: ` }),
            Text({ mono: true, children: `${risk.label}: ${result?.summary ?? risk.would}` }),
          ],
        }),
      );
      (result?.lines ?? []).forEach((line, lineIndex) => {
        partRows.push(Text({ mono: true, key: `line-${index}-${riskIndex}-${lineIndex}`, dimColor: true, wrap: "truncate-end", children: `${pad}  ${line}` }));
      });
      if (result?.more) {
        partRows.push(Text({ mono: true, key: `more-${index}-${riskIndex}`, dimColor: true, children: `${pad}  + ${result.more} more` }));
      }
      if (result?.note) {
        partRows.push(Text({ mono: true, key: `note-${index}-${riskIndex}`, dimColor: true, italic: true, wrap: "wrap", children: `${pad}  ${result.note}` }));
      }
    });
  }
  const hiddenCount = plan.parts.length - drawn.length;
  if (hiddenCount > 0) {
    partRows.push(Text({ mono: true, key: "parts-hidden", dimColor: true, children: `+ ${hiddenCount} more safe ${plural(hiddenCount, "part")} not listed` }));
  }
  const heldCount = plan.parts.filter((part) => part.risks.some((risk) => verdict.heldRisks.includes(risk))).length;

  return Box({
    flexDirection: "column",
    borderStyle: "round",
    borderColor: CORAL,
    paddingX: 1,
    children: [
      Text({
        mono: true,
        key: "title",
        wrap: "wrap",
        children: [Text({ mono: true, bold: true, color: CORAL, children: "Held" }), Text({ mono: true, bold: true, children: `  ${verdict.label}` })],
      }),
      Text({
        mono: true,
        key: "would",
        wrap: "wrap",
        children: [Text({ mono: true, color: LILAC, children: "Would    " }), Text({ mono: true, color: CORAL, bold: true, children: verdict.summary })],
      }),
      // The buttons come before the long lists, so a short terminal still shows them.
      Box({
        key: "buttons",
        marginTop: 1,
        gap: 2,
        flexWrap: "wrap",
        children: [
          Button({ key: "proceed", label: "Run command", hotkey: "1", plain: true, onPress: decide("proceed") }),
          Button({ key: "cancel", label: "Cancel command", hotkey: "2", plain: true, autoFocus: true, onPress: decide("cancel") }),
          ...(isBand ? [] : [Text({ mono: true, key: "hint", dimColor: true, children: "Claude is waiting on your answer" })]),
        ],
      }),
      // In the band the hint is long, so it gets a row of its own below the buttons.
      ...(isBand ? [Text({ mono: true, key: "hint", dimColor: true, wrap: "wrap", children: "Claude is waiting: click here or press ctrl+x tab, then 1 or 2" })] : []),
      Box({
        key: "command",
        marginTop: 1,
        flexDirection: "column",
        children: [Text({ mono: true, key: "command-label", color: LILAC, children: "Command" }), Text({ mono: true, key: "command-text", bold: true, wrap: "wrap", children: state.command })],
      }),
      Box({
        key: "parts",
        marginTop: 1,
        flexDirection: "column",
        children: [
          Text({
            mono: true,
            key: "parts-label",
            color: LILAC,
            children: plan.parts.length === 1 ? "1 part" : `${plan.parts.length} parts, ${heldCount} held`,
          }),
          ...partRows,
        ],
      }),
      ...plan.notes.map((note, index) => Text({ mono: true, key: `plan-note-${index}`, dimColor: true, italic: true, wrap: "wrap", children: note })),
    ],
  });
}
