// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::io::Write;
use std::os::unix::fs::PermissionsExt;

// Helper to run a constructed shell script via pkexec using a temp file.
// This avoids complex shell-quoting issues when passing a big script to
// `sh -c '...'` and is more portable across distros / shells.
fn run_pkexec_with_script(script: &str) -> Result<std::process::Output, std::io::Error> {
    use std::fs;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let pid = std::process::id();
    let path = format!("/tmp/lind-mount-pkexec-{}-{}.sh", pid, now);
    fs::write(&path, script)?;
    // make it executable (0700)
    let mut perms = fs::metadata(&path)?.permissions();
    perms.set_mode(0o700);
    fs::set_permissions(&path, perms)?;

    let out = Command::new("pkexec").arg("sh").arg(&path).output();

    // best-effort remove the temporary script
    let _ = fs::remove_file(&path);
    out
}
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![greet, generate_fstab_line, list_partitions, apply_fstab_block, list_fstab_blocks, remove_fstab_block, perform_mounts, adopt_block, find_block_for_target, remove_block_for_target])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// High-level command that performs the privileged sequence to apply a block and activate mounts.
/// This currently wraps `apply_fstab_block` to reuse its logic, but exists as a dedicated
/// entrypoint for the frontend to call when it wants a single in-app privileged operation.
#[tauri::command]
fn perform_mounts(
    block: &str,
    id: &str,
    targets: Vec<String>,
    partition_uuid: Option<String>,
    base_mount: Option<String>,
    add_partition_line: bool,
    force: Option<bool>,
) -> Result<String, String> {
    use std::fs;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    let do_force = force.unwrap_or(false);

    // Prepare block text, possibly inserting partition line
    let mut new_block = block.to_string();
    if add_partition_line {
        if let Some(uuid) = partition_uuid {
            let uuid_trim = uuid.trim();
            if !uuid_trim.is_empty() {
                let has_partition_line = new_block.lines().any(|l| l.trim_start().starts_with("UUID=") || l.contains(" x-systemd.automount "));
                if !has_partition_line {
                    let base = base_mount.unwrap_or_else(|| String::from("/mnt/shared"));
                    let partition_line = format!("UUID={} {} auto defaults,noatime,nofail,x-systemd.automount,x-systemd.device-timeout=10 0 2", uuid_trim, base);
                    if let Some(first_nl) = new_block.find('\n') {
                        let first = &new_block[..first_nl];
                        let rest = &new_block[first_nl+1..];
                        if first.contains("# lind-mount BEGIN:") {
                            new_block = format!("{}\n{}\n{}", first, partition_line, rest);
                        } else {
                            new_block = format!("{}\n{}", partition_line, new_block);
                        }
                    } else {
                        new_block = format!("{}\n{}", partition_line, new_block);
                    }
                }
            }
        }
    }

    // write temp file
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let tmp_path = format!("/tmp/lind-mount-fstab-{}-{}.tmp", id, now);
    match fs::File::create(&tmp_path) {
        Ok(mut f) => {
            if let Err(e) = f.write_all(new_block.as_bytes()) {
                let _ = fs::remove_file(&tmp_path);
                return Err(format!("failed to write temp file: {}", e));
            }
        }
        Err(e) => return Err(format!("failed to create temp file: {}", e)),
    }

    // Proactively write metadata so the app keeps track of the mapping even if
    // the privileged persistence step (pkexec append to /etc/fstab) fails.
    // We'll update this metadata after attempting persistence to mark whether
    // it was actually written to /etc/fstab (persisted=true).
    let meta_dir = "/var/lib/lind-mount";
    let _ = fs::create_dir_all(meta_dir);
    let meta_path = format!("{}/{}.json", meta_dir, id);
    let initial_meta = serde_json::json!({
        "id": id,
        "block": new_block,
        "targets": targets,
        "installed_at": now,
        "persisted": false,
        "note": "pending persistence to /etc/fstab",
    });
    // best-effort write; ignore errors but try to persist a record
    let _ = fs::write(&meta_path, serde_json::to_string_pretty(&initial_meta).unwrap_or_default());

    // local helper to shell-escape a path for single-quoted or double-quoted use
    fn shell_escape_single_local(s: &str) -> String {
        if !s.contains('\'') {
            return format!("'{}'", s);
        }
        let mut out = String::new();
        out.push('"');
        for c in s.chars() {
            if c == '"' || c == '\\' || c == '$' || c == '`' || c == '\n' {
                out.push('\\');
            }
            out.push(c);
        }
        out.push('"');
        out
    }

    // build privileged shell command
    let backup = format!("/etc/fstab.lind-mount.bak.{}", now);
    // We'll attempt mount -a; on failure we'll collect fuser output for each target and optionally retry with lazy unmount
    let mut shell = String::new();
    shell.push_str("set -e\n");
    shell.push_str(&format!("cp /etc/fstab {backup} && cat {tmp} >> /etc/fstab && sync\n", backup = backup, tmp = tmp_path));

    shell.push_str("echo 'Attempting mount -a'\n");
    shell.push_str("if mount -a; then echo 'MOUNT_OK'; else\n");
    // collect fuser output for targets
    for t in &targets {
        let esc = shell_escape_single_local(t);
        shell.push_str(&format!("echo 'FUSER {t}:'; fuser -mv {esc} || true;\n", t = t, esc = esc));
    }
    if do_force {
        shell.push_str("echo 'Attempting lazy unmount of targets'\n");
        for t in &targets {
            let esc = shell_escape_single_local(t);
            shell.push_str(&format!("umount -l {esc} || true;\n", esc = esc));
        }
        shell.push_str("if mount -a; then echo 'MOUNT_OK_AFTER_LAZY'; else echo 'MOUNT_FAILED_AFTER_LAZY'; exit 4; fi\n");
    } else {
        shell.push_str("echo 'MOUNT_FAILED_DUE_TO_BUSY'; exit 3; fi\n");
    }

    // execute via pkexec using a temporary script file to avoid shell quoting pitfalls
    let output = match run_pkexec_with_script(&shell) {
        Ok(o) => o,
        Err(e) => {
            let resp = serde_json::json!({
                "status": "error",
                "code": "spawn_pkexec_failed",
                "message": format!("failed to spawn pkexec: {}", e),
                "stdout": "",
                "stderr": "",
            });
            let _ = fs::remove_file(&tmp_path);
            return Ok(serde_json::to_string(&resp).unwrap());
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    // Clean up temp file
    let _ = fs::remove_file(&tmp_path);

    if output.status.success() || stdout.contains("MOUNT_OK") || stdout.contains("MOUNT_OK_AFTER_LAZY") {
        // Update metadata to mark persistence succeeded
        let now2 = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        let meta_path = format!("{}/{}.json", meta_dir, id);
        let mut meta_obj = serde_json::json!({
            "id": id,
            "block": new_block,
            "targets": targets,
            "installed_at": now,
        });
        meta_obj["persisted"] = serde_json::Value::Bool(true);
        meta_obj["persisted_at"] = serde_json::json!(now2);
        meta_obj["persist_stdout"] = serde_json::json!(stdout.clone());
        meta_obj["persist_stderr"] = serde_json::json!(stderr.clone());
        let _ = fs::write(&meta_path, serde_json::to_string_pretty(&meta_obj).unwrap_or_default());
        let resp = serde_json::json!({
            "status": "ok",
            "code": "applied",
            "message": "fstab block appended and mount -a executed",
            "stdout": stdout,
            "stderr": stderr,
        });
        Ok(serde_json::to_string(&resp).unwrap())
    } else {
        // Update metadata to record persistence failure but keep the record so the app
        // knows there is an attempted mapping (not persisted).
        let meta_path = format!("{}/{}.json", meta_dir, id);
        let mut meta_obj = serde_json::json!({
            "id": id,
            "block": new_block,
            "targets": targets,
            "installed_at": now,
        });
        meta_obj["persisted"] = serde_json::Value::Bool(false);
        meta_obj["persist_error"] = serde_json::json!(format!("pkexec exit code: {:?}", output.status.code()));
        meta_obj["persist_stdout"] = serde_json::json!(stdout.clone());
        meta_obj["persist_stderr"] = serde_json::json!(stderr.clone());
        let _ = fs::write(&meta_path, serde_json::to_string_pretty(&meta_obj).unwrap_or_default());

        // check exit code to determine busy vs other failure
        let code = output.status.code();
        let resp = if code == Some(3) || stdout.contains("MOUNT_FAILED_DUE_TO_BUSY") {
            serde_json::json!({
                "status": "error",
                "code": "busy",
                "message": "mount failed due to busy targets; fuser output included",
                "stdout": stdout,
                "stderr": stderr,
            })
        } else if code == Some(4) || stdout.contains("MOUNT_FAILED_AFTER_LAZY") {
            serde_json::json!({
                "status": "error",
                "code": "mount_failed_after_lazy",
                "message": "mount -a failed even after lazy unmount attempts",
                "stdout": stdout,
                "stderr": stderr,
            })
        } else {
            serde_json::json!({
                "status": "error",
                "code": "pkexec_failed",
                "message": format!("pkexec exited with code {:?}", code),
                "stdout": stdout,
                "stderr": stderr,
            })
        };
        Ok(serde_json::to_string(&resp).unwrap())
    }
}

#[tauri::command]
fn adopt_block(id: &str) -> Result<String, String> {
    use std::fs;
    // read /etc/fstab and find the block text and targets for the given id
    let content = fs::read_to_string("/etc/fstab").map_err(|e| format!("failed reading /etc/fstab: {}", e))?;
    let mut in_block = false;
    let mut found = false;
    let mut block_lines: Vec<String> = Vec::new();
    let mut targets: Vec<String> = Vec::new();
    for line in content.lines() {
        if line.contains(&format!("# lind-mount BEGIN: {}", id)) {
            in_block = true;
            found = true;
            block_lines.push(line.to_string());
            continue;
        }
        if in_block {
            block_lines.push(line.to_string());
            if line.contains(&format!("# lind-mount END: {}", id)) {
                in_block = false;
                break;
            }
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 6 && parts[2] == "none" && parts[3] == "bind" {
                targets.push(parts[1].to_string());
            }
        }
    }
    if !found {
        return Err(format!("block id {} not found in /etc/fstab", id));
    }
    let block_text = block_lines.join("\n") + "\n";
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    let meta = serde_json::json!({
        "id": id,
        "block": block_text,
        "targets": targets,
        "installed_at": now,
    });
    let meta_dir = "/var/lib/lind-mount";
    let _ = fs::create_dir_all(meta_dir);
    let meta_path = format!("{}/{}.json", meta_dir, id);
    fs::write(&meta_path, serde_json::to_string_pretty(&meta).unwrap_or_default()).map_err(|e| format!("failed to write metadata: {}", e))?;
    let resp = serde_json::json!({
        "status": "ok",
        "code": "adopted",
        "message": format!("adopted block {}", id),
    });
    Ok(serde_json::to_string(&resp).unwrap())
}

/// Append a marked fstab block to /etc/fstab (requires elevation via pkexec).
/// The frontend should send a full block including BEGIN/END markers. This command:
/// - writes the block to a secure temp file
/// - runs pkexec to back up /etc/fstab and append the block, then runs `mount -a`
/// - returns stdout/stderr or an error string
#[tauri::command]
fn apply_fstab_block(block: &str, id: &str, targets: Vec<String>) -> Result<String, String> {
    use std::fs;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    // Prevent accidental duplicate target mountpoints: ensure none of the requested
    // targets are already present in /etc/fstab or in existing metadata entries.
    // This avoids creating duplicate mountpoints which cause duplicate icons.
    if !targets.is_empty() {
        // Read /etc/fstab once and scan for any existing references to the requested targets.
        // If a matching line belongs to a lind-mount marked block, and metadata for that block
        // is missing, automatically create metadata (adopt) instead of failing. If the matching
        // line is not inside a lind-mount block, reject to avoid creating duplicate targets.
        if let Ok(fstab_str) = std::fs::read_to_string("/etc/fstab") {
            // We'll iterate lines and keep track of whether we're inside a lind-mount block
            // and what the current block id is so we can adopt it if needed.
            let mut current_block_id: Option<String> = None;
            // Map of block id -> Vec<target lines> (for later metadata creation)
            use std::collections::HashMap;
            let mut block_targets: HashMap<String, Vec<String>> = HashMap::new();
            let mut block_texts: HashMap<String, Vec<String>> = HashMap::new();

            for line in fstab_str.lines() {
                if let Some(pos) = line.find("# lind-mount BEGIN:") {
                    let id = line[pos + "# lind-mount BEGIN:".len()..].trim().to_string();
                    current_block_id = Some(id.clone());
                    block_texts.entry(id.clone()).or_default().push(line.to_string());
                    continue;
                }
                if let Some(ref id) = current_block_id {
                    block_texts.entry(id.clone()).or_default().push(line.to_string());
                    if line.contains("# lind-mount END:") {
                        current_block_id = None;
                        continue;
                    }
                    // inspect bind lines inside block
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() >= 6 && parts[2] == "none" && parts[3] == "bind" {
                        let target = parts[1].to_string();
                        block_targets.entry(id.clone()).or_default().push(target);
                    }
                    continue;
                }
                // not inside a block; nothing to record
            }

            // Now check each requested target against blocks and non-block lines.
            for t in &targets {
                // first, check whether any known block already contains this target
                let mut found_in_block: Option<String> = None;
                for (bid, tvec) in &block_targets {
                    if tvec.iter().any(|x| x == t) {
                        found_in_block = Some(bid.clone());
                        break;
                    }
                }
                if let Some(block_id) = found_in_block {
                    // If metadata already exists for this block, treat as duplicate/managed
                    let meta_dir = "/var/lib/lind-mount";
                    let meta_path = format!("{}/{}.json", meta_dir, block_id);
                    if std::path::Path::new(&meta_path).exists() {
                        return Err(format!("target {} already managed by app (metadata {}).", t, meta_path));
                    }
                    // Metadata missing: adopt the block by writing metadata derived from the block text
                    if let Some(text_lines) = block_texts.get(&block_id) {
                        let block_text = text_lines.join("\n") + "\n";
                        // Metadata is missing: inform the caller that an existing managed block could be adopted.
                        let resp = serde_json::json!({
                            "status": "adoptable",
                            "code": "adoptable_existing_block",
                            "message": format!("target {} already present in /etc/fstab inside block {}; adopt to let app manage it.", t, block_id),
                            "id": block_id,
                            "block": block_text,
                            "targets": block_targets.get(&block_id).cloned().unwrap_or_default(),
                        });
                        return Ok(serde_json::to_string(&resp).unwrap());
                    }
                }

                // Not found inside a lind-mount block: check raw /etc/fstab lines for exact target
                for line in fstab_str.lines() {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() >= 2 {
                        if parts[1] == t {
                            return Err(format!("target {} already present in /etc/fstab (line: {})", t, line));
                        }
                    }
                }
            }
        }

        // Check metadata dir for existing managed targets (unchanged)
        let meta_dir = "/var/lib/lind-mount";
        if let Ok(entries) = std::fs::read_dir(meta_dir) {
            for e in entries.flatten() {
                if let Ok(s) = std::fs::read_to_string(e.path()) {
                    if let Ok(j) = serde_json::from_str::<serde_json::Value>(&s) {
                        if let Some(jtargets) = j.get("targets") {
                            if let Some(arr) = jtargets.as_array() {
                                for jt in arr {
                                    if let Some(existing) = jt.as_str() {
                                        for t in &targets {
                                            if existing == t {
                                                return Err(format!("target {} already managed by app (metadata {}).", t, e.path().display()));
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Sanity-check inputs
    if block.trim().is_empty() {
        return Err("empty block".into());
    }
    if id.trim().is_empty() {
        return Err("missing id".into());
    }

    // Create a temp file in /tmp
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let tmp_path = format!("/tmp/lind-mount-fstab-{}-{}.tmp", id, now);
    match fs::File::create(&tmp_path) {
        Ok(mut f) => {
            if let Err(e) = f.write_all(block.as_bytes()) {
                let _ = fs::remove_file(&tmp_path);
                return Err(format!("failed to write temp file: {}", e));
            }
        }
        Err(e) => return Err(format!("failed to create temp file: {}", e)),
    }

    // Build the privileged shell command: backup fstab, append temp file, run mount -a
    let backup = format!("/etc/fstab.lind-mount.bak.{}", now);
    let cmd = format!("cp /etc/fstab {backup} && cat {tmp} >> /etc/fstab && mount -a", backup = backup, tmp = tmp_path);

    // Execute via pkexec so a polkit prompt appears
    // Log the command for debugging (append-only)
    let _ = std::fs::OpenOptions::new().create(true).append(true).open("/tmp/lind-mount-debug.log").and_then(|mut f| {
        let _ = writeln!(f, "[{}] apply_fstab_block id={} cmd=---\n{}---", now, id, cmd);
        Ok(())
    });

    let output = match run_pkexec_with_script(&cmd) {
        Ok(o) => o,
        Err(e) => {
            // Return structured JSON describing the failure to spawn pkexec
            let resp = serde_json::json!({
                "status": "error",
                "code": "spawn_pkexec_failed",
                "message": format!("failed to spawn pkexec: {}", e),
                "stdout": "",
                "stderr": "",
            });
            return Ok(serde_json::to_string(&resp).unwrap());
        }
    };

    // Clean up temp file
    let _ = fs::remove_file(&tmp_path);

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let _ = std::fs::OpenOptions::new().create(true).append(true).open("/tmp/lind-mount-debug.log").and_then(|mut f| {
        let _ = writeln!(f, "[{}] apply_fstab_block id={} exit={:?} stdout=---\n{}--- stderr=---\n{}---", now, id, output.status.code(), stdout, stderr);
        Ok(())
    });

    if output.status.success() {
        // Write metadata for this install so we can manage it later
        let meta_dir = "/var/lib/lind-mount";
        let _ = fs::create_dir_all(meta_dir);
        let meta_path = format!("{}/{}.json", meta_dir, id);
        let meta = serde_json::json!({
            "id": id,
            "block": block,
            "targets": targets,
            "installed_at": now,
        });
        let _ = fs::write(&meta_path, serde_json::to_string_pretty(&meta).unwrap_or_default());
        let resp = serde_json::json!({
            "status": "ok",
            "code": "applied",
            "message": "fstab block appended and mount -a executed",
            "stdout": stdout,
            "stderr": stderr,
        });
        Ok(serde_json::to_string(&resp).unwrap())
    } else {
        let resp = serde_json::json!({
            "status": "error",
            "code": "pkexec_failed",
            "message": format!("pkexec exited with code {:?}", output.status.code()),
            "stdout": stdout,
            "stderr": stderr,
        });
        Ok(serde_json::to_string(&resp).unwrap())
    }
}

#[derive(serde::Serialize)]
struct FstabBlock {
    id: String,
    text: String,
    targets: Vec<String>,
    // whether this block was created/recorded by our app (metadata exists)
    managed: bool,
}

/// Scan /etc/fstab for lind-mount marked blocks and return them.
#[tauri::command]
fn list_fstab_blocks() -> Result<Vec<FstabBlock>, String> {
    use std::fs;

    let mut blocks = Vec::new();

    // Try to read /etc/fstab directly. If we cannot read it (permission denied)
    // do NOT fall back to running a privileged `pkexec` here, because listing
    // the fstab at app startup would cause a polkit prompt (double prompts
    // when the app also performs a privileged operation). Instead, if reading
    // fails, return only metadata-managed blocks below.
    let content_opt = match fs::read_to_string("/etc/fstab") {
        Ok(s) => Some(s),
        Err(_) => None,
    };

    if let Some(content) = content_opt {
        let mut lines = content.lines();

        // First collect blocks found in /etc/fstab
        while let Some(line) = lines.next() {
            if let Some(pos) = line.find("# lind-mount BEGIN:") {
                // extract id
                let id = line[pos + "# lind-mount BEGIN:".len()..].trim().to_string();
                let mut block_lines = Vec::new();
                block_lines.push(line.to_string());
                let mut targets = Vec::new();
                // collect until END
                for l in &mut lines {
                    block_lines.push(l.to_string());
                    if l.contains("# lind-mount END:") {
                        break;
                    }
                    // detect bind lines: format: <src> <target> none bind 0 0
                    let parts: Vec<&str> = l.split_whitespace().collect();
                    if parts.len() >= 6 && parts[2] == "none" && parts[3] == "bind" {
                        let target = parts[1].to_string();
                        targets.push(target);
                    }
                }
                // managed will be set below if metadata exists
                blocks.push(FstabBlock { id, text: block_lines.join("\n"), targets, managed: false });
            }
        }
    }

    // Now read metadata directory to mark managed blocks and include metadata-only entries
    let meta_dir = "/var/lib/lind-mount";
    if let Ok(entries) = fs::read_dir(meta_dir) {
        for e in entries.flatten() {
            if let Ok(s) = fs::read_to_string(e.path()) {
                if let Ok(j) = serde_json::from_str::<serde_json::Value>(&s) {
                    if let Some(idv) = j.get("id").and_then(|x| x.as_str()) {
                        let id = idv.to_string();
                        // find existing block by id
                        if let Some(b) = blocks.iter_mut().find(|b| b.id == id) {
                            b.managed = true;
                            // If metadata contains a prettier block text, prefer it
                            if let Some(bt) = j.get("block").and_then(|x| x.as_str()) {
                                b.text = bt.to_string();
                            }
                            continue;
                        }
                        // otherwise create a metadata-only entry
                        let mut targets: Vec<String> = Vec::new();
                        if let Some(tarr) = j.get("targets").and_then(|x| x.as_array()) {
                            for tv in tarr { if let Some(ts) = tv.as_str() { targets.push(ts.to_string()); } }
                        }
                        let txt = j.get("block").and_then(|x| x.as_str()).unwrap_or("(managed by app)").to_string();
                        blocks.push(FstabBlock { id, text: txt, targets, managed: true });
                    }
                }
            }
        }
    }

    Ok(blocks)
}

/// Find the lind-mount block id (if any) that contains the given target path.
/// Returns Some(id) when found, or None when no matching block exists.
#[tauri::command]
fn find_block_for_target(target: &str) -> Result<Option<String>, String> {
    use std::fs;
    use std::process::Command;
    let t = target.trim();
    if t.is_empty() {
        return Ok(None);
    }
    // scan /etc/fstab blocks first; try direct read. If permission prevents reading, do NOT invoke pkexec here
    // because callers (frontend) may want to avoid triggering multiple polkit prompts. If local read fails
    // we will fall back to scanning metadata only.
    let content_opt = match fs::read_to_string("/etc/fstab") {
        Ok(s) => Some(s),
        Err(_) => None,
    };
    if let Some(content) = content_opt {
        let mut lines = content.lines();
        while let Some(line) = lines.next() {
            if let Some(pos) = line.find("# lind-mount BEGIN:") {
                let id = line[pos + "# lind-mount BEGIN:".len()..].trim().to_string();
                // collect until END
                for l in &mut lines {
                    if l.contains("# lind-mount END:") {
                        break;
                    }
                    let parts: Vec<&str> = l.split_whitespace().collect();
                    if parts.len() >= 4 && parts[2] == "none" && parts[3] == "bind" {
                        if parts[1] == t {
                            return Ok(Some(id));
                        }
                    }
                }
            }
        }
    }

    // check metadata directory as fallback
    let meta_dir = "/var/lib/lind-mount";
    if let Ok(entries) = fs::read_dir(meta_dir) {
        for e in entries.flatten() {
            if let Ok(s) = fs::read_to_string(e.path()) {
                if let Ok(j) = serde_json::from_str::<serde_json::Value>(&s) {
                    if let Some(jtargets) = j.get("targets") {
                        if let Some(arr) = jtargets.as_array() {
                            for jt in arr {
                                if let Some(ts) = jt.as_str() {
                                    if ts == t {
                                        if let Some(idv) = j.get("id").and_then(|x| x.as_str()) {
                                            return Ok(Some(idv.to_string()));
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(None)
}

/// Find a block for a target then perform removal in a single operation.
#[tauri::command]
fn remove_block_for_target(target: &str, force: bool) -> Result<String, String> {
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};
    use std::fs;

    if target.trim().is_empty() {
        return Err("missing target".into());
    }

    // shell-escape single-quoted value (simple helper)
    fn shell_escape_single(s: &str) -> String {
        if !s.contains('\'') {
            return format!("'{}'", s);
        }
        let mut out = String::new();
        out.push('"');
        for c in s.chars() {
            if c == '"' || c == '\\' || c == '$' || c == '`' || c == '\n' {
                out.push('\\');
            }
            out.push(c);
        }
        out.push('"');
        out
    }

    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let tgt_esc = shell_escape_single(target);
    let newtmp = format!("/tmp/lind-mount-newfst-{}-{}.tmp", "by-target", now);

    // Build a single privileged shell script that:
    // 1) finds the block id that contains the given target
    // 2) extracts bind targets for that block and unmounts them
    // 3) writes a new fstab without the block and atomically replaces /etc/fstab
    // 4) runs mount -a
    let mut cmd = String::new();
    cmd.push_str("set -e\n");

    // find id containing the target
    cmd.push_str("id=$(awk -v t=");
    cmd.push_str(&tgt_esc);
    cmd.push_str(" 'BEGIN{block=0;id=\"\"} /^# lind-mount BEGIN: /{id=$0; sub(/^.*BEGIN: /,\"\", id); block=1; next} /^# lind-mount END: /{block=0; next} block && $0 ~ /[[:space:]]none[[:space:]]bind[[:space:]]/ && $2==t {print id; exit}' /etc/fstab)\n");

    cmd.push_str("if [ -z \"$id\" ]; then echo '{\"status\":\"error\",\"code\":\"not_found\",\"message\":\"no managed block found for target\"}'; exit 5; fi\n");

    // collect bind targets into tmp file
    cmd.push_str("awk -v id=\"$id\" 'BEGIN{in_block=0} $0 ~ (\"# lind-mount BEGIN: \" id) {in_block=1; next} $0 ~ (\"# lind-mount END: \" id) {in_block=0; next} in_block && $0 ~ /[[:space:]]none[[:space:]]bind[[:space:]]/ {print $2}' /etc/fstab > /tmp/lind_targets.$id\n");

    // unmount targets
    if force {
        cmd.push_str("for t in $(cat /tmp/lind_targets.$id 2>/dev/null || true); do echo Attempt umount $t; umount \"$t\" || umount -l \"$t\" || true; done\n");
    } else {
        cmd.push_str("for t in $(cat /tmp/lind_targets.$id 2>/dev/null || true); do echo Attempt umount $t; if umount \"$t\"; then echo ok; else echo failed; exit 2; fi; done\n");
    }

    // create new fstab without the block
    cmd.push_str("awk -v id=\"$id\" 'BEGIN{skip=0} $0 ~ (\"# lind-mount BEGIN: \" id) {skip=1; next} $0 ~ (\"# lind-mount END: \" id) {skip=0; next} { if(!skip) print $0 }' /etc/fstab > ");
    cmd.push_str(&newtmp);
    cmd.push_str("\n");

    cmd.push_str(&format!(
        "cp /etc/fstab /etc/fstab.lind-mount.bak.{now} && mv {new} /etc/fstab && sync && mount -a\n",
        now = now,
        new = newtmp
    ));

    // Log command
    let _ = fs::OpenOptions::new().create(true).append(true).open("/tmp/lind-mount-debug.log").and_then(|mut f| {
        let _ = writeln!(f, "[{}] remove_block_for_target target={} cmd=---\n{}---", now, target, cmd);
        Ok(())
    });

    let output = match run_pkexec_with_script(&cmd) {
        Ok(o) => o,
        Err(e) => {
            return Err(format!("failed to spawn pkexec: {}", e));
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let code = output.status.code();

    let _ = fs::OpenOptions::new().create(true).append(true).open("/tmp/lind-mount-debug.log").and_then(|mut f| {
        let _ = writeln!(f, "[{}] remove_block_for_target target={} exit={:?} stdout=---\n{}--- stderr=---\n{}---", now, target, code, stdout, stderr);
        Ok(())
    });

    if output.status.success() {
        // remove metadata file if present
        // attempt to infer id from stdout? but safer to remove any metadata that contains the target
        if let Ok(entries) = fs::read_dir("/var/lib/lind-mount") {
            for e in entries.flatten() {
                if let Ok(s) = fs::read_to_string(e.path()) {
                    if s.contains(target) {
                        let _ = fs::remove_file(e.path());
                    }
                }
            }
        }
        return Ok(stdout);
    }
    Err(format!("pkexec exited with code {:?}: {}", code, stderr))
}

/// Remove a marked fstab block by id: unmount targets, remove block from /etc/fstab, backup original.
#[tauri::command]
fn remove_fstab_block(id: &str, force: bool) -> Result<String, String> {
    use std::fs;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    if id.trim().is_empty() {
        return Err("missing id".into());
    }

    // Attempt to read /etc/fstab to extract targets and prepare a new fstab.
    // If reading fails due to permissions, fall back to building a privileged
    // shell script that performs the same extraction and replacement under pkexec
    // so the polkit prompt will appear and do the work as root.
    let maybe_content = fs::read_to_string("/etc/fstab");
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();

    // If we could read /etc/fstab normally, use the in-process parsing path.
    if let Ok(content) = maybe_content {
        let mut out_lines: Vec<String> = Vec::new();
        let mut in_block = false;
        let mut found = false;
        let mut targets: Vec<String> = Vec::new();

        for line in content.lines() {
            if line.contains(&format!("# lind-mount BEGIN: {}", id)) {
                in_block = true;
                found = true;
                continue;
            }
            if in_block {
                if line.contains(&format!("# lind-mount END: {}", id)) {
                    in_block = false;
                    continue;
                }
                // collect targets from bind lines
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 6 && parts[2] == "none" && parts[3] == "bind" {
                    let target = parts[1].to_string();
                    // validate absolute path
                    if !target.starts_with('/') {
                        return Err(format!("invalid target path: {}", target));
                    }
                    targets.push(target);
                }
                continue; // skip lines inside block
            }
            out_lines.push(line.to_string());
        }

        if !found {
            return Err(format!("block id {} not found", id));
        }

        // Build temp new fstab
        let newfst = format!("/tmp/lind-mount-newfst-{}-{}.tmp", id, now);
        fs::write(&newfst, out_lines.join("\n") + "\n").map_err(|e| format!("failed to write new fstab temp: {}", e))?;

        // helper to shell-escape single-quoted string safely
        fn shell_escape_single(s: &str) -> String {
            if !s.contains('\'') {
                return format!("'{}'", s);
            }
            let mut out = String::new();
            out.push('"');
            for c in s.chars() {
                if c == '"' || c == '\\' || c == '$' || c == '`' || c == '\n' {
                    out.push('\\');
                }
                out.push(c);
            }
            out.push('"');
            out
        }

        // Build the shell command string
        let mut cmd = String::new();
        cmd.push_str("set -e\n");

        // Unmount bind targets in reverse order to ensure children are unmounted before parents
        for t in targets.iter().rev() {
            if !t.starts_with('/') {
                return Err(format!("invalid target path: {}", t));
            }
            let esc = shell_escape_single(t);
            if force {
                cmd.push_str(&format!("echo Attempting umount {t}\nif umount {esc}; then echo umount {t} succeeded; else echo umount {t} failed, trying lazy unmount; if umount -l {esc}; then echo lazy unmount {t} succeeded; else echo lazy unmount {t} failed; fi; fi\n", t = t, esc = esc));
            } else {
                cmd.push_str(&format!("echo Attempting umount {t}\nif umount {esc}; then echo umount {t} succeeded; else echo umount {t} failed; exit 2; fi\n", t = t, esc = esc));
            }
        }

        // Attempt to find and unmount a partition mountpoint inside the block (non-bind line)
        let mut partition_mountpoint: Option<String> = None;
        let mut in_b = false;
        for l in content.lines() {
            if l.contains(&format!("# lind-mount BEGIN: {}", id)) {
                in_b = true;
                continue;
            }
            if in_b {
                if l.contains(&format!("# lind-mount END: {}", id)) {
                    break;
                }
                let trimmed = l.trim();
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    continue;
                }
                let parts: Vec<&str> = trimmed.split_whitespace().collect();
                if parts.len() >= 2 {
                    if !(parts.len() >= 6 && parts[2] == "none" && parts[3] == "bind") {
                        let mp = parts[1].to_string();
                        if mp.starts_with('/') {
                            partition_mountpoint = Some(mp);
                            break;
                        }
                    }
                }
            }
        }

        if let Some(mp) = partition_mountpoint {
            let esc = shell_escape_single(&mp);
            if force {
                cmd.push_str(&format!("echo Attempting umount {mp}\nif umount {esc}; then echo umount {mp} succeeded; else echo umount {mp} failed, trying lazy unmount; if umount -l {esc}; then echo lazy unmount {mp} succeeded; else echo lazy unmount {mp} failed; fi; fi\n", mp = mp, esc = esc));
            } else {
                cmd.push_str(&format!("echo Attempting umount {mp}\nif umount {esc}; then echo umount {mp} succeeded; else echo umount {mp} failed; exit 2; fi\n", mp = mp, esc = esc));
            }
        }

        let backup = format!("/etc/fstab.lind-mount.bak.{}", now);
        cmd.push_str(&format!("cp /etc/fstab {backup} && mv {new} /etc/fstab && sync && mount -a\n", backup = backup, new = newfst));

        // Run via pkexec so polkit prompt appears
        // Log command for debugging
        let _ = std::fs::OpenOptions::new().create(true).append(true).open("/tmp/lind-mount-debug.log").and_then(|mut f| {
            let _ = writeln!(f, "[{}] remove_fstab_block id={} cmd=---\n{}---", now, id, cmd);
            Ok(())
        });

        let output = match run_pkexec_with_script(&cmd) {
            Ok(o) => o,
            Err(e) => {
                let resp = serde_json::json!({
                    "status": "error",
                    "code": "spawn_pkexec_failed",
                    "message": format!("failed to spawn pkexec: {}", e),
                    "stdout": "",
                    "stderr": "",
                });
                return Ok(serde_json::to_string(&resp).unwrap());
            }
        };
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let _ = std::fs::OpenOptions::new().create(true).append(true).open("/tmp/lind-mount-debug.log").and_then(|mut f| {
            let _ = writeln!(f, "[{}] remove_fstab_block (pkexec-branch) id={} exit={:?} stdout=---\n{}--- stderr=---\n{}---", now, id, output.status.code(), stdout, stderr);
            Ok(())
        });
        let _ = std::fs::OpenOptions::new().create(true).append(true).open("/tmp/lind-mount-debug.log").and_then(|mut f| {
            let _ = writeln!(f, "[{}] remove_fstab_block id={} exit={:?} stdout=---\n{}--- stderr=---\n{}---", now, id, output.status.code(), stdout, stderr);
            Ok(())
        });

        if output.status.success() {
            // remove metadata file if present
            let meta_path = format!("/var/lib/lind-mount/{}.json", id);
            let _ = fs::remove_file(&meta_path);
            let resp = serde_json::json!({
                "status": "ok",
                "code": "removed",
                "message": "fstab block removed and mount -a executed",
                "stdout": stdout,
                "stderr": stderr,
            });
            return Ok(serde_json::to_string(&resp).unwrap());
        } else {
            let resp = serde_json::json!({
                "status": "error",
                "code": "pkexec_failed",
                "message": format!("pkexec exited with code {:?}", output.status.code()),
                "stdout": stdout,
                "stderr": stderr,
            });
            return Ok(serde_json::to_string(&resp).unwrap());
        }
    } else {
        // Could not read /etc/fstab locally; build a privileged shell to extract and remove the block entirely under pkexec.
        let newtmp = format!("/tmp/lind-mount-newfst-{}-{}.tmp", id, now);
    // AWK script to print bind targets between markers (ensure trailing newline so concatenation with subsequent shell code is safe)
    // Use a non-reserved variable name `in_block` (some awk implementations treat `in` as the in-operator)
    let awk_targets = format!(r#"awk 'BEGIN{{in_block=0}} $0 ~ /^# lind-mount BEGIN: {id}$/{{in_block=1; next}} $0 ~ /^# lind-mount END: {id}$/{{in_block=0; next}} in_block && $0 ~ /[[:space:]]none[[:space:]]bind[[:space:]]/ {{ print $2 }}' /etc/fstab > /tmp/lind_targets.{id}
"#, id = id);
        // AWK script to create new fstab without the block
        let awk_newfst = format!("awk 'BEGIN{{skip=0}} $0 ~ /^# lind-mount BEGIN: {id}$/{{skip=1; next}} $0 ~ /^# lind-mount END: {id}$/{{skip=0; next}} {{ if(!skip) print $0 }}' /etc/fstab > {newtmp}", id = id, newtmp = newtmp);

        let mut cmd = String::new();
        cmd.push_str("set -e\n");
        cmd.push_str(&awk_targets);
        // unmount targets read from file
        cmd.push_str(&format!("for t in $(cat /tmp/lind_targets.{id} 2>/dev/null || true); do echo Attempt umount $t; if umount \"$t\"; then echo umount $t ok; else echo umount $t failed, trying lazy; umount -l \"$t\" || true; fi; done\n", id = id));
        cmd.push_str(&awk_newfst);
        cmd.push_str(&format!("cp /etc/fstab /etc/fstab.lind-mount.bak.{now} && mv {newtmp} /etc/fstab && sync && mount -a\n", now = now, newtmp = newtmp));

        // Log the constructed privileged command for debugging (append-only)
        let _ = std::fs::OpenOptions::new().create(true).append(true).open("/tmp/lind-mount-debug.log").and_then(|mut f| {
            let _ = writeln!(f, "[{}] remove_fstab_block (pkexec-branch) id={} cmd=---\n{}---", now, id, cmd);
            Ok(())
        });

        let output = match run_pkexec_with_script(&cmd) {
            Ok(o) => o,
            Err(e) => {
                let resp = serde_json::json!({
                    "status": "error",
                    "code": "spawn_pkexec_failed",
                    "message": format!("failed to spawn pkexec: {}", e),
                    "stdout": "",
                    "stderr": "",
                });
                return Ok(serde_json::to_string(&resp).unwrap());
            }
        };

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        if output.status.success() {
            let meta_path = format!("/var/lib/lind-mount/{}.json", id);
            let _ = fs::remove_file(&meta_path);
            let resp = serde_json::json!({
                "status": "ok",
                "code": "removed",
                "message": "fstab block removed and mount -a executed",
                "stdout": stdout,
                "stderr": stderr,
            });
            return Ok(serde_json::to_string(&resp).unwrap());
        } else {
            let resp = serde_json::json!({
                "status": "error",
                "code": "pkexec_failed",
                "message": format!("pkexec exited with code {:?}", output.status.code()),
                "stdout": stdout,
                "stderr": stderr,
            });
            return Ok(serde_json::to_string(&resp).unwrap());
        }
    }

    // All branches return above; nothing to do here.
    Ok(serde_json::to_string(&serde_json::json!({"status":"error","code":"internal","message":"unreachable"})).unwrap())
}

/// Build a recommended fstab line set for a shared partition + one bind mount mapping.
/// This does not write to /etc/fstab, it only returns preview text.
/// Parameters:
/// - partition_uuid: UUID of the shared partition (e.g. 53337bda-...)
/// - base_mount: mount point for the partition (e.g. /mnt/popos)
/// - src_inside_partition: absolute path inside the partition once mounted (e.g. /mnt/popos/home/dovndev/Projects)
/// - target_local: local path to bind onto (e.g. /home/dovndev/Projects)
#[tauri::command]
fn generate_fstab_line(
    partition_uuid: &str,
    base_mount: &str,
    src_inside_partition: &str,
    target_local: &str,
    skip_partition_mount: bool,
) -> String {
    // If user prefers not to include a partition mount line (already mounted) or UUID is empty,
    // only return the bind line. Otherwise include both lines.
    let bind_line = format!("{} {} none bind 0 0", src_inside_partition, target_local);
    if skip_partition_mount || partition_uuid.trim().is_empty() {
        return bind_line;
    }
    let partition_line = format!(
        "UUID={} {} auto defaults,noatime,nofail,x-systemd.automount,x-systemd.device-timeout=10 0 2",
        partition_uuid, base_mount
    );
    format!("{}\n{}", partition_line, bind_line)
}

#[derive(serde::Serialize)]
struct PartitionInfo {
    name: String,
    fstype: Option<String>,
    uuid: Option<String>,
    label: Option<String>,
    mountpoint: Option<String>,
    size: Option<String>,
}

/// List block devices (flattened) using lsblk JSON output.
#[tauri::command]
fn list_partitions() -> Result<Vec<PartitionInfo>, String> {
    use std::process::Command;
    let output = Command::new("lsblk")
        .args(["-J", "-o", "NAME,FSTYPE,UUID,LABEL,MOUNTPOINT,SIZE"]) // JSON
        .output()
        .map_err(|e| format!("failed to run lsblk: {}", e))?;
    if !output.status.success() {
        return Err("lsblk returned non-zero status".into());
    }
    let v: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("invalid lsblk json: {}", e))?;

    fn collect(vec: &mut Vec<PartitionInfo>, node: &serde_json::Value) {
        if let Some(name) = node.get("name").and_then(|x| x.as_str()) {
            let fstype = node.get("fstype").and_then(|x| x.as_str()).map(|s| s.to_string());
            let uuid = node.get("uuid").and_then(|x| x.as_str()).map(|s| s.to_string());
            let label = node.get("label").and_then(|x| x.as_str()).map(|s| s.to_string());
            let mountpoint = node.get("mountpoint").and_then(|x| x.as_str()).map(|s| s.to_string());
            let size = node.get("size").and_then(|x| x.as_str()).map(|s| s.to_string());
            vec.push(PartitionInfo { name: name.to_string(), fstype, uuid, label, mountpoint, size });
        }
        if let Some(children) = node.get("children").and_then(|x| x.as_array()) {
            for ch in children { collect(vec, ch); }
        }
    }

    let mut flat = Vec::new();
    if let Some(blockdevices) = v.get("blockdevices").and_then(|x| x.as_array()) {
        for dev in blockdevices { collect(&mut flat, dev); }
    }
    Ok(flat)
}

// Unit tests for backend logic. These tests avoid performing real privileged
// operations by ensuring `pkexec` in PATH exits non-zero; `perform_mounts`
// will therefore return a structured JSON with code `pkexec_failed` and will
// not write metadata under `/var/lib/lind-mount`.
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::env;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn test_perform_mounts_pkexec_failure() {
        // create a small temporary directory to host a fake `pkexec` binary
        let tmpdir = env::temp_dir().join(format!("lind_mount_test_pkexec_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmpdir);
        fs::create_dir(&tmpdir).expect("create temp dir");
        let pk = tmpdir.join("pkexec");

        // fake pkexec that immediately exits with code 5
        fs::write(&pk, "#!/bin/sh\nexit 5\n").expect("write fake pkexec");
        let mut perms = fs::metadata(&pk).expect("meta").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&pk, perms).expect("set perms");

        // prepend tmpdir to PATH so Command::new("pkexec") finds our fake
        let old_path = env::var("PATH").unwrap_or_default();
        let new_path = format!("{}:{}", tmpdir.display(), old_path);
    unsafe { env::set_var("PATH", &new_path); }

        let block = "# lind-mount BEGIN: testid\n/dev/fake /mnt/fake auto defaults 0 2\n# lind-mount END: testid\n";
        let id = "testid";
        let targets = vec!["/mnt/fake".to_string()];

        // Call perform_mounts; since our fake pkexec exits with code 5, we expect
        // a structured JSON response with code `pkexec_failed` (not `applied`).
        let res = perform_mounts(block, id, targets.clone(), None, None, false, Some(false)).expect("perform_mounts returned");
        let v: serde_json::Value = serde_json::from_str(&res).expect("parse json");
        assert_eq!(v.get("status").and_then(|s| s.as_str()), Some("error"));
        assert_eq!(v.get("code").and_then(|s| s.as_str()), Some("pkexec_failed"));

        // cleanup
        let _ = fs::remove_file(&pk);
        let _ = fs::remove_dir_all(&tmpdir);
    // restore PATH (best-effort)
    // pass as reference to avoid moving the string and to satisfy some linters/analysis tools
    unsafe { env::set_var("PATH", &old_path); }
    }
}

