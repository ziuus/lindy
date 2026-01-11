#!/usr/bin/env bash
set -euo pipefail

# fix_lindy.sh
# Rewrites /etc/fstab replacing any existing lindy block with
# a corrected block, runs mount -a and writes metadata. Designed to be
# run as root (we'll still use sudo for safety where appropriate).

ID=adopted_1764998824
TARGET=/home/dovndev/Desktop/bind
CORRECT_SRC=/media/dovndev/Windows1/asdq
BACKUP=/etc/fstab.bak.${ID}.$(date +%s)

echo "Backing up /etc/fstab -> $BACKUP"
sudo cp /etc/fstab "$BACKUP"

CLEAN=/tmp/fstab.cleaned.${ID}

echo "Removing any existing lindy block for $ID from /etc/fstab"
# Ensure the redirection is performed by a root shell. Use sudo sh -c for redirection.
sudo sh -c "awk -v id=\"$ID\" 'BEGIN{skip=0} index(\$0, \"# lindy BEGIN: \" id){skip=1; next} index(\$0, \"# lindy END: \" id){skip=0; next} { if(!skip) print \$0 }' /etc/fstab > '$CLEAN'"

echo "Appending corrected lindy block for $ID to $CLEAN"
sudo sh -c "cat >> '$CLEAN' <<'EOF'
# lindy BEGIN: $ID
$CORRECT_SRC $TARGET none bind 0 0
# lindy END: $ID
EOF"

echo "Installing cleaned fstab"
sudo mv "$CLEAN" /etc/fstab
sudo sync

echo "Attempting mount -a"
if sudo mount -a; then
  echo "mount -a succeeded"
else
  echo "mount -a failed; attempting to umount target and retry"
  sudo umount "$TARGET" || true
  if sudo mount -a; then
    echo "mount -a succeeded after umount"
  else
    echo "mount -a still failing" >&2
  fi
fi

# write metadata
sudo mkdir -p /var/lib/lindy
NOW=$(date +%s)
sudo sh -c "cat > /var/lib/lindy/${ID}.json <<'JSON'
{
  \"id\": \"${ID}\",
  \"block\": \"# lindy BEGIN: ${ID}\\n${CORRECT_SRC} ${TARGET} none bind 0 0\\n# lindy END: ${ID}\\n\",
  \"targets\": [\"${TARGET}\"],
  \"installed_at\": ${NOW},
  \"persisted\": true
}
JSON"

echo "WROTE /var/lib/lindy/${ID}.json"

# verification
echo
echo "--- /etc/fstab excerpt for $ID ---"
sudo awk "/# lindy BEGIN: ${ID}/,/# lindy END: ${ID}/" /etc/fstab || true

echo
echo "--- metadata ---"
sudo cat /var/lib/lindy/${ID}.json || true

echo
echo "--- findmnt for $TARGET ---"
findmnt --target "$TARGET" || echo "not mounted"
