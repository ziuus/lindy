import { useEffect, useState, useContext } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";
import Container from "@mui/material/Container";
import Grid from "@mui/material/Grid";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import Accordion from "@mui/material/Accordion";
import AccordionSummary from "@mui/material/AccordionSummary";
import AccordionDetails from "@mui/material/AccordionDetails";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import IconButton from "@mui/material/IconButton";
import DeleteIcon from "@mui/icons-material/Delete";
import Snackbar from "@mui/material/Snackbar";
import Alert from "@mui/material/Alert";
import Tabs from "@mui/material/Tabs";
import Tab from "@mui/material/Tab";
import Table from "@mui/material/Table";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TableCell from "@mui/material/TableCell";
import TableBody from "@mui/material/TableBody";
import Tooltip from "@mui/material/Tooltip";
import RefreshIcon from "@mui/icons-material/Refresh";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import CircularProgress from '@mui/material/CircularProgress';
import SwipeableViews from "react-swipeable-views";
import DarkModeIcon from '@mui/icons-material/DarkMode';
import LightModeIcon from '@mui/icons-material/LightMode';
import { ThemeContext } from './main';

type Mapping = {
  id: number;
  src?: string;
  target?: string;
};

function App() {
  const [rows, setRows] = useState<Mapping[]>([]);
  const [partitionUuid, setPartitionUuid] = useState("");
  const [skipPartition, setSkipPartition] = useState(false);
  const [baseMount, setBaseMount] = useState("/mnt/shared");
  const [parts, setParts] = useState<any[]>([]);
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState(0);

  const addRow = () => {
    setRows((r) => [...r, { id: Date.now() }]);
  };

  const pickDir = async (id: number, field: "src" | "target") => {
    try {
      console.log("Opening dialog...");
      const selection = await open({ directory: true, multiple: false });
      console.log("Selection:", selection);
      if (!selection || Array.isArray(selection)) return;
      setRows((prev) =>
        prev.map((row) => (row.id === id ? { ...row, [field]: selection } : row)),
      );
    } catch (err) {
      console.error("Error opening dialog:", err);
    }
  };

  const mountRow = (row: Mapping) => {
    // Open confirm dialog with generated script
    const script = buildScriptForRow(row);
    setDialogScript(script);
    setDialogOpen(true);
  };

  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogScript, setDialogScript] = useState<string>("");

  

  const buildScriptForRow = (r: Mapping) => {
    const lines: string[] = [];
    lines.push('#!/bin/sh');
    lines.push('set -e');
    // Ensure base mount exists and mount partition if needed
    if (!skipPartition && partitionUuid && partitionUuid.trim() !== '') {
      const safeBase = baseMount || '/mnt/shared';
      lines.push(`mkdir -p "${safeBase}"`);
      // Use mount by UUID if possible
      lines.push(`mount -U ${partitionUuid} "${safeBase}" || mount UUID=${partitionUuid} "${safeBase}" || true`);
    }
    // Create target and bind mount
    if (r.src && r.target) {
      lines.push(`mkdir -p "${r.target}"`);
      lines.push(`mount --bind "${r.src}" "${r.target}"`);
    }
    return lines.join('\n') + '\n';
  };

  // Accept common UUID / FS-ID formats returned by blkid/lsblk:
  // - standard 36-char UUID (8-4-4-4-12)
  // - FAT style (4-4) like 1234-ABCD
  // - 16 hex chars (some filesystems report 16-char ids)
  // - 32 hex chars (no-dash UUID)
  const isValidPartitionId = (u: string) => {
    const s = (u || '').trim();
    if (!s) return false;
    return (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s) ||
      /^[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}$/.test(s) ||
      /^[0-9a-f]{16}$/i.test(s) ||
      /^[0-9a-f]{32}$/i.test(s)
    );
  };

  const copyDialogScript = async () => {
    try {
      await navigator.clipboard.writeText(dialogScript);
      setCopied(true);
    } catch (e) {
      console.error('copy failed', e);
    }
  };

  const downloadDialogScript = () => {
    const blob = new Blob([dialogScript], { type: 'text/x-shellscript' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mount-script.sh';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const [preview, setPreview] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Don't generate preview if required inputs are missing
      if (!(baseMount && rows.some(r => r.src && r.target))) {
        setPreview([]);
        return;
      }
      // If user provided a partition UUID and didn't opt to skip mounting,
      // validate the partition id client-side and skip preview generation when invalid.
      if (!skipPartition && partitionUuid && !isValidPartitionId(partitionUuid)) {
        setPreview([]);
        return;
      }
      const lines: string[] = [];
      for (const r of rows) {
        if (!r.src || !r.target) continue;
        try {
          const text = await invoke<string>("generate_fstab_line", {
            partitionUuid,
            baseMount,
            srcInsidePartition: r.src,
            targetLocal: r.target,
            skipPartitionMount: skipPartition,
          });
          lines.push(text);
        } catch (e) {
          console.error("preview failed", e);
        }
      }
      if (!cancelled) setPreview(lines);
    })();
    return () => { cancelled = true; };
  }, [partitionUuid, baseMount, rows, skipPartition]);

  useEffect(() => {
    (async () => {
      try {
        const res = await invoke<any>("list_partitions");
        if (Array.isArray(res)) {
          const normalized = res.map((p: any) => {
            const copy = { ...p };
            if (copy.uuid && typeof copy.uuid === 'string') {
              // remove surrounding braces, trim and lowercase
              copy.uuid = copy.uuid.trim().replace(/^[\{\(]+|[\)\}]+$/g, '').toLowerCase();
            }
            return copy;
          });
          // log any uuids that still look suspicious
          normalized.forEach((p: any) => {
            if (p.uuid && !isValidPartitionId(p.uuid)) {
              console.warn('Non-standard UUID format detected for partition', p.name, p.uuid);
            }
          });
          setParts(normalized);
        }
      } catch (e) {
        console.warn("lsblk not available or failed", e);
      }
    })();
    // refresh installed persistent blocks on startup
    refreshInstalledBlocks();
  }, []);

  const removeRow = (id: number) => setRows(r => r.filter(x => x.id !== id));
  const refreshPartitions = async () => {
    try {
      const res = await invoke<any>("list_partitions");
      if (Array.isArray(res)) {
        const normalized = res.map((p: any) => {
          const copy = { ...p };
          if (copy.uuid && typeof copy.uuid === 'string') {
            copy.uuid = copy.uuid.trim().replace(/^[\{\(]+|[\)\}]+$/g, '').toLowerCase();
          }
          return copy;
        });
        normalized.forEach((p: any) => {
          if (p.uuid && !isValidPartitionId(p.uuid)) {
            console.warn('Non-standard UUID format detected for partition', p.name, p.uuid);
          }
        });
        setParts(normalized);
      }
    } catch (e) { console.warn(e); }
  };

  const [installedBlocks, setInstalledBlocks] = useState<Array<{id:string,text:string,targets:string[], managed?:boolean}>>([]);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [removeDialogId, setRemoveDialogId] = useState<string | null>(null);
  const [removeDialogTarget, setRemoveDialogTarget] = useState<string | null>(null);
  const [removeDialogForce, setRemoveDialogForce] = useState(false);
  const [adoptDialogOpen, setAdoptDialogOpen] = useState(false);
  const [adoptInfo, setAdoptInfo] = useState<{id: string, block: string, targets: string[]} | null>(null);
  const [opResultOpen, setOpResultOpen] = useState(false);
  const [opResultMessage, setOpResultMessage] = useState('');
  const [opResultHint, setOpResultHint] = useState<string | null>(null);
  const [pendingForceId, setPendingForceId] = useState<string | null>(null);
  const [applyInProgress, setApplyInProgress] = useState(false);
  const [applyResultOpen, setApplyResultOpen] = useState(false);
  const [applyResultMessage, setApplyResultMessage] = useState('');
  const [operationsLog, setOperationsLog] = useState<string[]>([]);

  const pushLog = (msg: string) => {
    setOperationsLog(l => [msg, ...l].slice(0, 50));
  };
  const refreshInstalledBlocks = async () => {
    try {
      const res = await invoke<any>('list_fstab_blocks');
      if (Array.isArray(res)) setInstalledBlocks(res);
    } catch (e) { console.warn('list_fstab_blocks failed', e); }
  };

  return (
  <Container maxWidth="md" sx={{ py: 2 }}>
      <Grid container alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
        <Grid item>
          <Typography variant="h4" fontWeight={700}>Mount Manager</Typography>
        </Grid>
        <Grid item>
          <Grid container alignItems="center" spacing={1} wrap="nowrap">
            <Grid item><ModeToggle /></Grid>
            <Grid item><AccentCycleButton /></Grid>
          </Grid>
        </Grid>
      </Grid>
      <Paper variant="outlined" sx={{ mb: 2 }}>
        <Tabs value={tab} onChange={(_,v)=>setTab(v)} variant="fullWidth">
          <Tab label="Main" />
          <Tab label="Disks" />
          <Tab label="Mappings" />
        </Tabs>
      </Paper>
  <SwipeableViews index={tab} onChangeIndex={(i:number)=>setTab(i)} enableMouseEvents>
        {/* Main Tab */}
        <div>

  <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Grid container spacing={2}>
          <Grid item xs={12} md={6}>
            {!skipPartition && (
              <>
                <FormControl fullWidth>
                  <InputLabel id="uuid-label" shrink>Partition (UUID)</InputLabel>
                  <Select
                    labelId="uuid-label"
                    label="Partition (UUID)"
                      value={partitionUuid}
                      onChange={(e) => {
                          const v = (e.target.value as string).trim().toLowerCase();
                          setPartitionUuid(v);
                        // Suggest a base mount point when user picks a partition and baseMount is the default
                        try {
                          const p = parts.find((pp: any) => pp.uuid === v);
                          if (p && (baseMount === '/mnt/shared' || baseMount.trim() === '')) {
                            const suggested = p.label ? `/mnt/${p.label}` : `/mnt/${v.slice(0,8)}`;
                            setBaseMount(suggested);
                          }
                        } catch (e) {
                          // ignore
                        }
                      }}
                    displayEmpty
                      renderValue={(selected) => {
                        if (!selected) {
                          return <em>Select a partition or type UUID below…</em>;
                        }
                        const part = parts.find(p => p.uuid === selected);
                        if (part) {
                          return `${selected} ${part.label ? `(${part.label})` : ''} ${part.fstype ? `· ${part.fstype}` : ''}`;
                        }
                        return selected as string;
                      }}
                  >
                    {parts
                      .filter(p => p.uuid)
                      .map((p) => (
                        <MenuItem key={p.uuid} value={p.uuid}>
                          {p.uuid} {p.label ? `(${p.label})` : ""} {p.fstype ? `· ${p.fstype}` : ""}
                        </MenuItem>
                      ))}
                  </Select>
                </FormControl>
                <TextField
                  sx={{ mt: 1 }}
                  fullWidth
                  label="UUID (manual)"
                  placeholder="53337bda-2dc1-4a14-a8d9-c1702ddd33d6"
                  value={partitionUuid}
                  onChange={(e) => setPartitionUuid(e.currentTarget.value.trim().toLowerCase())}
                  error={partitionUuid.trim() !== '' && !isValidPartitionId(partitionUuid.trim())}
                  helperText={partitionUuid.trim() !== '' && !isValidPartitionId(partitionUuid.trim()) ? 'Unrecognized partition id format (accepted: UUID, 4-4 FAT id, 16/32 hex)' : ''}
                />
              </>
            )}
          </Grid>
          <Grid item xs={12} md={6}>
            <TextField
              fullWidth
              label="Base mount point"
              placeholder="/mnt/shared or /mnt/popos"
              value={baseMount}
              onChange={(e) => setBaseMount(e.currentTarget.value)}
            />
            <Grid container alignItems="center" sx={{ mt: 1 }}>
              <Grid item>
                <input
                  id="skip-partition"
                  type="checkbox"
                  checked={skipPartition}
                  onChange={e => setSkipPartition(e.target.checked)}
                  style={{ marginRight: 6 }}
                />
              </Grid>
              <Grid item>
                <label htmlFor="skip-partition" style={{ cursor: 'pointer', fontSize: 13 }}>
                  Skip partition mount (already mounted)
                </label>
              </Grid>
            </Grid>
          </Grid>
        </Grid>
  </Paper>

  <Accordion sx={{ mb: 2 }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography variant="subtitle1">How to find your partition UUID</Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Typography variant="body2" gutterBottom>
            You can list your partitions and their UUIDs using:
          </Typography>
          <pre className="fstab-preview"><code>lsblk -o NAME,FSTYPE,UUID,LABEL,MOUNTPOINT,SIZE
blkid</code></pre>
          <Typography variant="body2" gutterBottom>
            Pick the UUID of the shared data partition (e.g., ext4 for Linux↔Linux, or ntfs for Linux↔Windows).
            We auto-detected entries above when possible.
          </Typography>
        </AccordionDetails>
  </Accordion>

  <Grid container alignItems="center" justifyContent="space-between" sx={{ mb: 1, mt: 2 }}>
        <Grid item>
          <Typography variant="h6">Mappings</Typography>
        </Grid>
        <Grid item>
          <Button variant="contained" color="primary" onClick={addRow}>Add Mapping</Button>
        </Grid>
      </Grid>
      <Grid container direction="column" spacing={1} sx={{ mb: 2 }}>
        {rows.length === 0 && (
          <Grid item>
            <Typography variant="body2" color="text.secondary">
              Click Add Mapping to select folders.
            </Typography>
          </Grid>
        )}
        {rows.map((row) => (
          <Grid item key={row.id}>
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Grid container spacing={2} alignItems="center">
                <Grid item xs={12} md={5}>
                  <TextField
                    fullWidth
                    label="Source (inside partition)"
                    value={row.src ?? ""}
                    placeholder="Choose folder…"
                    InputProps={{ readOnly: true }}
                    onClick={() => pickDir(row.id, "src")}
                  />
                </Grid>
                <Grid item xs={12} md={5}>
                  <TextField
                    fullWidth
                    label="Target (local bind point)"
                    value={row.target ?? ""}
                    placeholder="Choose folder…"
                    InputProps={{ readOnly: true }}
                    onClick={() => pickDir(row.id, "target")}
                  />
                </Grid>
                <Grid item xs={6} md={1}>
                  <Button
                    fullWidth
                    variant="outlined"
                    onClick={() => mountRow(row)}
                    disabled={!row.src || !row.target}
                  >
                    Mount
                  </Button>
                </Grid>
                <Grid item xs={6} md={1}>
                  <IconButton aria-label="remove" onClick={async () => {
                    // Try to remove the mapping by target in a single backend call.
                    // The new `remove_block_for_target` command will locate the block
                    // and perform the privileged removal (one pkexec invocation).
                    if (row.target) {
                      try {
                        setOpResultHint(null);
                        const res = await invoke<string>('remove_block_for_target', { target: row.target, force: true });
                        let parsed: any = null;
                        try { parsed = JSON.parse(res); } catch (_) { parsed = null; }
                        if (parsed && parsed.status === 'ok') {
                          setOpResultMessage(`Removed mapping for ${row.target}.`);
                          refreshInstalledBlocks();
                        } else if (parsed && parsed.status === 'error') {
                          setOpResultMessage(`Failed to remove mapping: ${parsed.message || parsed.code}`);
                          setOpResultHint((parsed.stderr || parsed.stdout) || null);
                        } else {
                          setOpResultMessage(`Remove result:\n${res}`);
                        }
                        setOpResultOpen(true);
                        return;
                      } catch (e:any) {
                        console.warn('remove_block_for_target failed', e);
                        // fallback to previous behavior: check installedBlocks and show removal dialog
                        const installed = installedBlocks.find(b => b.targets && b.targets.includes(row.target!));
                        if (installed) {
                          setRemoveDialogId(installed.id);
                          setRemoveDialogForce(true);
                          setRemoveDialogOpen(true);
                          return;
                        }
                      }
                    }
                    removeRow(row.id);
                  }}>
                    <DeleteIcon />
                  </IconButton>
                </Grid>
              </Grid>
            </Paper>
          </Grid>
        ))}
      </Grid>

      {rows.some((r) => r.src && r.target) && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Grid container alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
            <Grid item>
              <Typography variant="h6">Preview</Typography>
            </Grid>
            <Grid item>
              <Button variant="contained" onClick={() => {
                const text = document.querySelector('.fstab-preview code')?.textContent || '';
                navigator.clipboard.writeText(text).then(() => setCopied(true));
              }}>Copy fstab block</Button>
            </Grid>
          </Grid>
          <Typography variant="subtitle2" gutterBottom>Bind mappings</Typography>
          <ul>
            {rows
              .filter((r) => r.src && r.target)
              .map((r) => (
                <li key={`out-${r.id}`}>
                  <code>{r.target}</code> → <code>{r.src}</code>
                </li>
              ))}
          </ul>
          {preview.length > 0 && (
            <>
              <Typography variant="subtitle2" gutterBottom>fstab preview</Typography>
              <pre className="fstab-preview">
                <code>{(() => {
                  const unique = new Set<string>();
                  const blocks: string[] = [];
                  // Collect a single partition line and many bind lines.
                  preview.forEach(block => {
                    block.split('\n').forEach(line => {
                      if (line.includes(' auto ') && !Array.from(unique).some(l => l === line)) {
                        unique.add(line);
                      } else if (line.includes(' none bind ')) {
                        blocks.push(line);
                      }
                    });
                  });
                  return Array.from(unique).concat(blocks).join('\n');
                })()}</code>
              </pre>
            </>
          )}
        </Paper>
      )}
      {/* Mount confirmation dialog (script preview + copy/download) */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} fullWidth maxWidth="md">
        <DialogTitle>Confirm mount actions</DialogTitle>
        <DialogContent>
          <Typography variant="body2" gutterBottom>
            The following script will be created. You can copy or download it and run it with sudo, or run it via the elevated run option (coming next).
          </Typography>
          <pre className="fstab-preview" style={{ maxHeight: 360, overflow: 'auto' }}>
            <code>{dialogScript}</code>
          </pre>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Close</Button>
          <Button onClick={copyDialogScript} startIcon={<ContentCopyIcon />}>Copy script</Button>
          <Button onClick={downloadDialogScript}>Download script</Button>
          {/* Make permanent: append block to /etc/fstab (requires elevation) */}
              <Button
            variant="contained"
            color="primary"
            onClick={async () => {
                setOpResultHint(null);
              // Build fstab block for all mappings
              const id = Math.random().toString(36).slice(2, 10);
              const lines: string[] = [];
              lines.push(`# lind-mount BEGIN: ${id}`);
              if (!skipPartition && partitionUuid && partitionUuid.trim() !== '') {
                lines.push(`UUID=${partitionUuid} ${baseMount} auto defaults,noatime,nofail,x-systemd.automount,x-systemd.device-timeout=10 0 2`);
              }
              const targets: string[] = [];
              rows.filter(r => r.src && r.target).forEach(r => {
                lines.push(`${r.src} ${r.target} none bind 0 0`);
                targets.push(r.target as string);
              });
              lines.push(`# lind-mount END: ${id}`);
              const block = lines.join('\n') + '\n';
                try {
                setApplyInProgress(true);
                const res = await invoke<string>('perform_mounts', {
                  block,
                  id,
                  targets,
                  partitionUuid: skipPartition ? null : (partitionUuid || null),
                  baseMount: baseMount || null,
                  addPartitionLine: (!skipPartition && !!partitionUuid && partitionUuid.trim() !== ''),
                });
                let parsed: any = null;
                try { parsed = JSON.parse(res); } catch (err) { parsed = null; }
                if (parsed && parsed.status === 'adoptable' && parsed.code === 'adoptable_existing_block') {
                  // Show adopt confirmation dialog
                  setAdoptInfo({ id: parsed.id, block: parsed.block, targets: parsed.targets || [] });
                  setAdoptDialogOpen(true);
                } else if (parsed && parsed.status === 'ok') {
                  setApplyResultMessage(`Mapping created and activated (id: ${id}).`);
                  pushLog(`Applied fstab block ${id}: ${parsed.message || parsed.code}`);
                  refreshInstalledBlocks();
                } else if (parsed && parsed.status === 'error') {
                  // Friendly handling of known codes
                  if (parsed.code === 'spawn_pkexec_failed') {
                    setApplyResultMessage('Elevation helper (pkexec) not available or failed to start. Run the following sudo command in a terminal:');
                    setOpResultHint(`sudo sh -c "cat > /tmp/new_block <<'EOF'\n${block.replace(/\$/g,'\\$')}\nEOF\ncat /tmp/new_block >> /etc/fstab && mount -a"`);
                  } else if (parsed.code === 'pkexec_failed') {
                    setApplyResultMessage('Privileged operation failed while applying block. See details below. You can try the sudo fallback:');
                    setOpResultHint(`sudo sh -c "cat > /tmp/new_block <<'EOF'\n${block.replace(/\$/g,'\\$')}\nEOF\ncat /tmp/new_block >> /etc/fstab && mount -a"`);
                  } else {
                    setApplyResultMessage(`Failed to apply mapping: ${parsed.message || parsed.code || 'unknown error'}`);
                    setOpResultHint((parsed && (parsed.stderr || parsed.stdout)) || null);
                  }
                } else {
                  // Fallback: unknown response format
                  setApplyResultMessage(`Apply fstab result:\n${res}`);
                }
                setApplyResultOpen(true);
                setDialogOpen(false);
              } catch (e: any) {
                const text = String(e);
                setApplyResultMessage(`Failed to apply fstab block:\n${text}`);
                pushLog(`Failed apply fstab block ${id}: ${String(e)}`);
                setApplyResultOpen(true);
              } finally {
                setApplyInProgress(false);
              }
            }}
          >
            {applyInProgress ? (
              <>
                <CircularProgress size={18} color="inherit" sx={{ mr: 1 }} /> Applying...
              </>
            ) : (
              'Make permanent'
            )}
          </Button>
        </DialogActions>
      </Dialog>
        </div>
        {/* Disks Tab */}
        <div>
          <Grid container alignItems="center" justifyContent="space-between" sx={{ mb:2 }}>
            <Grid item><Typography variant="h6">Persistent Mounts (installed)</Typography></Grid>
            <Grid item>
              <Button size="small" onClick={refreshInstalledBlocks}>Refresh</Button>
            </Grid>
          </Grid>
          {installedBlocks.length === 0 && (
            <Typography variant="body2" color="text.secondary">No persistent mounts installed via lind-mount.</Typography>
          )}
          {installedBlocks.map(b => (
            <Paper key={b.id} variant="outlined" sx={{ p:1, mb:1 }}>
              <Grid container alignItems="center" spacing={1}>
                <Grid item xs={8}>
                  <Typography variant="body2"><code>{b.id}</code> {b.managed ? <span style={{ fontSize: 12, marginLeft: 8, color: '#1976d2' }}>(managed)</span> : null}</Typography>
                  <Typography variant="caption" sx={{ whiteSpace: 'pre-wrap' }}>{b.text}</Typography>
                </Grid>
                <Grid item xs={4}>
                  <Button size="small" color="error" onClick={() =>{
                    setRemoveDialogId(b.id);
                    setRemoveDialogTarget((b.targets && b.targets.length>0) ? b.targets[0] : null);
                    setRemoveDialogForce(false);
                    setRemoveDialogOpen(true);
                  }}>Remove</Button>
                </Grid>
              </Grid>
            </Paper>
          ))}

          <Paper variant="outlined" sx={{ p:2, mt:2 }}>
            <Typography variant="subtitle1">Recent operations</Typography>
            {operationsLog.length === 0 && (
              <Typography variant="body2" color="text.secondary">No operations yet.</Typography>
            )}
            <ul style={{ marginTop: 8 }}>
              {operationsLog.map((l, idx) => (
                <li key={idx}><code style={{ whiteSpace: 'pre-wrap' }}>{l}</code></li>
              ))}
            </ul>
          </Paper>

          <Dialog open={removeDialogOpen} onClose={()=>setRemoveDialogOpen(false)}>
            <DialogTitle>Confirm remove persistent mount</DialogTitle>
            <DialogContent>
              <Typography>Are you sure you want to remove the persistent mount <code>{removeDialogId}</code>? This will attempt to unmount targets and remove the fstab block.</Typography>
              <Grid container alignItems="center" spacing={1} sx={{ mt:1 }}>
                <Grid item>
                  <input id="force-unmount" type="checkbox" checked={removeDialogForce} onChange={e=>setRemoveDialogForce(e.target.checked)} />
                </Grid>
                <Grid item>
                  <label htmlFor="force-unmount">Use lazy unmount if busy (umount -l)</label>
                </Grid>
              </Grid>
            </DialogContent>
            <DialogActions>
              <Button onClick={()=>setRemoveDialogOpen(false)}>Cancel</Button>
              <Button color="error" onClick={async ()=>{
                setOpResultHint(null);
                if (!removeDialogId) return;
                try {
                  // Prefer single-step removal by target when we have a representative target.
                  let res: string;
                  if (removeDialogTarget) {
                    res = await invoke<string>('remove_block_for_target', { target: removeDialogTarget, force: removeDialogForce });
                  } else {
                    res = await invoke<string>('remove_fstab_block', { id: removeDialogId, force: removeDialogForce });
                  }
                  let parsed: any = null;
                  try { parsed = JSON.parse(res); } catch (_) { parsed = null; }
                  if (parsed && parsed.status === 'ok') {
                    setOpResultMessage(`Removed mapping ${removeDialogId || removeDialogTarget}.`);
                    setPendingForceId(null);
                    refreshInstalledBlocks();
                  } else if (parsed && parsed.status === 'error') {
                    if (parsed.code === 'spawn_pkexec_failed') {
                      setOpResultMessage('Elevation helper (pkexec) not available. Run the following sudo command as root:');
                      setOpResultHint(`sudo sh -c "cp /etc/fstab /etc/fstab.lind-mount.manual.bak.$(date +%s) && sed -e '/^# lind-mount BEGIN: ${removeDialogId}/, /^# lind-mount END: ${removeDialogId}/d' /etc/fstab > /tmp/fstab.clean.$$ && cp /tmp/fstab.clean.$$ /etc/fstab && sync && mount -a"`);
                      setPendingForceId(null);
                    } else if (parsed.code === 'pkexec_failed') {
                      // pkexec ran but returned non-zero; it may have printed stderr with hints (busy etc)
                      const out = (parsed.stderr || parsed.stdout || parsed.message || '').toString();
                      if (/busy/i.test(out)) {
                        setOpResultMessage(`Unmount reported device busy for ${removeDialogId}.`);
                        setOpResultHint('Use `sudo fuser -mv <target>` to list processes holding the mount, or retry with Force (lazy unmount).');
                        setPendingForceId(removeDialogId);
                      } else {
                        setOpResultMessage(`Failed to remove mapping: ${parsed.message || parsed.code}`);
                        setOpResultHint(out || null);
                        setPendingForceId(null);
                      }
                    } else {
                      setOpResultMessage(`Failed to remove mapping: ${parsed.message || parsed.code}`);
                      setOpResultHint((parsed.stderr || parsed.stdout) || null);
                      setPendingForceId(null);
                    }
                  } else {
                    // unknown response
                    setOpResultMessage(`Remove result:\n${res}`);
                  }
                  setOpResultOpen(true);
                  setRemoveDialogOpen(false);
                } catch (e:any) {
                  const text = String(e);
                  setOpResultMessage(`Failed to remove:\n${text}`);
                  setOpResultOpen(true);
                  setRemoveDialogOpen(false);
                }
              }}>Remove</Button>
            </DialogActions>
          </Dialog>
          <Dialog open={adoptDialogOpen} onClose={() => { setAdoptDialogOpen(false); setAdoptInfo(null); }} fullWidth maxWidth="md">
            <DialogTitle>Adopt existing mapping</DialogTitle>
            <DialogContent>
              <Typography variant="body2" gutterBottom>
                The fstab contains an existing lind-mount block that matches your requested target. Do you want to adopt it so the app can manage it?
              </Typography>
              <Typography variant="caption">Block ID: <code>{adoptInfo?.id}</code></Typography>
              <pre className="fstab-preview" style={{ maxHeight: 360, overflow: 'auto' }}>
                <code>{adoptInfo?.block}</code>
              </pre>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => { setAdoptDialogOpen(false); setAdoptInfo(null); }}>Cancel</Button>
              <Button variant="contained" onClick={async () => {
                if (!adoptInfo) return;
                try {
                  const resp = await invoke<string>('adopt_block', { id: adoptInfo.id });
                  let p: any = null;
                  try { p = JSON.parse(resp); } catch (_) { p = null; }
                  if (p && p.status === 'ok') {
                    setApplyResultMessage(`Adopted block ${adoptInfo.id}.`);
                    pushLog(`Adopted existing block ${adoptInfo.id}`);
                    refreshInstalledBlocks();
                  } else {
                    setApplyResultMessage(`Failed to adopt: ${resp}`);
                  }
                } catch (e:any) {
                  setApplyResultMessage(`Adopt failed: ${String(e)}`);
                } finally {
                  setAdoptDialogOpen(false);
                  setAdoptInfo(null);
                  setApplyResultOpen(true);
                }
              }}>Adopt</Button>
            </DialogActions>
          </Dialog>

          <Dialog open={opResultOpen} onClose={()=>setOpResultOpen(false)} fullWidth maxWidth="md">
            <DialogTitle>Operation result</DialogTitle>
            <DialogContent>
              <pre style={{ whiteSpace: 'pre-wrap' }}>{opResultMessage}</pre>
              {opResultHint && (
                <Paper variant="outlined" sx={{ p:1, mt:1 }}>
                  <Typography variant="caption" display="block" sx={{ mb:1 }}>Suggested command / hint</Typography>
                  <code style={{ display: 'block', whiteSpace: 'pre-wrap' }}>{opResultHint}</code>
                  <Button size="small" onClick={()=>{ navigator.clipboard.writeText(opResultHint || ''); }}>Copy</Button>
                </Paper>
              )}
            </DialogContent>
            <DialogActions>
              {pendingForceId && (
                <Button color="error" onClick={async ()=>{
                  try {
                    const id = pendingForceId;
                    setOpResultOpen(false);
                    const res = await invoke<string>('remove_fstab_block', { id, force: true });
                    setOpResultMessage(`Force remove result:\n${res}`);
                    setOpResultHint(null);
                    setPendingForceId(null);
                    setOpResultOpen(true);
                    refreshInstalledBlocks();
                  } catch (e:any) {
                    setOpResultMessage(`Force remove failed:\n${String(e)}`);
                    setPendingForceId(null);
                    setOpResultOpen(true);
                  }
                }}>Force unmount (lazy)</Button>
              )}
              <Button onClick={()=>setOpResultOpen(false)}>OK</Button>
            </DialogActions>
          </Dialog>
          <Dialog open={applyResultOpen} onClose={()=>setApplyResultOpen(false)} fullWidth maxWidth="md">
            <DialogTitle>Apply result</DialogTitle>
            <DialogContent>
              <pre style={{ whiteSpace: 'pre-wrap' }}>{applyResultMessage}</pre>
              {opResultHint && (
                <Paper variant="outlined" sx={{ p:1, mt:1 }}>
                  <Typography variant="caption" display="block" sx={{ mb:1 }}>Suggested command / hint</Typography>
                  <code style={{ display: 'block', whiteSpace: 'pre-wrap' }}>{opResultHint}</code>
                  <Button size="small" onClick={()=>{ navigator.clipboard.writeText(opResultHint || ''); }}>Copy</Button>
                </Paper>
              )}
            </DialogContent>
            <DialogActions>
              <Button onClick={()=>setApplyResultOpen(false)}>OK</Button>
            </DialogActions>
          </Dialog>
          <Paper variant="outlined" sx={{ p:2, mb:2 }}>
            <Grid container alignItems="center" justifyContent="space-between" sx={{ mb:2 }}>
              <Grid item><Typography variant="h6">Disks & Partitions</Typography></Grid>
              <Grid item>
                <Tooltip title="Refresh"><IconButton onClick={refreshPartitions}><RefreshIcon/></IconButton></Tooltip>
              </Grid>
            </Grid>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell>Type</TableCell>
                  <TableCell>Label</TableCell>
                  <TableCell>UUID</TableCell>
                  <TableCell>Mount</TableCell>
                  <TableCell>Size</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {parts.map(p => (
                  <TableRow key={p.name}>
                    <TableCell>{p.name}</TableCell>
                    <TableCell>{p.fstype || '-'}</TableCell>
                    <TableCell>{p.label || '-'}</TableCell>
                    <TableCell>{p.uuid ? <code>{p.uuid}</code> : '-'}</TableCell>
                    <TableCell>{p.mountpoint || '-'}</TableCell>
                    <TableCell>{p.size || '-'}</TableCell>
                    <TableCell align="right">
                      {p.uuid && (
                        <Tooltip title="Copy UUID">
                          <IconButton size="small" onClick={()=>{navigator.clipboard.writeText(p.uuid); setCopied(true);}}>
                            <ContentCopyIcon fontSize="inherit" />
                          </IconButton>
                        </Tooltip>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
        </div>
        {/* Mappings Tab */}
        <div>
          <Paper variant="outlined" sx={{ p:2, mb:2 }}>
            <Grid container alignItems="center" justifyContent="space-between" sx={{ mb:2 }}>
              <Grid item><Typography variant="h6">Existing Mappings</Typography></Grid>
              <Grid item>
                <Button variant="contained" onClick={addRow}>Add Mapping</Button>
              </Grid>
            </Grid>
            <Grid container direction="column" spacing={1}>
              {rows.length === 0 && (
                <Grid item>
                  <Typography variant="body2" color="text.secondary">No mappings yet. Use Add Mapping.</Typography>
                </Grid>
              )}
              {rows.map(row => (
                <Grid item key={row.id}>
                  <Paper variant="outlined" sx={{ p:1 }}>
                    <Grid container spacing={1} alignItems="center">
                      <Grid item xs={12} md={5}><code>{row.src || '—'}</code></Grid>
                      <Grid item xs={12} md={5}><code>{row.target || '—'}</code></Grid>
                      <Grid item xs={6} md={1}>
                        <Button size="small" variant="outlined" disabled={!row.src || !row.target} onClick={()=>mountRow(row)}>Mount</Button>
                      </Grid>
                      <Grid item xs={6} md={1}>
                        <IconButton size="small" aria-label="remove" onClick={()=>removeRow(row.id)}><DeleteIcon fontSize="small"/></IconButton>
                      </Grid>
                    </Grid>
                  </Paper>
                </Grid>
              ))}
            </Grid>
          </Paper>
        </div>
      </SwipeableViews>
      <Snackbar open={copied} autoHideDuration={2500} onClose={() => setCopied(false)}>
        <Alert severity="success" variant="filled" onClose={() => setCopied(false)}>Copied</Alert>
      </Snackbar>
    </Container>
  );
}

function ModeToggle() {
  const { mode, toggleMode: toggle } = useContext(ThemeContext);
  return (
    <Tooltip title={mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
      <IconButton onClick={toggle} color="primary" aria-label="toggle theme">
        {mode === 'dark' ? <LightModeIcon /> : <DarkModeIcon />}
      </IconButton>
    </Tooltip>
  );
}

function AccentCycleButton() {
  const { accent, cycleAccent } = useContext(ThemeContext);
  return (
    <Tooltip title={`Accent: ${accent} (click to cycle)`}>
      <Button size="small" onClick={cycleAccent} sx={{ minWidth: 32, px: 1 }}>
        <span
          style={{
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: 'currentColor',
            display: 'inline-block',
          }}
        />
      </Button>
    </Tooltip>
  );
}

export default App;
