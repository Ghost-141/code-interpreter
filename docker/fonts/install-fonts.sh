#!/bin/sh
# Install the fonts Bangladeshi office PDFs are set in, plus metric-compatible stand-ins for the
# Microsoft fonts they reference. Idempotent: files already in place with the right checksum are
# left alone, and apt skips installed packages.
#
#   FONT_SET=recommended APT_INSTALL=apt-install sh install-fonts.sh [fonts.manifest]
#
# FONT_SET     required | recommended (default) | all
# APT_INSTALL  command that installs apt packages (default: apt-install, else apt-get install -y)
# FONT_DEST    where downloaded fonts go (default: /usr/share/fonts/truetype/bangladesh)
# FONT_CACHE   optional directory of pre-downloaded files, checked before the network. The
#              OmicronLab host drops TLS connections intermittently; point this at a copy of the
#              kit's cache/ to build without depending on it.
# KEEP_TOOLS   1 keeps curl/unzip if this script had to install them
#
# 60-bangladesh-fonts.conf beside this script, when present, goes to /etc/fonts/conf.d: it adds
# /usr/share/wine/fonts (Tahoma, Wingdings, Symbol from fonts-wine) and aliases Microsoft names
# such as Segoe UI and Vrinda to their free stand-ins.
#
# Any checksum mismatch aborts with a non-zero exit, failing the image build.
set -eu

FONT_SET="${FONT_SET:-recommended}"
FONT_DEST="${FONT_DEST:-/usr/share/fonts/truetype/bangladesh}"
FONT_CACHE="${FONT_CACHE:-}"
KEEP_TOOLS="${KEEP_TOOLS:-0}"
MANIFEST="${1:-$(dirname "$0")/fonts.manifest}"

if [ -z "${APT_INSTALL:-}" ]; then
  if command -v apt-install >/dev/null 2>&1; then
    APT_INSTALL=apt-install
  else
    APT_INSTALL="apt-get install -y --no-install-recommends"
    apt-get update
  fi
fi

case "$FONT_SET" in
  required) wanted="required" ;;
  recommended) wanted="required recommended" ;;
  all) wanted="required recommended optional" ;;
  *) echo "FONT_SET must be required, recommended or all: $FONT_SET" >&2; exit 64 ;;
esac

[ -f "$MANIFEST" ] || { echo "manifest not found: $MANIFEST" >&2; exit 66; }

selected() {
  for level in $wanted; do
    [ "$1" = "$level" ] && return 0
  done
  return 1
}

verify() {
  [ -f "$1" ] && [ "$(sha256sum "$1" | cut -d' ' -f1)" = "$2" ]
}

present() {
  case "$2" in
    apt) dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed' ;;
    file) verify "$FONT_DEST/$1" "$3" ;;
    zip) [ -f "$FONT_DEST/.$1.sha256" ] && [ "$(cat "$FONT_DEST/.$1.sha256")" = "$3" ] ;;
    *) return 1 ;;
  esac
}

tab="$(printf '\t')"
packages=""
needs_download=0
while IFS="$tab" read -r level kind target digest url members; do
  case "$level" in ''|'#'*) continue ;; esac
  selected "$level" || continue
  present "$target" "$kind" "$digest" && continue
  if [ "$kind" = apt ]; then
    packages="$packages $target"
  else
    needs_download=1
  fi
done < "$MANIFEST"

added_tools=""
if [ "$needs_download" = 1 ]; then
  for tool in curl unzip; do
    command -v "$tool" >/dev/null 2>&1 || added_tools="$added_tools $tool"
  done
fi
command -v fc-cache >/dev/null 2>&1 || packages="$packages fontconfig"

# shellcheck disable=SC2086
[ -z "$packages$added_tools" ] || $APT_INSTALL ca-certificates $packages $added_tools

fetch() {
  name="$1" digest="$2" url="$3" out="$4"
  if [ -n "$FONT_CACHE" ] && verify "$FONT_CACHE/$name" "$digest"; then
    cp "$FONT_CACHE/$name" "$out"
    return 0
  fi
  curl -fsSL --retry 8 --retry-delay 3 --retry-all-errors --max-time 180 -o "$out" "$url"
  if ! verify "$out" "$digest"; then
    echo "checksum mismatch for $name from $url" >&2
    echo "  expected $digest" >&2
    echo "  got      $(sha256sum "$out" | cut -d' ' -f1)" >&2
    rm -f "$out"
    exit 65
  fi
}

mkdir -p "$FONT_DEST"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

while IFS="$tab" read -r level kind target digest url members; do
  case "$level" in ''|'#'*) continue ;; esac
  selected "$level" || continue
  case "$kind" in
    file)
      present "$target" file "$digest" && continue
      fetch "$target" "$digest" "$url" "$work/$target"
      install -m 0644 "$work/$target" "$FONT_DEST/$target"
      ;;
    zip)
      marker="$FONT_DEST/.$target.sha256"
      present "$target" zip "$digest" && continue
      fetch "$target" "$digest" "$url" "$work/$target"
      unzip -o -q -j "$work/$target" $(echo "$members" | tr ',' ' ') -d "$work/unzipped"
      for member in $(echo "$members" | tr ',' ' '); do
        install -m 0644 "$work/unzipped/$member" "$FONT_DEST/$member"
      done
      echo "$digest" > "$marker"
      ;;
    apt) ;;
    *) echo "unknown manifest kind: $kind" >&2; exit 65 ;;
  esac
done < "$MANIFEST"

conf="$(dirname "$0")/60-bangladesh-fonts.conf"
if [ -f "$conf" ]; then
  install -m 0644 "$conf" /etc/fonts/conf.d/60-bangladesh-fonts.conf
fi

fc-cache -f >/dev/null

if [ -n "$added_tools" ] && [ "$KEEP_TOOLS" != 1 ]; then
  # shellcheck disable=SC2086
  apt-get purge -y --auto-remove $added_tools >/dev/null
fi

echo "fonts installed: set=$FONT_SET dest=$FONT_DEST"
