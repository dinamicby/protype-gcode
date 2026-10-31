#!/usr/bin/env python3
"""Ban on GitHub-hosted macOS and Windows runners in Protype repositories.

One file, three callers:
  python3 .github/runner_policy.py        CI: scan the checkout, exit 1 on a violation
  runner_policy.py pre-push NAME URL      git pre-push hook: refs arrive on stdin
  import runner_policy                    the Claude Code hook

Standard library only: the hooks run under whatever python3 the machine has.
The file is deliberately text-based, not a YAML parser. A hosted label is
rejected wherever it appears outside a comment, so a matrix value, a
reusable-workflow input and a literal inside an expression are all caught by
the same rule, and a runner that cannot be read from the file at all (a
variable, a computed matrix, a remote reusable workflow) is rejected as hidden.

Canonical copy: dinamicby/ProtypeSlicer, .github/runner_policy.py, tests in
scripts/ci/test_runner_policy.py. The rule, its reasons and the runners to use
instead: docs/ci/self-hosted-runners.md in the same repository.

An exception needs Vlad's explicit word. Add ("<workflow file>", "<label>") to
ALLOWED in the same pull request, so the exception is visible in review.
"""
import collections
import re
import subprocess
import sys
from pathlib import Path

WORKFLOWS_DIR = ".github/workflows"
ZERO_SHA = "0" * 40

ALLOWED = set()

# Forks of upstream projects: their workflows are upstream's, and Actions is
# switched off in these repositories, so nothing in them can start a job.
FORKS_WITH_ACTIONS_OFF = {
    "OrcaSlicer", "PrusaSlicer", "btt-os", "llama-cpp-turboquant", "unitprotocol_core",
}

HOSTED_LABEL = re.compile(r"(?<![\w.-])(?:macos|windows)-(?:latest|\d)[\w.-]*", re.IGNORECASE)
RUNS_ON = re.compile(r"^(\s*(?:-\s+)?)runs-on:\s*(.*)$")
EXPRESSION = re.compile(r"\$\{\{.*?\}\}")
PLAIN_EXPRESSION = re.compile(r"""["']?\$\{\{\s*(?:matrix|inputs)\.[\w-]+\s*\}\}["']?""")
DYNAMIC_MATRIX = re.compile(r"^\s*matrix:\s*[\"']?\$\{\{")
REMOTE_WORKFLOW = re.compile(r"""^\s*(?:-\s+)?uses:\s*["']?[^\s"'./][^\s"']*/\.github/workflows/""")
OWN_REPO = re.compile(r"dinamicby/([^/\s]+?)(?:\.git)?/?$")

MESSAGES = {
    "hosted": "размещённый на GitHub раннер {label} запрещён, нужен свой: "
    "[self-hosted, macOS, ARM64, protype-mac] или [self-hosted, Windows, X64, protype-win]",
    "hidden": "раннер {label} нельзя проверить по файлу: запрещены переменные, "
    "вычисляемые матрицы и чужие переиспользуемые воркфлоу",
}

Violation = collections.namedtuple("Violation", "path line rule label")


def strip_comment(line):
    quote = None
    for index, char in enumerate(line):
        if quote:
            quote = None if char == quote else quote
        elif char in "\"'":
            quote = char
        elif char == "#" and (index == 0 or line[index - 1].isspace()):
            return line[:index]
    return line


def hidden_expressions(value):
    """Expressions in a runs-on value other than a bare matrix or input reference."""
    value = value.strip().strip("[]")
    parts = [part.strip() for part in value.split(",")] if "${{" in value else []
    return [part for part in parts if EXPRESSION.search(part) and not PLAIN_EXPRESSION.fullmatch(part)]


def check_text(path, text):
    found = []
    name = Path(path).name
    runs_on_indent = None
    for number, raw in enumerate(text.splitlines(), start=1):
        line = strip_comment(raw).rstrip()
        if not line:
            continue

        for match in HOSTED_LABEL.finditer(line):
            if (name, match.group(0)) not in ALLOWED:
                found.append(Violation(path, number, "hosted", match.group(0)))

        indent = len(line) - len(line.lstrip())
        if runs_on_indent is not None and indent <= runs_on_indent:
            runs_on_indent = None
        runs_on = RUNS_ON.match(line)
        if runs_on:
            value = runs_on.group(2)
            runs_on_indent = None if value else len(runs_on.group(1))
        elif runs_on_indent is not None:
            value = line.strip().lstrip("-").strip()
        else:
            value = None
        if value:
            found.extend(Violation(path, number, "hidden", part) for part in hidden_expressions(value))

        if DYNAMIC_MATRIX.match(line):
            found.append(Violation(path, number, "hidden", line.strip()))
        if REMOTE_WORKFLOW.match(line):
            found.append(Violation(path, number, "hidden", line.strip()))
    return found


def describe(violation):
    message = MESSAGES[violation.rule].format(label=violation.label)
    return f"{violation.path}:{violation.line}: {message}"


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)


def tree_violations(repo, sha):
    listing = git(repo, "ls-tree", "-r", "--name-only", sha, "--", WORKFLOWS_DIR)
    found = []
    for path in listing.stdout.splitlines():
        if path.endswith((".yml", ".yaml")):
            found.extend(check_text(path, git(repo, "show", f"{sha}:{path}").stdout))
    return found


def new_violations(repo, head, base):
    """Violations in head that base does not have.

    Comparing with the default branch lets the ban go live before every
    migration is merged: a branch is not blocked for what main already carries.
    """
    known = set()
    if base:
        known = {(v.path, v.rule, v.label) for v in tree_violations(repo, base)}
    return [v for v in tree_violations(repo, head) if (v.path, v.rule, v.label) not in known]


def default_base(repo, remote="origin"):
    for ref in ("HEAD", "main", "master"):
        result = git(repo, "rev-parse", "--verify", "--quiet", f"refs/remotes/{remote}/{ref}^{{commit}}")
        if result.returncode == 0:
            return result.stdout.strip()
    return None


def is_checked_remote(url):
    match = OWN_REPO.search(url)
    return bool(match) and match.group(1) not in FORKS_WITH_ACTIONS_OFF


def pre_push(repo, url, refs, remote="origin"):
    if not is_checked_remote(url):
        return 0
    base = default_base(repo, remote)
    found = []
    for line in refs.splitlines():
        fields = line.split()
        if len(fields) == 4 and fields[1] != ZERO_SHA:
            found.extend(v for v in new_violations(repo, fields[1], base) if v not in found)
    for violation in found:
        print(f"runner-policy: {describe(violation)}", file=sys.stderr)
    if found:
        print("runner-policy: пуш остановлен. Исключение только по слову Влада.", file=sys.stderr)
    return 1 if found else 0


def scan(root):
    found = []
    workflows = Path(root) / WORKFLOWS_DIR
    for path in sorted(workflows.glob("*")):
        if path.suffix in (".yml", ".yaml"):
            relative = path.relative_to(root).as_posix()
            found.extend(check_text(relative, path.read_text(errors="replace")))
    for violation in found:
        message = MESSAGES[violation.rule].format(label=violation.label)
        print(f"::error file={violation.path},line={violation.line}::{message}")
    print(f"runner-policy: нарушений {len(found)}")
    return 1 if found else 0


def main(argv):
    if len(argv) > 1 and argv[1] in ("-h", "--help"):
        print(__doc__)
        return 0
    if len(argv) == 4 and argv[1] == "pre-push":
        return pre_push(".", argv[3], sys.stdin.read(), remote=argv[2])
    return scan(".")


if __name__ == "__main__":
    sys.exit(main(sys.argv))
