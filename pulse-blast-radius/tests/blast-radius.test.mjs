// Tests for Blast Radius's splitter and classifier, in node:test style:
//   node --test pulse-blast-radius/tests/
// They import the pure modules directly; nothing here needs Claude Code.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { naiveSplit, splitCommand, tokenize } from "../hooks/split.mjs";
import { classify, discardVerdict, holdVerdict, parsePorcelain, PATTERNS } from "../hooks/classify.mjs";

const risksOf = (command) => classify(command).parts.flatMap((part) => part.risks);
const kindsOf = (command) => risksOf(command).map((risk) => risk.kind);
const firstRisk = (command) => risksOf(command)[0];

function assertHeld(command, kind) {
  const kinds = kindsOf(command);
  assert.ok(kinds.includes(kind), `${JSON.stringify(command)} should be held as ${kind}; it was read as [${kinds.join(", ")}]`);
}

function assertClear(command) {
  assert.deepEqual(kindsOf(command), [], `${JSON.stringify(command)} should run without a hold`);
}

describe("splitCommand", () => {
  it("splits on ; && || | & and newlines", () => {
    const { segments } = splitCommand("a && b || c | d; e & f\ng");
    assert.deepEqual(
      segments.map((segment) => segment.text),
      ["a", "b", "c", "d", "e", "f", "g"],
    );
    assert.deepEqual(
      segments.map((segment) => segment.separatorBefore),
      [null, "&&", "||", "|", ";", "&", "\n"],
    );
  });

  it("does not split inside quotes or after a backslash", () => {
    assert.equal(splitCommand(`echo "a;b && c" 'd|e' f\\;g`).segments.length, 1);
  });

  it("keeps redirects with & in one segment", () => {
    assert.deepEqual(
      splitCommand("ls 2>&1 | wc -l; make &>build.log").segments.map((segment) => segment.text),
      ["ls 2>&1", "wc -l", "make &>build.log"],
    );
  });

  it("hands back $( ), backticks and process substitution as commands", () => {
    const { substitutions } = splitCommand('echo "$(rm -rf a)" `rm -rf b` <(rm -rf c)');
    assert.deepEqual(
      substitutions.map((substitution) => substitution.script),
      ["rm -rf a", "rm -rf b", "rm -rf c"],
    );
  });

  it("reads here-document bodies apart from the command line", () => {
    const { segments, heredocs } = splitCommand("cat <<'EOF' > notes.txt\nit's; fine\nEOF\nls");
    assert.deepEqual(
      segments.map((segment) => segment.text),
      ["cat <<'EOF' > notes.txt", "ls"],
    );
    assert.equal(heredocs[0].script, "it's; fine");
  });

  it("skips comments, so an apostrophe in one opens no quote", () => {
    const { segments, isUnbalanced } = splitCommand("# don't do this\nrm -rf build");
    assert.deepEqual(
      segments.map((segment) => segment.text),
      ["rm -rf build"],
    );
    assert.equal(isUnbalanced, false);
  });

  it("flags a quote that never closes", () => {
    assert.equal(splitCommand("echo 'oops; rm -rf build").isUnbalanced, true);
    assert.deepEqual(naiveSplit("echo 'oops; rm -rf build"), ["echo  oops", "rm -rf build"]);
  });
});

describe("tokenize", () => {
  it("honours quotes and escapes", () => {
    const { words } = tokenize(`rm -rf "my dir" 'x y' z\\ w`);
    assert.deepEqual(
      words.map((word) => word.value),
      ["rm", "-rf", "my dir", "x y", "z w"],
    );
  });

  it("reads redirects and their targets", () => {
    const { words, redirects } = tokenize("echo hi>out.txt 2>&1 >>log");
    assert.deepEqual(
      words.map((word) => word.value),
      ["echo", "hi"],
    );
    assert.deepEqual(
      redirects.map((redirect) => [redirect.operator, redirect.fd, redirect.target]),
      [
        [">", null, "out.txt"],
        [">&", "2", "1"],
        [">>", null, "log"],
      ],
    );
  });

  it("marks words only the shell can expand", () => {
    const { words } = tokenize('rm "$DIR"/x $(pwd) plain');
    assert.deepEqual(
      words.map((word) => word.hasExpansion),
      [false, true, true, false],
    );
  });
});

describe("quotes are data", () => {
  it("does not hold a commit message holding a separator", () => {
    assertClear('git commit -m "; rm -rf x"');
    assertClear("git commit -m 'fix && git reset --hard'");
  });

  it("does not hold echo or grep text", () => {
    assertClear('echo "a; rm -rf b"');
    assertClear('grep -r "rm -rf" .');
    assertClear("echo hi \\; rm -rf x");
  });

  it("does not hold a comment", () => {
    assertClear("ls # ; rm -rf x");
  });

  it("still holds the command after a closed quote", () => {
    assertHeld('echo "a" && rm -rf b', "delete");
    assertHeld("echo a; rm -rf b", "delete");
  });

  it("holds after a comment with an apostrophe", () => {
    assertHeld("# don't\nrm -rf build", "delete");
  });

  it("holds what an unclosed quote would hide", () => {
    assertHeld("echo 'oops; rm -rf build", "delete");
  });

  it("holds a command substitution inside double quotes", () => {
    assertHeld('echo "$(rm -rf build)"', "delete");
    assertHeld("echo `rm -rf build`", "delete");
  });

  it("reads a commit message from a here-document in $( ) as text with an apostrophe", () => {
    assertClear("git commit -m \"$(cat <<'EOF'\nDon't drop support for node 16\nEOF\n)\"");
  });
});

describe("files", () => {
  it("rm with or without flags", () => {
    assert.equal(firstRisk("rm notes.txt").label, "rm");
    assert.equal(firstRisk("rm -rf build").label, "rm -rf");
    assert.deepEqual(firstRisk("rm -rf build dist").targets, ["build", "dist"]);
    assertHeld("\\rm -f x", "delete");
    assertHeld("/bin/rm x", "delete");
  });

  it("rmdir and unlink", () => {
    assertHeld("rmdir empty", "delete");
    assertHeld("unlink link", "delete");
  });

  it("shred", () => {
    assert.equal(firstRisk("shred -u secrets.txt").isRemove, true);
    assert.equal(firstRisk("shred secrets.txt").isRemove, false);
  });

  it("find -delete and find -exec rm, with a dry run", () => {
    const deleting = firstRisk("find . -name '*.log' -delete");
    assert.equal(deleting.kind, "find");
    assert.deepEqual(deleting.dryRunArgs, [".", "-name", "*.log", "-print"]);
    const executing = firstRisk("find . -type f -exec rm {} \\;");
    assert.equal(executing.label, "find -exec rm");
    assert.deepEqual(executing.dryRunArgs, [".", "-type", "f", "-print"]);
    assertHeld("find . -exec rm -rf {} +", "find");
  });

  it("find with another action is held without a dry run", () => {
    assert.ok(firstRisk("find . -name x -exec grep -q y {} \\; -delete").notMeasured);
    assertClear("find . -name x -print");
    assertClear("find . -exec grep -l TODO {} +");
  });

  it("xargs rm is held, unmeasured", () => {
    const risk = firstRisk("ls *.tmp | xargs rm");
    assert.equal(risk.kind, "delete");
    assert.ok(risk.notMeasured.includes("xargs"));
    assertHeld("find . -name x | xargs -0 rm -f", "delete");
  });

  it("> on a file is a conditional hold; >> and fd redirects are not", () => {
    const risk = firstRisk("echo hi > notes.txt");
    assert.equal(risk.kind, "truncate");
    assert.equal(risk.target, "notes.txt");
    assert.equal(risk.isConditional, true);
    assertHeld("make >| build.log", "truncate");
    assertHeld("make &> build.log", "truncate");
    assertHeld("ls >&out.log", "truncate");
    assertClear("echo hi >> notes.txt");
    assertClear("make 2>/dev/null");
    assertClear("ls >&2");
  });

  it("mv is a conditional hold unless it never replaces", () => {
    const risk = firstRisk("mv a.txt b.txt");
    assert.equal(risk.kind, "mv");
    assert.equal(risk.destination, "b.txt");
    assert.deepEqual(risk.sources, ["a.txt"]);
    assert.equal(risk.mode, "auto");
    assert.equal(risk.isConditional, true);
    assert.equal(firstRisk("mv -t dest a b").mode, "into");
    assert.equal(firstRisk("mv -T a b").mode, "onto");
    assertClear("mv -n a b");
    assertClear("mv --no-clobber a b");
    assertHeld("mv -n -f a b", "mv");
  });

  it("dd of=", () => {
    assert.equal(firstRisk("dd if=/dev/zero of=disk.img bs=1m count=1").target, "disk.img");
    assertClear("dd if=disk.img");
  });

  it("mkfs", () => {
    assertHeld("mkfs.ext4 /dev/sdb1", "format");
    assertHeld("sudo mkfs -t ext4 /dev/sdb1", "format");
  });

  it("chmod -R and chown -R", () => {
    assert.deepEqual(firstRisk("chmod -R 755 public").targets, ["public"]);
    assertHeld("chown -R me:staff dir", "permissions");
    assertHeld("chgrp --recursive staff dir", "permissions");
    assertClear("chmod 644 file");
  });
});

describe("git", () => {
  it("keeps the holds it had", () => {
    assertHeld("git reset --hard", "git-discard");
    assertHeld("git clean -fdx", "git-clean");
    assertHeld("git push -f", "git-push-force");
    assertHeld("git push origin +main", "git-push-force");
    assertHeld("git push --force-with-lease", "git-push-force");
    assertHeld("git checkout -- .", "git-discard");
    assertHeld("git checkout .", "git-discard");
    assertHeld("git restore .", "git-discard");
    assertClear("git restore --staged .");
    assertHeld("git restore --staged --worktree .", "git-discard");
  });

  it("follows cd and git -C", () => {
    assert.equal(firstRisk("cd repo && git reset --hard").dir, "repo");
    assert.equal(firstRisk("git -C repo reset --hard").dir, "repo");
    assert.equal(firstRisk("(cd sub && rm -rf out)").dir, "sub");
    assert.equal(firstRisk("(cd sub && make) && rm -rf out").dir, null);
  });

  it("branch -D and branch -d --force", () => {
    assert.deepEqual(firstRisk("git branch -D feature").names, ["feature"]);
    assertHeld("git branch -d --force feature", "git-branch-delete");
    assertHeld("git branch --delete --force feature", "git-branch-delete");
    assertClear("git branch -d feature");
    assertClear("git branch new-feature");
  });

  it("stash drop and stash clear", () => {
    assert.equal(firstRisk("git stash drop").stash, "stash@{0}");
    assert.equal(firstRisk("git stash drop stash@{2}").stash, "stash@{2}");
    assertHeld("git stash clear", "git-stash-clear");
    assertClear("git stash list");
  });

  it("restore <path>, checkout -- <path>, checkout <ref> -- <path>", () => {
    const restore = firstRisk("git restore src/app.ts");
    assert.equal(restore.mode, "restore");
    assert.deepEqual(restore.paths, ["src/app.ts"]);
    const checkout = firstRisk("git checkout -- src/app.ts");
    assert.equal(checkout.mode, "checkout-paths");
    assert.equal(checkout.ref, null);
    const fromRef = firstRisk("git checkout main -- src/app.ts");
    assert.equal(fromRef.ref, "main");
    assert.deepEqual(fromRef.paths, ["src/app.ts"]);
    assert.equal(firstRisk("git restore --source=HEAD~2 a.ts").source, "HEAD~2");
  });

  it("checkout -f, switch -f, switch --discard-changes", () => {
    assert.equal(firstRisk("git checkout -f").mode, "checkout-force");
    assert.equal(firstRisk("git switch -f main").mode, "switch-force");
    assert.equal(firstRisk("git switch --discard-changes main").mode, "switch-force");
    assertClear("git switch main");
    assertClear("git checkout -b feature");
  });

  it("a bare git checkout <name> is measured to tell a branch from a path", () => {
    const risk = firstRisk("git checkout main");
    assert.equal(risk.mode, "checkout-ambiguous");
    assert.equal(risk.isConditional, true);
    assert.deepEqual(risk.candidates, ["main"]);
  });

  it("push --delete and push origin :branch", () => {
    const flag = firstRisk("git push --delete origin old");
    assert.equal(flag.kind, "git-push-delete");
    assert.equal(flag.remote, "origin");
    assert.deepEqual(flag.branches, ["old"]);
    assert.deepEqual(firstRisk("git push origin :old").branches, ["old"]);
    assertHeld("git push -d origin old", "git-push-delete");
    assertClear("git push origin main");
  });

  it("reflog expire, gc --prune, prune", () => {
    assertHeld("git reflog expire --expire=now --all", "git-reflog");
    assertHeld("git gc --prune=now", "git-prune");
    assertHeld("git prune", "git-prune");
    assertClear("git gc");
    assertClear("git gc --prune=never");
  });

  it("filter-branch and update-ref -d", () => {
    assert.ok(firstRisk("git filter-branch --tree-filter 'rm -f x' HEAD").notMeasured);
    assert.equal(firstRisk("git update-ref -d refs/heads/x").ref, "refs/heads/x");
    assertClear("git update-ref refs/heads/x HEAD");
  });
});

describe("databases", () => {
  it("keeps the migration holds it had", () => {
    assertHeld("python manage.py migrate", "migrate");
    assertHeld("alembic upgrade head", "migrate");
    assertHeld("bin/rails db:migrate", "migrate");
    assertHeld("npx prisma migrate dev", "migrate");
  });

  it("prisma migrate reset and db push --force-reset / --accept-data-loss", () => {
    assert.equal(firstRisk("npx prisma migrate reset --force").label, "prisma migrate reset");
    assert.equal(firstRisk("npx prisma db push --force-reset").label, "prisma db push --force-reset");
    assert.equal(firstRisk("npx prisma db push --accept-data-loss").label, "prisma db push --accept-data-loss");
    assertClear("npx prisma db push");
  });

  it("rails db:drop, db:reset, db:schema:load", () => {
    assert.equal(firstRisk("bin/rails db:drop").label, "db:drop");
    assert.equal(firstRisk("rails db:reset").label, "db:reset");
    assert.equal(firstRisk("bundle exec rake db:schema:load").label, "db:schema:load");
  });

  it("alembic downgrade", () => {
    assert.equal(firstRisk("alembic downgrade -1").label, "alembic downgrade");
  });

  it("DROP, TRUNCATE, DELETE FROM in psql -c, mysql -e, sqlite3", () => {
    assertHeld('psql -c "DROP TABLE users"', "sql");
    assertHeld('mysql -u root -e "TRUNCATE logs"', "sql");
    assertHeld('sqlite3 app.db "DELETE FROM users"', "sql");
    assertHeld('echo "DROP TABLE x" | psql mydb', "sql");
    assertHeld("psql mydb <<EOF\nDROP TABLE users;\nEOF", "sql");
    assertClear('psql -c "SELECT 1"');
  });

  it("names the database risks as not measured", () => {
    assert.ok(firstRisk('psql -c "DROP TABLE users"').notMeasured);
  });
});

describe("infrastructure", () => {
  it("docker system prune, rm, volume rm", () => {
    assert.equal(firstRisk("docker system prune -af").scope, "system");
    assert.deepEqual(firstRisk("docker rm -f web").names, ["web"]);
    assert.deepEqual(firstRisk("docker volume rm data").names, ["data"]);
    assert.equal(firstRisk("docker volume prune").scope, "volume-prune");
    assert.equal(firstRisk("docker compose down -v").scope, "compose-down");
    assertClear("docker ps -a");
  });

  it("kubectl delete", () => {
    assertHeld("kubectl delete pod web-1 -n prod", "kubectl-delete");
    assertHeld("kubectl -n prod delete deployment web", "kubectl-delete");
    assertClear("kubectl get pods");
  });

  it("terraform destroy", () => {
    assertHeld("terraform destroy -auto-approve", "terraform-destroy");
    assertHeld("terraform apply -destroy", "terraform-destroy");
    assertClear("terraform plan");
  });
});

describe("wrappers", () => {
  it("bash -c, sh -c, zsh -c read the inner string", () => {
    assertHeld('bash -c "rm -rf build"', "delete");
    assertHeld("bash -lc 'rm -rf build'", "delete");
    assert.equal(firstRisk("sh -c 'cd sub && rm -rf out'").dir, "sub");
    assertHeld('zsh -c "git reset --hard"', "git-discard");
    const part = classify('bash -c "rm -rf build"').parts.find((each) => each.risks.length > 0);
    assert.equal(part.via, "bash -c");
  });

  it("eval", () => {
    assertHeld('eval "rm -rf build"', "delete");
  });

  it("timeout N, doas, time -p, env -i, sudo, nice, nohup", () => {
    assertHeld("timeout 30 rm -rf build", "delete");
    assertHeld("timeout -s KILL 5 rm -rf build", "delete");
    assertHeld("doas rm -rf /var/cache/x", "delete");
    assertHeld("time -p rm -rf build", "delete");
    assertHeld("env -i PATH=/bin rm -rf build", "delete");
    assertHeld("sudo -u root rm -rf x", "delete");
    assertHeld("nice -n 10 rm -rf x", "delete");
    assertHeld("nohup rm -rf x &", "delete");
    assert.equal(firstRisk("env -C sub rm -rf out").dir, "sub");
  });

  it("a quoted argument of another program is held, unmeasured", () => {
    const risk = firstRisk('docker exec web sh -c "rm -rf /data"');
    assert.equal(risk.kind, "delete");
    assert.ok(risk.notMeasured);
    assertClear('node -e "if (a > b) console.log(1)"');
  });

  it("command -v looks a name up and runs nothing", () => {
    assertClear("command -v rm");
  });
});

describe("nothing to discard", () => {
  it("parses git status --porcelain", () => {
    assert.deepEqual(parsePorcelain(" M a.ts\nM  b.ts\n?? c.ts\n"), [
      { index: " ", worktree: "M", path: "a.ts" },
      { index: "M", worktree: " ", path: "b.ts" },
      { index: "?", worktree: "?", path: "c.ts" },
    ]);
  });

  it("marks what runs first", () => {
    assert.equal(firstRisk("git reset --hard").isQuietBefore, true);
    assert.equal(firstRisk("cd repo && git status && git reset --hard").isQuietBefore, true);
    assert.equal(firstRisk("git stash pop && git reset --hard").isQuietBefore, false);
    assert.equal(firstRisk("make && git checkout -- .").isQuietBefore, false);
  });

  it("a clean tree discards nothing", () => {
    const risk = firstRisk("git reset --hard");
    assert.equal(discardVerdict(risk, []).isNothingToDiscard, true);
    assert.equal(discardVerdict(risk, parsePorcelain("?? new.ts")).isNothingToDiscard, true);
  });

  it("changes are something to discard", () => {
    const verdict = discardVerdict(firstRisk("git reset --hard"), parsePorcelain(" M a.ts\nM  b.ts"));
    assert.equal(verdict.isNothingToDiscard, false);
    assert.equal(verdict.lost.length, 2);
  });

  it("checkout -- <path> only discards unstaged changes", () => {
    const risk = firstRisk("git checkout -- a.ts");
    assert.equal(discardVerdict(risk, parsePorcelain("M  a.ts")).isNothingToDiscard, true);
    assert.equal(discardVerdict(risk, parsePorcelain(" M a.ts")).isNothingToDiscard, false);
  });

  it("taking files from another commit counts untracked files and dropped commits", () => {
    assert.equal(discardVerdict(firstRisk("git checkout main -- a.ts"), parsePorcelain("?? a.ts")).isNothingToDiscard, false);
    assert.equal(discardVerdict(firstRisk("git reset --hard HEAD~2"), [], 2).isNothingToDiscard, false);
    assert.equal(discardVerdict(firstRisk("git reset --hard HEAD~2"), [], -1).isNothingToDiscard, false);
    assert.equal(discardVerdict(firstRisk("git reset --hard HEAD"), parsePorcelain("?? new.ts")).isNothingToDiscard, true);
  });

  it("does not pass when an earlier part may change files", () => {
    const verdict = discardVerdict(firstRisk("make && git reset --hard"), []);
    assert.equal(verdict.isNothingAtStake, true);
    assert.equal(verdict.isNothingToDiscard, false);
  });

  it("holdVerdict runs a plan with nothing to discard, and holds one with anything else", () => {
    const passing = classify("git reset --hard");
    passing.parts[0].risks[0].result = { status: "safe", summary: "discard nothing", isNothingToDiscard: true };
    assert.deepEqual(
      { isHeld: holdVerdict(passing).isHeld, isAutoPass: holdVerdict(passing).isAutoPass },
      { isHeld: false, isAutoPass: true },
    );

    const mixed = classify("git reset --hard && rm -rf build");
    const [reset, remove] = mixed.parts.flatMap((part) => part.risks);
    reset.result = { status: "safe", summary: "discard nothing", isNothingToDiscard: true };
    remove.result = { status: "measured", summary: "delete 3 files" };
    const verdict = holdVerdict(mixed);
    assert.equal(verdict.isHeld, true);
    assert.equal(verdict.label, "rm -rf");
    assert.equal(verdict.summary, "delete 3 files");

    const unmeasured = classify("rm -rf build");
    assert.equal(holdVerdict(unmeasured).isHeld, true);
  });

  it("a cleared conditional runs without a hold or a toast", () => {
    const plan = classify("echo hi > new.txt");
    plan.parts[0].risks[0].result = { status: "safe", summary: "new.txt does not exist yet" };
    assert.deepEqual(
      { isHeld: holdVerdict(plan).isHeld, isAutoPass: holdVerdict(plan).isAutoPass },
      { isHeld: false, isAutoPass: false },
    );
  });
});

describe("review round 1: forms that must stay held", () => {
  it("a subshell in ( ) is read as its command", () => {
    for (const command of [
      "(rm -rf x)",
      "(rm -rf x) && ls",
      "(rm -rf x) 2>/dev/null",
      "(rm -rf x)&",
      "echo a && (rm -rf x)",
      "(sudo rm -rf /x)",
      "if [ -d x ]; then (rm -rf x); fi",
      "echo 'unclosed\n(rm -rf x)",
    ]) {
      assertHeld(command, "delete");
    }
    assertHeld("(git reset --hard)", "git-discard");
    assertHeld("(git push --force)", "git-push-force");
    assertHeld("(git clean -fd)", "git-clean");
    assertHeld("(git checkout .)", "git-discard");
  });

  it("a # right after ( stays part of the command, as a zsh glob flag", () => {
    assertHeld("ls (#i)x; rm -rf build", "delete");
  });

  it("awk and sed programs that shell out are held", () => {
    assertHeld(`awk 'BEGIN{system("rm -rf x")}'`, "delete");
    assertHeld(`awk 'BEGIN{system("rails db:migrate")}'`, "migrate");
    assertHeld(`awk 'BEGIN{"rm -rf x" | getline}'`, "delete");
    assertHeld("sed -n '1e rm -rf x' f", "delete");
    assertHeld("sed 's/x/rm -rf y/e' f", "unreadable");
    assertClear("sed -i 's/a/b/' f");
    assertClear("awk '{print $1}' f");
  });

  it("parts running beside a discard, or inside its segment, stop the nothing-to-discard pass", () => {
    for (const command of [
      "git reset --hard < <(git stash pop)",
      "git reset --hard | git stash pop",
      "X=$(git stash pop) git reset --hard",
      "git fetch && git reset --hard origin/main",
      "git branch -f main x && git reset --hard main",
    ]) {
      const risk = risksOf(command).find((each) => each.kind === "git-discard");
      assert.equal(risk.isQuietBefore, false, `${command} must not auto-pass`);
      assert.equal(discardVerdict(risk, []).isNothingToDiscard, false, `${command} must not auto-pass`);
    }
  });

  it("a ref form counts the files it would write over, whatever status shows", () => {
    const risk = firstRisk("git reset --hard other");
    assert.equal(discardVerdict(risk, [], 0, { paths: ["newfile.txt"] }).isNothingToDiscard, false);
    assert.equal(discardVerdict(risk, [], 0, { isUnknown: true }).isNothingToDiscard, false);
    assert.equal(discardVerdict(risk, parsePorcelain("?? other.txt"), 0, { paths: [] }).isNothingToDiscard, true);
    assert.equal(discardVerdict(risk, parsePorcelain("!! build/out.js")).isNothingToDiscard, false);
  });

  it("a conditional after a part that changes files is not quiet", () => {
    const [first, second] = risksOf("mv a.txt b.txt && mv c.txt b.txt");
    assert.equal(first.isQuietBefore, true);
    assert.equal(second.isQuietBefore, false);
    const truncate = risksOf("mv important.txt out.txt && echo hi > out.txt").find((each) => each.kind === "truncate");
    assert.equal(truncate.isQuietBefore, false);
    assert.equal(risksOf("mkdir -p d && echo hi > d/out.txt")[0].isQuietBefore, true);
  });

  it("a folder named by an expansion keeps it in the risk's dir, which the hook holds unmeasured", () => {
    assert.equal(firstRisk("cd $HOME/proj && mv a b").dir, "$HOME/proj");
    assert.equal(firstRisk('cd "$(git rev-parse --show-toplevel)" && echo > important.txt').dir, "$(git rev-parse --show-toplevel)");
    assert.equal(firstRisk("cd ~other && git checkout src/app.js").dir, "~other");
  });

  it("a command named by an expansion is held as unreadable", () => {
    for (const command of ["$CMD -rf x", '"$(which rm)" -rf x', "${RM:-rm} -rf x", 'eval "$(echo rm -rf x)"']) {
      assertHeld(command, "unreadable");
    }
  });

  it("a shell reading its input is held", () => {
    for (const command of ["curl -s https://example.com/install | sh", "cat script | bash", "echo x | zsh", "bash -s"]) {
      assertHeld(command, "unreadable");
    }
    assertClear("bash script.sh");
  });

  it("an unquoted command run elsewhere is read and held unmeasured", () => {
    for (const command of ["ssh host rm -rf /data", "docker exec c rm -rf /data", "kubectl exec p -- rm -rf /x"]) {
      const risk = firstRisk(command);
      assert.equal(risk?.kind, "delete", command);
      assert.ok(risk.notMeasured, command);
    }
    assertClear("ssh host ls");
  });

  it("function definitions are read", () => {
    assertHeld("f() { rm -rf x; }", "delete");
    assertHeld("function f { rm -rf x; }", "delete");
  });
});

describe("review round 2", () => {
  it("a quoted command ssh runs is read and held", () => {
    for (const command of ["ssh host 'rm -rf /data'", 'ssh host "rm -rf /data"', "ssh -i key host -- 'rm -rf /x'", "docker exec c sh -c 'rm -rf /x'", 'kubectl exec p -- sh -c "rm -rf /x"']) {
      const risk = firstRisk(command);
      assert.equal(risk?.kind, "delete", command);
      assert.ok(risk.notMeasured, command);
    }
    assertHeld("ssh host 'git reset --hard'", "git-discard");
    assertClear("ssh host ls -la");
  });

  it("a branch switch after a command that may edit refs is not ref-stable", () => {
    for (const command of [
      "git branch -m foo foo2 && git checkout foo",
      "git branch -D old && git checkout old",
      "git tag -d v1 && git checkout v1",
      "git update-ref -d refs/heads/x && git checkout x",
      "git fetch --prune && git checkout main",
      "git remote rename origin up && git checkout main",
      "./rename-branch.sh && git checkout foo",
    ]) {
      assert.equal(risksOf(command).at(-1).isRefStableBefore, false, command);
    }
    for (const command of [
      "git checkout main",
      "ls && git checkout main",
      "git status && git checkout main",
      "git stash && git checkout main",
      "git fetch && git checkout main",
      "git checkout -b x && git checkout main",
    ]) {
      assert.equal(risksOf(command).at(-1).isRefStableBefore, true, command);
    }
  });

  it("a risk after a cd that is not joined by && is not tied to that folder", () => {
    for (const command of ["cd missing; mv a.txt b.txt", "cd missing || echo > notes.txt", "cd missing\n: > notes.txt", "cd a && cd b; mv x y"]) {
      assert.equal(firstRisk(command).isDirLinked, false, command);
    }
    assert.equal(firstRisk("cd missing && mv a b").isDirLinked, true);
    assert.equal(firstRisk("mv a b").isDirLinked, true);
    const [inside, outside] = risksOf("(cd missing; mv a b); mv c d");
    assert.equal(inside.isDirLinked, false);
    assert.equal(outside.isDirLinked, true);
  });

  it("an expansion only in a quoted leading folder reads the command by its name", () => {
    assertClear('"$HOME/.venv/bin/python" -m pytest');
    assertClear('"$(npm bin)/eslint" .');
    assertClear('"$(dirname $0)"/run.sh');
    assertHeld('"$X"/rm -rf y', "delete");
    assertHeld("$(npm bin)/eslint .", "unreadable");
    assertHeld("$X/ls", "unreadable");
    assertHeld("$(dirname $0)/run.sh", "unreadable");
    assertHeld("$PYTHON script.py", "unreadable");
    assertHeld("$CMD -rf x", "unreadable");
    assertHeld("${RM:-rm} -rf x", "unreadable");
  });
});

describe("review round 3", () => {
  it("options after the ssh host are skipped", () => {
    assertHeld("ssh host -t 'rm -rf x'", "delete");
    assertHeld("ssh host -p 22 'git reset --hard'", "git-discard");
    assertHeld('ssh host -o StrictHostKeyChecking=no "rm -rf /x"', "delete");
    assertHeld("ssh host -t -- 'rm -rf x'", "delete");
    assertClear("ssh host -t ls");
  });
});

describe("review round 4", () => {
  it("a git alias or extension before a branch switch counts as a ref edit", () => {
    for (const command of [
      "git rb foo foo2 && git checkout foo",
      "git -C sub rb foo foo2 && git checkout foo",
      "git-foo && git checkout foo",
      "git $SUB foo && git checkout foo",
      "git config alias.rb 'branch -m' && git checkout foo",
      "git push . :foo && git checkout foo",
      "git push --delete . foo && git checkout foo",
      "git pull --prune && git checkout main",
      "git remote prune origin && git checkout main",
      "git rebase -x ./script.sh main && git checkout foo",
      "git submodule foreach ./script.sh && git checkout foo",
    ]) {
      assert.equal(risksOf(command).at(-1).isRefStableBefore, false, command);
    }
    for (const command of [
      "git stash && git checkout main",
      "git fetch && git checkout main",
      "git add . && git checkout main",
      "git commit -m wip && git checkout main",
      "git pull && git checkout main",
      "git config --get user.name && git checkout main",
    ]) {
      assert.equal(risksOf(command).at(-1).isRefStableBefore, true, command);
    }
  });

  it("a git alias with a migrate argument is held like any other command", () => {
    assertHeld("git m migrate", "migrate");
    assertClear("git log --grep migrate");
  });

  it("decodes $'...' escapes the way bash does", () => {
    const valueOf = (text) => tokenize(text).words[0].value;
    assert.equal(valueOf(String.raw`$'\x72m'`), "rm");
    assert.equal(valueOf(String.raw`$'\162m'`), "rm");
    assert.equal(valueOf(String.raw`$'rm'`), "rm");
    assert.equal(valueOf(String.raw`$'\U00000072m'`), "rm");
    assert.equal(valueOf(String.raw`$'rm\0junk'`), "rm");
    assert.equal(valueOf(String.raw`$'a\'b'`), "a'b");
    assert.equal(valueOf(String.raw`$'\xg'`), String.raw`\xg`);
    assert.equal(valueOf(String.raw`$'\q'`), String.raw`\q`);
  });

  it("a command name written with $'...' is read after decoding", () => {
    for (const command of [String.raw`$'\x72m' -rf x`, String.raw`$'\162m' -rf x`, String.raw`$'rm' -rf x`, String.raw`sudo $'\x72m' -rf x`, String.raw`bash -c $'rm\x20-rf x'`]) {
      assertHeld(command, "delete");
    }
    assertHeld(String.raw`git $'\x62ranch' -D old`, "git-branch-delete");
    assertClear(String.raw`echo $'\x72m -rf x'`);
  });
});

describe("regression: shapes the 0.2.0 classifier held", () => {
  const cores = [
    ["rm -rf x", "delete"],
    ["rm -f x", "delete"],
    ["sudo rm -rf /x", "delete"],
    ["git reset --hard", "git-discard"],
    ["git clean -fd", "git-clean"],
    ["git push --force", "git-push-force"],
    ["git checkout -- .", "git-discard"],
    ["git restore .", "git-discard"],
    ["python manage.py migrate", "migrate"],
    ["bin/rails db:migrate", "migrate"],
  ];
  const shapes = [
    (core) => core,
    (core) => `(${core})`,
    (core) => `(${core}) && ls`,
    (core) => `(${core}) 2>/dev/null`,
    (core) => `(${core})&`,
    (core) => `echo a && (${core})`,
    (core) => `ls; ${core}`,
    (core) => `ls && ${core}`,
    (core) => `ls || ${core}`,
    (core) => `ls | ${core}`,
    (core) => `${core} | cat`,
    (core) => `${core} &`,
    (core) => `${core} > log.txt`,
    (core) => `cd sub && ${core}`,
    (core) => `(cd sub && ${core})`,
    (core) => `if [ -d x ]; then ${core}; fi`,
    (core) => `if [ -d x ]; then (${core}); fi`,
    (core) => `for f in a b; do ${core}; done`,
    (core) => `{ ${core}; }`,
    (core) => `f() { ${core}; }`,
    (core) => `echo 'unclosed\n${core}`,
    (core) => `echo 'unclosed\n(${core})`,
    (core) => `# don't\n${core}`,
    (core) => `ls (#i)x; ${core}`,
    (core) => `echo "$(${core})"`,
    (core) => `x=$(${core})`,
    (core) => `sh -c '${core}'`,
    (core) => `bash -c "${core}"`,
    (core) => `! ${core}`,
    (core) => `timeout 5 ${core}`,
    (core) => `cat <<EOF\nhello\nEOF\n${core}`,
    (core) => `((${core}))`,
    (core) => `( (${core}) )`,
    (core) => `(\n${core}\n)`,
    (core) => `cd /tmp; (${core}) || true`,
    (core) => `awk 'BEGIN{system("x"); system("${core}")}'`,
    (core) => `sed -e 's/a/b/; ${core}' f`,
  ];
  for (const [core, kind] of cores) {
    it(`holds ${core} in every shape`, () => {
      for (const shape of shapes) {
        assertHeld(shape(core), kind);
      }
    });
  }
});

describe("help", () => {
  it("lists every family", () => {
    assert.deepEqual(
      PATTERNS.map((group) => group.family),
      ["Files", "Git", "Databases", "Infrastructure", "Wrappers it reads through"],
    );
  });
});
