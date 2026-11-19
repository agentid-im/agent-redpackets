#!/bin/sh
# Refuses a commit whose staged changes contain a secret. Install as a pre-commit hook:
#   ln -sf ../../scripts/check-secrets.sh .git/hooks/pre-commit
# Secret values are read from the local, git-ignored files at commit time; none is written here.
# Checked: values of *KEY*/*SECRET*/*TOKEN*/*PASS* variables (paths excepted), any URL carrying a long
# token in its path (keyed RPC endpoints), and the whole content of key files.
set -eu
root=$(git rev-parse --show-toplevel)
staged=$(git diff --cached -U0 --no-color | grep '^+' | grep -v '^+++' || true)
[ -z "$staged" ] && exit 0

fail() {
  echo "pre-commit: refusing to commit: $1" >&2
  exit 1
}
has() { printf '%s\n' "$staged" | grep -qF -- "$1"; }

# Keyed RPC endpoints never belong in the repo.
printf '%s\n' "$staged" | grep -qiE 'nodereal\.io/v1/[0-9a-z]{16,}' && fail "a keyed NodeReal URL is staged"

# Variables in env-style files.
for f in "$root/.env" "$root/.dev.vars"; do
  [ -f "$f" ] || continue
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue ;; esac
    name=${line%%=*}
    value=$(printf '%s' "${line#*=}" | tr -d ' \r"')
    for part in $(printf '%s' "$value" | tr ',' ' '); do
      [ ${#part} -ge 16 ] || continue
      case "$part" in /*) continue ;; esac
      secret=no
      case "$name" in *KEY*|*SECRET*|*TOKEN*|*PASS*) secret=yes ;; esac
      printf '%s' "$part" | grep -qE '://[^/]+/.*[A-Za-z0-9]{16,}' && secret=yes
      [ "$secret" = yes ] && has "$part" && fail "the value of $name from $(basename "$f") is staged"
    done
  done < "$f"
done

# Key files outside the repo: every line is secret.
for f in "$root/../hongbao.env" "$root/../hongbao-keeper.env"; do
  [ -f "$f" ] || continue
  while IFS= read -r line || [ -n "$line" ]; do
    v=$(printf '%s' "$line" | tr -d ' \r')
    [ ${#v} -ge 16 ] || continue
    has "$v" && fail "a key from $(basename "$f") is staged"
    has "${v#0x}" && fail "a key from $(basename "$f") is staged"
  done < "$f"
done
exit 0
