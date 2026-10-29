#!/usr/bin/env bash
# Model-checks MarkdownFile.tla (the disk <-> CRDT reconciliation in
# apps/obsidian/src/sync/engine.ts). Exit 0: every rule holds.
#
# Usage: verification/markdown-file/check.sh [--trace]
#   --trace  print the full TLC counterexample of every broken rule
#
# Tools: TLC 1.7.4 and a Temurin 21 JRE, downloaded once with checksums into
# ${XDG_CACHE_HOME:-~/.cache}/ob-provenance-sync/tla. Set JAVA to use your own java (11+).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TRACE=0
if [[ "${1:-}" == "--trace" ]]; then TRACE=1; fi

CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/ob-provenance-sync/tla"
TLA_URL="https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar"
TLA_SHA="936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
JRE_TAG="jdk-21.0.5+11"
JRE_FILE_VER="21.0.5_11"

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

fetch_tools() {
  mkdir -p "$CACHE"
  if [[ ! -f "$CACHE/tla2tools.jar" ]]; then
    echo "Downloading TLC 1.7.4..." >&2
    curl -fsSL -o "$CACHE/tla2tools.jar.part" "$TLA_URL"
    [[ "$(sha256 "$CACHE/tla2tools.jar.part")" == "$TLA_SHA" ]] || { echo "tla2tools.jar checksum mismatch" >&2; exit 2; }
    mv "$CACHE/tla2tools.jar.part" "$CACHE/tla2tools.jar"
  fi
  if [[ -n "${JAVA:-}" ]]; then return; fi
  local os arch
  case "$(uname -s)" in Darwin) os=mac ;; Linux) os=linux ;; *) echo "Unsupported OS; set JAVA" >&2; exit 2 ;; esac
  case "$(uname -m)" in arm64 | aarch64) arch=aarch64 ;; x86_64) arch=x64 ;; *) echo "Unsupported CPU; set JAVA" >&2; exit 2 ;; esac
  local dir="$CACHE/$JRE_TAG-jre"
  JAVA="$dir/bin/java"
  if [[ "$os" == mac ]]; then JAVA="$dir/Contents/Home/bin/java"; fi
  if [[ ! -x "$JAVA" ]]; then
    local name="OpenJDK21U-jre_${arch}_${os}_hotspot_${JRE_FILE_VER}.tar.gz"
    local url="https://github.com/adoptium/temurin21-binaries/releases/download/${JRE_TAG/+/%2B}/$name"
    echo "Downloading Temurin $JRE_TAG JRE..." >&2
    curl -fsSL -o "$CACHE/jre.tar.gz" "$url"
    [[ "$(sha256 "$CACHE/jre.tar.gz")" == "$(curl -fsSL "$url.sha256.txt" | cut -d' ' -f1)" ]] || { echo "JRE checksum mismatch" >&2; exit 2; }
    tar xzf "$CACHE/jre.tar.gz" -C "$CACHE"
    rm "$CACHE/jre.tar.gz"
  fi
}

fetch_tools
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp "$HERE/MarkdownFile.tla" "$WORK/"

RULES="NoDuplicate NoRevert NothingLost"
FAILED=0

# tlc NAME RULE...: one TLC run over the model, checking these rules.
# One worker finds the same shortest counterexample on every run.
tlc() {
  local name="$1"; shift
  grep -v '^INVARIANT' "$HERE/MarkdownFile.cfg" > "$WORK/$name.cfg"
  for rule in TypeOK "$@"; do echo "INVARIANT $rule" >> "$WORK/$name.cfg"; done
  (cd "$WORK" && "$JAVA" -XX:+UseParallelGC -cp "$CACHE/tla2tools.jar" tlc2.TLC -deadlock -workers 1 \
    -metadir "$WORK/states-$name" -config "$name.cfg" MarkdownFile.tla > "$name.out" 2>&1) || true
}

# expect BROKEN: checks every rule; BROKEN lists the rules that must break.
expect() {
  local broken="$1" rule got
  for rule in $RULES; do
    local want=holds
    if [[ " $broken " == *" $rule "* ]]; then want=broken; fi
    tlc "$rule" "$rule"
    if grep -q "Invariant $rule is violated" "$WORK/$rule.out"; then got=broken
    elif grep -q "No error has been found" "$WORK/$rule.out"; then got=holds
    else echo "   $rule: TLC did not finish:"; tail -20 "$WORK/$rule.out"; FAILED=1; continue; fi
    local mark="ok  "
    if [[ "$got" != "$want" ]]; then mark="DIFF"; FAILED=1; fi
    printf '   %s %-12s %-7s (expected %s)\n' "$mark" "$rule" "$got" "$want"
    if [[ "$got" == broken ]]; then
      echo "        shortest path: $(grep -E '^State [0-9]+: <' "$WORK/$rule.out" | sed -E 's/^State [0-9]+: <([A-Za-z]+).*/\1/' | grep -v Initial | paste -sd' ' - | sed 's/ / -> /g')"
      if [[ $TRACE == 1 ]]; then sed -n '/is violated/,/^[0-9]* states generated/p' "$WORK/$rule.out"; fi
    else
      echo "        $(grep -E 'distinct states found' "$WORK/$rule.out" | tail -1)"
    fi
  done
}

expect ""

if [[ $FAILED == 0 ]]; then echo "All results match the expectations."; else echo "Some results differ from the expectations (DIFF above)."; fi
exit $FAILED
