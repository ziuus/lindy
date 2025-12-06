#!/usr/bin/env bash
set -u

# clear_lind_mounts.sh
# Safely remove all lind-mount blocks from /etc/fstab, attempt to unmount bind targets
# and remove metadata under /var/lib/lind-mount.
# Usage:
#  sudo ./scripts/clear_lind_mounts.sh [--dry-run] [--force]
# --dry-run: only print what would be done
# --force: use lazy unmount (umount -l) when strict umount fails

DRY_RUN=0
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    -h|--help)
      echo "Usage: sudo $0 [--dry-run] [--force]"
      exit 0
      ;;
    *) echo "Unknown arg: $arg" ; exit 1 ;;
  esac
done

if [[ $(id -u) -ne 0 ]]; then
  echo "This script must be run as root (sudo)." >&2
  exit 2
fi

FSTAB=/etc/fstab
META_DIR=/var/lib/lind-mount
TMP_NEW=/tmp/lind-mount-newfst-$$.tmp
NOW=$(date +%s)
BACKUP=/etc/fstab.lind-mount.bak.${NOW}

# Read /etc/fstab and find all lind-mount blocks
mapfile -t BLOCK_IDS < <(awk '/# lind-mount BEGIN:/{print substr($0, index($0,"# lind-mount BEGIN:")+20)}' "$FSTAB" | sed 's/^ *//;s/ *$//')

if [[ ${#BLOCK_IDS[@]} -eq 0 ]]; then
  echo "No lind-mount blocks found in $FSTAB"
  exit 0
fi

echo "Found ${#BLOCK_IDS[@]} lind-mount block(s):"
for id in "${BLOCK_IDS[@]}"; do
  echo " - $id"
done

# For each block, extract targets and partition mountpoint
declare -A BLOCK_TARGETS
declare -A BLOCK_PART_MP

for id in "${BLOCK_IDS[@]}"; do
  # extract block content
  block=$(awk "/# lind-mount BEGIN: ${id}/,/# lind-mount END: ${id}/" "$FSTAB")
  targets=()
  part_mp=""
  while IFS= read -r line; do
    # detect bind lines: <src> <target> none bind ...
    if [[ "$line" =~ [[:space:]]+none[[:space:]]+bind ]]; then
      # extract second column
      tgt=$(echo "$line" | awk '{print $2}')
      targets+=("$tgt")
    else
      # non-comment, non-empty and not bind line: consider second column as partition mountpoint
      trimmed=$(echo "$line" | sed -e 's/^\s*//' -e 's/\s*$//')
      if [[ -n "$trimmed" && ${trimmed:0:1} != "#" ]]; then
        parts=( $trimmed )
        if [[ ${#parts[@]} -ge 2 ]]; then
          # sanity: skip bind-like lines we already handled
          if [[ ! ("${parts[2]-}" == "none" && "${parts[3]-}" == "bind") ]]; then
            maybe_mp=${parts[1]}
            if [[ ${maybe_mp:0:1} == "/" ]]; then
              part_mp="$maybe_mp"
            fi
          fi
        fi
      fi
    fi
  done <<< "$block"
  BLOCK_TARGETS["$id"]="${targets[*]-}"
  BLOCK_PART_MP["$id"]="$part_mp"
done

# Dry-run: print details
if [[ $DRY_RUN -eq 1 ]]; then
  echo
  echo "Dry-run: would attempt to unmount and remove these blocks (no changes):"
  for id in "${BLOCK_IDS[@]}"; do
    echo "Block $id"
    echo "  partition mountpoint: ${BLOCK_PART_MP[$id]:-<none>}"
    echo "  targets: ${BLOCK_TARGETS[$id]:-<none>}"
  done
  echo
  echo "To perform removal, re-run without --dry-run and with sudo."
  exit 0
fi

# Unmount targets and partition mountpoints
for id in "${BLOCK_IDS[@]}"; do
  echo "Processing block $id"
  targets_str="${BLOCK_TARGETS[$id]}"
  # split targets_str into array
  IFS=$' ' read -r -a tarr <<< "$targets_str"
  # unmount in reverse order
  for ((i=${#tarr[@]}-1;i>=0;i--)); do
    t=${tarr[i]}
    if [[ -z "$t" ]]; then
      continue
    fi
    echo "Attempting umount $t"
    if umount "$t"; then
      echo "  umount $t succeeded"
    else
      echo "  umount $t failed"
      if [[ $FORCE -eq 1 ]]; then
        echo "  trying lazy unmount: umount -l $t"
        if umount -l "$t"; then
          echo "  lazy unmount $t succeeded"
        else
          echo "  lazy unmount $t failed"
        fi
      fi
    fi
  done

  mp="${BLOCK_PART_MP[$id]}"
  if [[ -n "$mp" ]]; then
    echo "Attempting umount partition mountpoint $mp"
    if umount "$mp"; then
      echo "  umount $mp succeeded"
    else
      echo "  umount $mp failed"
      if [[ $FORCE -eq 1 ]]; then
        echo "  trying lazy unmount: umount -l $mp"
        if umount -l "$mp"; then
          echo "  lazy umount $mp succeeded"
        else
          echo "  lazy umount $mp failed"
        fi
      fi
    fi
  fi

  # remove metadata file if exists
  meta="$META_DIR/$id.json"
  if [[ -f "$meta" ]]; then
    echo "Removing metadata $meta"
    rm -f "$meta" || echo "  failed to remove metadata $meta"
  fi
done

# Backup fstab and write new fstab without lind-mount blocks
cp "$FSTAB" "$BACKUP"
if awk '1' "$FSTAB" >/dev/null 2>&1; then
  awk 'BEGIN{skip=0} /# lind-mount BEGIN:/{skip=1; next} /# lind-mount END:/{skip=0; next} {if(!skip) print $0}' "$FSTAB" > "$TMP_NEW"
  mv "$TMP_NEW" "$FSTAB"
  sync
  echo "Backed up original fstab to $BACKUP and wrote new fstab without lind-mount blocks"
  echo "Running mount -a to refresh mounts"
  if mount -a; then
    echo "mount -a succeeded"
  else
    echo "mount -a failed; check logs and /etc/fstab" >&2
  fi
else
  echo "Failed to read $FSTAB" >&2
fi

echo "Done"
