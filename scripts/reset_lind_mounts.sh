#!/usr/bin/env bash
set -euo pipefail

# Reset all lindy managed blocks from /etc/fstab and optionally unmount targets and
# remove metadata under /var/lib/lindy.
#
# Usage:
#   ./scripts/reset_lind_mounts.sh        # dry-run, shows what would be removed
#   sudo ./scripts/reset_lind_mounts.sh --apply   # actually perform changes (must run as root)
#
# Safety:
# - The script creates a timestamped backup of /etc/fstab before replacing it when --apply is used.
# - By default it only shows the changes; you must explicitly pass --apply to modify system state.

SCRIPT_NAME=$(basename "$0")
APPLY=false
if [[ ${1:-} == "--apply" ]]; then
  APPLY=true
fi

if [[ "$APPLY" == true && $(id -u) -ne 0 ]]; then
  echo "ERROR: --apply requires root. Re-run with sudo or as root." >&2
  exit 1
fi

TS=$(date +%s)
TMP_FSTAB=$(mktemp /tmp/lind-fstab-cleaned.XXXXXX)
TMP_TARGETS=$(mktemp /tmp/lind-removed-targets.XXXXXX)

echo "Scanning /etc/fstab for '# lindy BEGIN:' blocks (dry-run)..."

# Extract cleaned fstab (removing lindy blocks) and collect bind targets from removed blocks
# Note: avoid using the awk keyword `in` as a variable name for portability.
awk -v targets_file="$TMP_TARGETS" '
  BEGIN { in_block = 0 }
  /^# lindy BEGIN:/ { in_block = 1; next }
  /^# lindy END:/ { in_block = 0; next }
  {
    if (in_block) {
      # look for bind lines: <src> <target> none bind 0 0
      if (NF >= 4 && $3 == "none" && $4 == "bind") {
        print $2 >> targets_file
      }
    } else {
      print
    }
  }
' /etc/fstab > "$TMP_FSTAB"

echo
echo "Removed/hidden lindy blocks would result in new /etc/fstab saved to: $TMP_FSTAB"
echo
if [[ -s "$TMP_TARGETS" ]]; then
  echo "Bind targets detected inside removed blocks (these would be unmounted):"
  sort -u "$TMP_TARGETS" | sed -e 's/^/  - /'
else
  echo "No bind targets were detected inside lindy blocks."
fi

echo
echo "What the new /etc/fstab would look like (first 200 lines):"
echo "---"
sed -n '1,200p' "$TMP_FSTAB"
echo "---"

if [[ "$APPLY" != true ]]; then
  echo
  echo "Dry-run complete. To actually apply these changes and remove all lindy blocks, run:" 
  echo "  sudo $0 --apply"
  echo "The script will:"
  echo "  - attempt to unmount detected bind targets (try normal umount, then lazy umount),"
  echo "  - back up /etc/fstab to /etc/fstab.lind-reset.bak.<ts>, replace /etc/fstab atomically, run sync and mount -a,"
  echo "  - remove metadata files under /var/lib/lindy/*.json"
  echo
  # leave temp files for inspection
  echo "Temporary files retained for inspection:" 
  echo "  cleaned fstab -> $TMP_FSTAB"
  echo "  removed targets -> $TMP_TARGETS"
  exit 0
fi

### APPLY MODE (must be root)
echo "Applying reset: unmounting targets, replacing /etc/fstab, running mount -a, removing metadata..."

# Backup current fstab
BACKUP=/etc/fstab.lind-reset.bak.$TS
echo "Backing up /etc/fstab -> $BACKUP"
cp /etc/fstab "$BACKUP"

# Unmount targets (if any) in reverse order to reduce child->parent issues
if [[ -s "$TMP_TARGETS" ]]; then
  echo "Attempting to unmount targets:" 
  mapfile -t TARGETS < <(sort -u "$TMP_TARGETS")
  # reverse order (parents last). If multiple under same parent, order isn't strict but this helps.
  for (( idx=${#TARGETS[@]}-1 ; idx>=0 ; idx-- )); do
    t=${TARGETS[idx]}
    if [[ -z "$t" ]]; then
      continue
    fi
    echo "-> trying umount $t"
    if umount "$t"; then
      echo "   umount $t succeeded"
    else
      echo "   umount $t failed; trying lazy unmount (umount -l)"
      if umount -l "$t"; then
        echo "   lazy umount $t succeeded"
      else
        echo "   lazy umount $t also failed; leaving mounted and continuing" >&2
      fi
    fi
  done
else
  echo "No bind targets to unmount."
fi

# Move new fstab into place atomically
echo "Replacing /etc/fstab with cleaned version -> $BACKUP preserved"
mv "$TMP_FSTAB" /etc/fstab
sync

echo "Running mount -a to refresh mounts"
if mount -a; then
  echo "mount -a completed"
else
  echo "mount -a reported errors (see output above). Check /etc/fstab and restore backup if needed:" 
  echo "  sudo cp $BACKUP /etc/fstab && sudo sync && sudo mount -a"
fi

# Remove metadata files under /var/lib/lindy
if [[ -d /var/lib/lindy ]]; then
  echo "Removing metadata files under /var/lib/lindy"
  rm -f /var/lib/lindy/*.json || true
else
  echo "/var/lib/lindy does not exist; skipping metadata removal"
fi

echo "Cleanup: removing temporary targets file"
rm -f "$TMP_TARGETS"

echo "Reset completed. Keep backup at: $BACKUP"
echo "If something went wrong you can restore the original fstab with:"
echo "  sudo cp $BACKUP /etc/fstab && sudo sync && sudo mount -a"

exit 0
