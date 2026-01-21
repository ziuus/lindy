import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";

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


type Mapping = {
  id: number;
  src?: string;
  target?: string;
};

type UserFolder = {
  name: string;
  linux_path: string;
  windows_path?: string;
  exists_linux: boolean;
  exists_windows: boolean;
};

type FolderMapping = {
  linux_path: string;
  windows_path: string;
  folder_type: string;
};



interface FstabBind {
  src: string;
  target: string;
}

interface FstabBlock {
  id: string;
  text: string;
  targets: string[];
  binds?: FstabBind[];
  managed: boolean;
}

function App() {
  const [rows, setRows] = useState<Mapping[]>([]);
  const [partitionUuid, setPartitionUuid] = useState("");
  const [skipPartition, setSkipPartition] = useState(false);
  const [baseMount, setBaseMount] = useState("/mnt/shared");
  const [parts, setParts] = useState<any[]>([]);
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState(0);
  // Track which rows are currently being mounted (single or multiple)
  const [pendingMountRows, setPendingMountRows] = useState<Mapping[]>([]);

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
    // Open confirm dialog with generated script for THIS row only
    setPendingMountRows([row]);
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
    refreshInstalledBlocks(true);
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

  const [installedBlocks, setInstalledBlocks] = useState<FstabBlock[]>([]);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [removeDialogId, setRemoveDialogId] = useState<string | null>(null);
  const [removeDialogTarget, setRemoveDialogTarget] = useState<string | null>(null);
  const [removeDialogForce, setRemoveDialogForce] = useState(false);
  const [adoptDialogOpen, setAdoptDialogOpen] = useState(false);
  const [adoptInfo, setAdoptInfo] = useState<{ id: string, block: string, targets: string[] } | null>(null);
  const [opResultOpen, setOpResultOpen] = useState(false);
  const [opResultMessage, setOpResultMessage] = useState('');
  const [opResultHint, setOpResultHint] = useState<string | null>(null);
  const [pendingForceId, setPendingForceId] = useState<string | null>(null);
  const [applyInProgress, setApplyInProgress] = useState(false);
  const [applyResultOpen, setApplyResultOpen] = useState(false);
  const [applyResultMessage, setApplyResultMessage] = useState('');
  const [operationsLog, setOperationsLog] = useState<string[]>([]);

  // Auto-mapping state
  const [autoMappingOpen, setAutoMappingOpen] = useState(false);
  const [detectedFolders, setDetectedFolders] = useState<UserFolder[]>([]);
  const [suggestedMappings, setSuggestedMappings] = useState<FolderMapping[]>([]);
  const [windowsUsername, setWindowsUsername] = useState("");
  const [autoMappingLoading, setAutoMappingLoading] = useState(false);
  const [smartAutoMapLoading, setSmartAutoMapLoading] = useState(false);
  const [errorDialogOpen, setErrorDialogOpen] = useState(false);
  const [errorDetails, setErrorDetails] = useState<{ title: string, message: string, solution: string, technical?: string } | null>(null);
  const [autoMapSuccessOpen, setAutoMapSuccessOpen] = useState(false);
  const [autoMapResult, setAutoMapResult] = useState<any>(null);

  const pushLog = (msg: string) => {
    setOperationsLog(l => [msg, ...l].slice(0, 50));
  };

  const detectUserFolders = async () => {
    try {
      const folders = await invoke<UserFolder[]>('detect_user_folders');
      setDetectedFolders(folders);
    } catch (e) {
      console.error('Failed to detect user folders:', e);
    }
  };

  const suggestFolderMappings = async () => {
    if (!baseMount) {
      alert('Please set a base mount point first');
      return;
    }

    setAutoMappingLoading(true);
    try {
      const mappings = await invoke<FolderMapping[]>('suggest_folder_mappings', {
        windowsBasePath: baseMount,
        username: windowsUsername || null,
      });
      setSuggestedMappings(mappings);

      if (mappings.length === 0) {
        alert('No matching folders found. Make sure the Windows partition is mounted and contains user folders.');
      }
    } catch (e: any) {
      console.error('Auto-mapping error:', e);
      // Show user-friendly error message
      const errorMsg = typeof e === 'string' ? e : 'Failed to scan for folder mappings';
      alert(`Error: ${errorMsg}`);
    } finally {
      setAutoMappingLoading(false);
    }
  };

  const applyAutoMappings = () => {
    const newMappings = suggestedMappings.map(mapping => ({
      id: Date.now() + Math.random(),
      src: mapping.windows_path,
      target: mapping.linux_path,
    }));

    setRows(prev => [...prev, ...newMappings]);
    setAutoMappingOpen(false);
    setSuggestedMappings([]);
  };

  const parseWindowsPartitionError = (stderr: string, stdout: string) => {
    const error = (stderr + ' ' + stdout).toLowerCase();

    // NTFS corruption/consistency issues
    if (error.includes('$mftmirr does not match $mft') ||
      error.includes('ntfs is either inconsistent') ||
      error.includes('input/output error')) {
      return {
        title: '⚠️ Windows Wasn\'t Shut Down Properly',
        message: 'Your Windows partition has some errors because Windows wasn\'t shut down correctly last time.',
        solution: `This happens when:
• Windows was forced to shut down
• Power went out while Windows was running
• Windows updates didn't finish properly

Quick fix: Boot into Windows, let it start normally, then shut down properly. Try Smart Auto-Map again.`,
        technical: stderr
      };
    }

    // Permission issues
    if (error.includes('permission denied') || error.includes('operation not permitted')) {
      return {
        title: '🔐 Need Permission',
        message: 'Need administrator access to mount your Windows partition.',
        solution: `Make sure to click "Allow" when the permission dialog appears.

If you don't see a permission dialog, try restarting the app.`,
        technical: stderr
      };
    }

    // Device busy
    if (error.includes('device is busy') || error.includes('target is busy')) {
      return {
        title: '📁 Windows Partition is Busy',
        message: 'Something else is already using your Windows partition.',
        solution: `Try these quick fixes:
• Close any file managers or folders
• Wait a moment and try again
• Restart your computer if the problem continues`,
        technical: stderr
      };
    }

    // No such device
    if (error.includes('no such file or directory') || error.includes('no such device')) {
      return {
        title: '❓ Can\'t Find Windows Partition',
        message: 'Your Windows partition disappeared or can\'t be accessed right now.',
        solution: `This might help:
• Try refreshing the app
• Check if your Windows drive is connected properly
• Restart your computer`,
        technical: stderr
      };
    }

    // SoftRAID/FakeRAID
    if (error.includes('softraid') || error.includes('fakeraid') || error.includes('dmraid')) {
      return {
        title: '💾 Special Disk Setup Detected',
        message: 'Your Windows is on a special disk configuration that needs manual setup.',
        solution: `Your system has advanced disk setup (RAID).

Smart Auto-Map can't handle this automatically. Try "Manual Auto-Map" instead, or mount your Windows partition manually first.`,
        technical: stderr
      };
    }

    // Generic mount failure
    return {
      title: '❌ Couldn\'t Mount Windows',
      message: 'Something went wrong while trying to access your Windows partition.',
      solution: `Try these simple fixes:
• Restart your computer
• Try "Manual Auto-Map" instead
• Make sure Windows is installed and working`,
      technical: stderr
    };
  };

  const smartAutoMap = async () => {
    setSmartAutoMapLoading(true);
    pushLog('Starting Smart Auto-Map: Detecting Windows partitions...');

    try {
      const resultStr = await invoke<string>('auto_mount_and_map', {
        preferredMountBase: null,
        username: null,
      });

      // Parse the JSON response
      let result: any;
      try {
        result = JSON.parse(resultStr);
      } catch (e) {
        pushLog('Smart Auto-Map failed: Invalid response format');
        throw new Error('Invalid response from auto-mapping service');
      }

      if (result.status === 'error') {
        // Log the specific error
        pushLog(`Smart Auto-Map failed: ${result.code} - ${result.message}`);

        // Handle different error types with specific messages

        if (result.code === 'spawn_pkexec_failed') {
          setErrorDetails({
            title: '🔐 Permission Helper Not Available',
            message: 'The system permission helper isn\'t working right now.',
            solution: `Try these simple fixes:
• Restart the app
• Try "Manual Auto-Map" instead
• Restart your computer if the problem continues`,
            technical: result.message
          });
          setErrorDialogOpen(true);
          return;
        } else if (result.code === 'mount_failed') {
          const parsedError = parseWindowsPartitionError(result.stderr || '', result.stdout || '');

          // Show user-friendly error dialog instead of alert
          setErrorDetails(parsedError);
          setErrorDialogOpen(true);

          // Log technical details for troubleshooting
          pushLog(`Mount failed - Technical details: ${parsedError.technical}`);
          return; // Don't show the generic alert
        } else if (result.code === 'no_windows_partitions') {
          setErrorDetails({
            title: '💿 No Windows Found',
            message: 'Smart Auto-Map couldn\'t find Windows on your computer.',
            solution: `This might be because:
• You don't have Windows installed (need dual-boot)
• Windows is on an external drive that's unplugged
• Windows is already mounted somewhere else

Try "Manual Auto-Map" if you know where Windows is located.`,
            technical: 'No NTFS or exFAT partitions detected via lsblk'
          });
          setErrorDialogOpen(true);
          return;
        } else if (result.code === 'no_users_detected') {
          setErrorDetails({
            title: '👤 No Windows Users Found',
            message: 'Found Windows, but couldn\'t find any user folders.',
            solution: `This might be because:
• This isn't the main Windows partition
• Windows user folders are in a different location
• The Windows installation is incomplete

Try "Manual Auto-Map" and specify your Windows username manually.`,
            technical: `Mounted at: ${result.mount_point}, but no Users folder found`
          });
          setErrorDialogOpen(true);
          return;
        } else if (result.code === 'no_mappings_found') {
          setErrorDetails({
            title: '📁 No Folders to Map',
            message: `Found Windows user '${result.username}', but no folders to sync.`,
            solution: `This might be because:
• The Windows user doesn't have Desktop, Documents, etc. folders yet
• The folders have different names
• You need to create the folders in Windows first

Try logging into Windows and creating the standard folders, then try again.`,
            technical: `User: ${result.username}, Mount: ${result.mount_point}`
          });
          setErrorDialogOpen(true);
          return;
        }

        // Generic error fallback (only reached for unknown error codes)
        setErrorDetails({
          title: '❓ Something Went Wrong',
          message: 'Smart Auto-Map ran into an unexpected problem.',
          solution: `Try these simple fixes:
• Try "Manual Auto-Map" instead
• Restart the app
• Restart your computer

If this keeps happening, it might be a bug.`,
          technical: JSON.stringify(result, null, 2)
        });
        setErrorDialogOpen(true);
        return;
      }

      if (result.status === 'ok') {
        // Log success
        pushLog(`Smart Auto-Map success: Mounted ${result.windows_partition.label || 'Windows partition'} at ${result.mount_point}, found ${result.mappings.length} mappings for user ${result.username}`);

        // Update the base mount point with the detected/mounted path
        setBaseMount(result.mount_point);

        // Set the partition UUID if available
        if (result.windows_partition?.uuid) {
          setPartitionUuid(result.windows_partition.uuid);
        }

        // Add the mappings
        const newMappings = result.mappings.map((mapping: any) => ({
          id: Date.now() + Math.random(),
          src: mapping.windows_path,
          target: mapping.linux_path,
        }));

        setRows(prev => [...prev, ...newMappings]);

        // Open success dialog instead of alert
        setAutoMapResult({
          partitionInfo: result.windows_partition.label
            ? `${result.windows_partition.label} (${result.windows_partition.uuid.substring(0, 8)}...)`
            : result.windows_partition.uuid.substring(0, 8) + '...',
          mountPoint: result.mount_point,
          username: result.username,
          count: result.mappings.length,
          newMappings: newMappings // Pass these so we can "Mount All Now" immediately
        });
        setAutoMapSuccessOpen(true);
      }

    } catch (e: any) {
      console.error('Smart auto-map error:', e);
      const errorMsg = typeof e === 'string' ? e : (e.message || 'Failed to auto-detect and map Windows folders');
      pushLog(`Smart Auto-Map error: ${errorMsg}`);
      alert(`Smart Auto-Map Error:\n\n${errorMsg}\n\nTry using "Manual Auto-Map" if you know where your Windows partition is mounted.`);
    } finally {
      setSmartAutoMapLoading(false);
    }
  };
  const refreshInstalledBlocks = async (isInitial = false) => {
    try {
      const res = await invoke<FstabBlock[]>('list_fstab_blocks');
      if (Array.isArray(res)) {
        setInstalledBlocks(res);

        if (isInitial) {
          const restoredRows: Mapping[] = [];
          res.forEach(b => {
            if (b.binds) {
              b.binds.forEach(bind => {
                restoredRows.push({
                  id: Date.now() + Math.random(),
                  src: bind.src,
                  target: bind.target
                });
              });
            }
          });

          if (restoredRows.length > 0) {
            setRows(prev => {
              // If rows are essentially empty (just new row with no data)
              if (prev.length <= 1 && (!prev[0] || !prev[0].src)) {
                return restoredRows;
              }
              return prev;
            });
          }
        }
      }
    } catch (e) { console.warn('list_fstab_blocks failed', e); }
  };

  return (
    <div style={{ minHeight: '100vh', padding: '2rem' }}>
      <div className="glass-panel" style={{ maxWidth: '1000px', margin: '0 auto', padding: '2rem' }}>
        <Grid container alignItems="center" justifyContent="center" sx={{ mb: 4 }}>
          <Grid item>
            <Typography variant="h3" align="center" fontWeight={800} sx={{ letterSpacing: '-0.02em', background: 'linear-gradient(135deg, #00f2ff 0%, #7000ff 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', mb: 1 }}>
              Lindy
            </Typography>
            <Typography variant="subtitle1" align="center" sx={{ opacity: 0.7 }}>
              Dual-boot limit breaker
            </Typography>
          </Grid>
        </Grid>
        <Paper variant="outlined" sx={{ mb: 2 }}>
          <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="fullWidth">
            <Tab label="Main" />
            <Tab label="Disks" />
            <Tab label="Mappings" />
          </Tabs>
        </Paper>
        <SwipeableViews index={tab} onChangeIndex={(i: number) => setTab(i)} enableMouseEvents>
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
                                const suggested = p.label ? `/mnt/${p.label}` : `/mnt/${v.slice(0, 8)}`;
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
                <Typography variant="subtitle1">Auto-Map User Folders</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Typography variant="body2" gutterBottom>
                  Two ways to automatically map common user folders between Linux and Windows:
                </Typography>

                <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>
                  🚀 Smart Auto-Map (Recommended)
                </Typography>
                <Typography variant="body2" gutterBottom>
                  Automatically detects Windows partitions, mounts them if needed, and creates folder mappings in one click.
                  No manual configuration required!
                </Typography>

                <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>
                  ⚙️ Manual Auto-Map
                </Typography>
                <Typography variant="body2" gutterBottom>
                  For when you want more control - requires you to set the base mount point and optionally specify the Windows username.
                </Typography>

                <Typography variant="body2" sx={{ mt: 2 }}>
                  <strong>Supported folders:</strong> Desktop, Documents, Downloads, Pictures, Music, Videos
                </Typography>
              </AccordionDetails>
            </Accordion>

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
                <Grid container spacing={1}>
                  <Grid item>
                    <Button variant="contained" color="primary" onClick={addRow}>Add Mapping</Button>
                  </Grid>
                  <Grid item>
                    <Button
                      variant="contained"
                      color="success"
                      onClick={smartAutoMap}
                      disabled={smartAutoMapLoading}
                    >
                      {smartAutoMapLoading ? (
                        <>
                          <CircularProgress size={18} color="inherit" sx={{ mr: 1 }} />
                          Detecting...
                        </>
                      ) : (
                        'Smart Auto-Map'
                      )}
                    </Button>
                  </Grid>
                  <Grid item>
                    <Button
                      variant="outlined"
                      color="secondary"
                      onClick={() => {
                        detectUserFolders();
                        setAutoMappingOpen(true);
                      }}
                    >
                      Manual Auto-Map
                    </Button>
                  </Grid>
                </Grid>
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
                        {(() => {
                          const mounted = installedBlocks.some(b => b.targets && b.targets.includes(row.target || ''));
                          return (
                            <Button
                              fullWidth
                              variant={mounted ? "outlined" : "outlined"}
                              color={mounted ? "error" : "primary"}
                              onClick={() => {
                                if (mounted) {
                                  if (row.target) {
                                    setRemoveDialogId(null);
                                    setRemoveDialogTarget(row.target);
                                    setRemoveDialogForce(false);
                                    setRemoveDialogOpen(true);
                                  }
                                } else {
                                  mountRow(row);
                                }
                              }}
                              disabled={!row.src || !row.target}
                            >
                              {mounted ? "Unmount" : "Mount"}
                            </Button>
                          );
                        })()}
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
                            } catch (e: any) {
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
                    lines.push(`# lindy BEGIN: ${id}`);
                    if (!skipPartition && partitionUuid && partitionUuid.trim() !== '') {
                      lines.push(`UUID=${partitionUuid} ${baseMount} auto defaults,noatime,nofail,x-systemd.automount,x-systemd.device-timeout=10 0 2`);
                    }
                    const targets: string[] = [];
                    // Use pendingMountRows instead of all rows
                    pendingMountRows.filter(r => r.src && r.target).forEach(r => {
                      lines.push(`${r.src} ${r.target} none bind 0 0`);
                      targets.push(r.target as string);
                    });
                    lines.push(`# lindy END: ${id}`);
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
                          setOpResultHint(`sudo sh -c "cat > /tmp/new_block <<'EOF'\n${block.replace(/\$/g, '\\$')}\nEOF\ncat /tmp/new_block >> /etc/fstab && mount -a"`);
                        } else if (parsed.code === 'pkexec_failed') {
                          setApplyResultMessage('Privileged operation failed while applying block. See details below. You can try the sudo fallback:');
                          setOpResultHint(`sudo sh -c "cat > /tmp/new_block <<'EOF'\n${block.replace(/\$/g, '\\$')}\nEOF\ncat /tmp/new_block >> /etc/fstab && mount -a"`);
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
            <Grid container alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
              <Grid item><Typography variant="h6">Persistent Mounts (installed)</Typography></Grid>
              <Grid item>
                <Button size="small" onClick={() => refreshInstalledBlocks()}>Refresh</Button>
              </Grid>
            </Grid>
            {installedBlocks.length === 0 && (
              <Typography variant="body2" color="text.secondary">No persistent mounts installed via lindy.</Typography>
            )}
            {installedBlocks.map(b => (
              <Paper key={b.id} variant="outlined" sx={{ p: 1, mb: 1 }}>
                <Grid container alignItems="center" spacing={1}>
                  <Grid item xs={8}>
                    <Typography variant="body2"><code>{b.id}</code> {b.managed ? <span style={{ fontSize: 12, marginLeft: 8, color: '#1976d2' }}>(managed)</span> : null}</Typography>
                    <Typography variant="caption" sx={{ whiteSpace: 'pre-wrap' }}>{b.text}</Typography>
                  </Grid>
                  <Grid item xs={4}>
                    <Button size="small" color="error" onClick={() => {
                      setRemoveDialogId(b.id);
                      setRemoveDialogTarget((b.targets && b.targets.length > 0) ? b.targets[0] : null);
                      setRemoveDialogForce(false);
                      setRemoveDialogOpen(true);
                    }}>Remove</Button>
                  </Grid>
                </Grid>
              </Paper>
            ))}

            <Paper variant="outlined" sx={{ p: 2, mt: 2 }}>
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

            <Dialog open={removeDialogOpen} onClose={() => setRemoveDialogOpen(false)}>
              <DialogTitle>Confirm remove persistent mount</DialogTitle>
              <DialogContent>
                <Typography>Are you sure you want to remove the persistent mount <code>{removeDialogId}</code>? This will attempt to unmount targets and remove the fstab block.</Typography>
                <Grid container alignItems="center" spacing={1} sx={{ mt: 1 }}>
                  <Grid item>
                    <input id="force-unmount" type="checkbox" checked={removeDialogForce} onChange={e => setRemoveDialogForce(e.target.checked)} />
                  </Grid>
                  <Grid item>
                    <label htmlFor="force-unmount">Use lazy unmount if busy (umount -l)</label>
                  </Grid>
                </Grid>
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setRemoveDialogOpen(false)}>Cancel</Button>
                <Button color="error" onClick={async () => {
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
                        setOpResultHint(`sudo sh -c "cp /etc/fstab /etc/fstab.lindy.manual.bak.$(date +%s) && sed -e '/^# lindy BEGIN: ${removeDialogId}/, /^# lindy END: ${removeDialogId}/d' /etc/fstab > /tmp/fstab.clean.$$ && cp /tmp/fstab.clean.$$ /etc/fstab && sync && mount -a"`);
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
                  } catch (e: any) {
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
                  The fstab contains an existing lindy block that matches your requested target. Do you want to adopt it so the app can manage it?
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
                  } catch (e: any) {
                    setApplyResultMessage(`Adopt failed: ${String(e)}`);
                  } finally {
                    setAdoptDialogOpen(false);
                    setAdoptInfo(null);
                    setApplyResultOpen(true);
                  }
                }}>Adopt</Button>
              </DialogActions>
            </Dialog>

            <Dialog open={opResultOpen} onClose={() => setOpResultOpen(false)} fullWidth maxWidth="md">
              <DialogTitle>Operation result</DialogTitle>
              <DialogContent>
                <pre style={{ whiteSpace: 'pre-wrap' }}>{opResultMessage}</pre>
                {opResultHint && (
                  <Paper variant="outlined" sx={{ p: 1, mt: 1 }}>
                    <Typography variant="caption" display="block" sx={{ mb: 1 }}>Suggested command / hint</Typography>
                    <code style={{ display: 'block', whiteSpace: 'pre-wrap' }}>{opResultHint}</code>
                    <Button size="small" onClick={() => { navigator.clipboard.writeText(opResultHint || ''); }}>Copy</Button>
                  </Paper>
                )}
              </DialogContent>
              <DialogActions>
                {pendingForceId && (
                  <Button color="error" onClick={async () => {
                    try {
                      const id = pendingForceId;
                      setOpResultOpen(false);
                      const res = await invoke<string>('remove_fstab_block', { id, force: true });
                      setOpResultMessage(`Force remove result:\n${res}`);
                      setOpResultHint(null);
                      setPendingForceId(null);
                      setOpResultOpen(true);
                      refreshInstalledBlocks();
                    } catch (e: any) {
                      setOpResultMessage(`Force remove failed:\n${String(e)}`);
                      setPendingForceId(null);
                      setOpResultOpen(true);
                    }
                  }}>Force unmount (lazy)</Button>
                )}
                <Button onClick={() => setOpResultOpen(false)}>OK</Button>
              </DialogActions>
            </Dialog>
            <Dialog open={applyResultOpen} onClose={() => setApplyResultOpen(false)} fullWidth maxWidth="md">
              <DialogTitle>Apply result</DialogTitle>
              <DialogContent>
                <pre style={{ whiteSpace: 'pre-wrap' }}>{applyResultMessage}</pre>
                {opResultHint && (
                  <Paper variant="outlined" sx={{ p: 1, mt: 1 }}>
                    <Typography variant="caption" display="block" sx={{ mb: 1 }}>Suggested command / hint</Typography>
                    <code style={{ display: 'block', whiteSpace: 'pre-wrap' }}>{opResultHint}</code>
                    <Button size="small" onClick={() => { navigator.clipboard.writeText(opResultHint || ''); }}>Copy</Button>
                  </Paper>
                )}
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setApplyResultOpen(false)}>OK</Button>
              </DialogActions>
            </Dialog>

            {/* Auto-mapping dialog */}
            <Dialog open={autoMappingOpen} onClose={() => setAutoMappingOpen(false)} fullWidth maxWidth="md">
              <DialogTitle>Manual Auto-Map User Folders</DialogTitle>
              <DialogContent>
                <Typography variant="body2" gutterBottom>
                  Automatically map common user folders between Linux and Windows. This will detect your Linux home folders and match them with Windows user folders.
                </Typography>

                {detectedFolders.length > 0 && (
                  <>
                    <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>
                      Detected Linux Folders:
                    </Typography>
                    <ul>
                      {detectedFolders.map((folder, idx) => (
                        <li key={idx}>
                          <code>{folder.linux_path}</code> {folder.exists_linux ? '✓' : '✗'}
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                <TextField
                  fullWidth
                  label="Windows Username (optional)"
                  placeholder="e.g., John, Administrator"
                  value={windowsUsername}
                  onChange={(e) => setWindowsUsername(e.target.value)}
                  helperText="Leave empty to auto-detect. Required if auto-detection fails."
                  sx={{ mt: 2, mb: 2 }}
                />

                <Button
                  variant="outlined"
                  onClick={suggestFolderMappings}
                  disabled={autoMappingLoading || !baseMount}
                  fullWidth
                  sx={{ mb: 2 }}
                >
                  {autoMappingLoading ? (
                    <>
                      <CircularProgress size={18} sx={{ mr: 1 }} />
                      Scanning...
                    </>
                  ) : (
                    'Scan for Mappings'
                  )}
                </Button>

                {suggestedMappings.length > 0 && (
                  <>
                    <Typography variant="subtitle2" sx={{ mb: 1 }}>
                      Found {suggestedMappings.length} folder mappings:
                    </Typography>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>Folder Type</TableCell>
                          <TableCell>Linux Path</TableCell>
                          <TableCell>Windows Path</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {suggestedMappings.map((mapping, idx) => (
                          <TableRow key={idx}>
                            <TableCell>{mapping.folder_type}</TableCell>
                            <TableCell><code>{mapping.linux_path}</code></TableCell>
                            <TableCell><code>{mapping.windows_path}</code></TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </>
                )}

                {suggestedMappings.length === 0 && baseMount && !autoMappingLoading && (
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
                    No matching folders found. Make sure the Windows partition is mounted at the correct base path and contains a Users folder.
                  </Typography>
                )}
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setAutoMappingOpen(false)}>Cancel</Button>
                {suggestedMappings.length > 0 && (
                  <Button
                    variant="contained"
                    onClick={applyAutoMappings}
                    color="primary"
                  >
                    Add {suggestedMappings.length} Mappings
                  </Button>
                )}
              </DialogActions>
            </Dialog>

            {/* Error Details Dialog */}
            <Dialog open={errorDialogOpen} onClose={() => setErrorDialogOpen(false)} fullWidth maxWidth="md">
              <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                {errorDetails?.title || 'Error'}
              </DialogTitle>
              <DialogContent>
                <Typography variant="body1" gutterBottom>
                  {errorDetails?.message}
                </Typography>

                <Paper variant="outlined" sx={{ p: 2, mt: 2, backgroundColor: 'action.hover' }}>
                  <Typography variant="subtitle2" gutterBottom>
                    💡 How to fix this:
                  </Typography>
                  <Typography variant="body2" sx={{ whiteSpace: 'pre-line' }}>
                    {errorDetails?.solution}
                  </Typography>
                </Paper>

                {errorDetails?.technical && (
                  <Accordion sx={{ mt: 2 }}>
                    <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                      <Typography variant="subtitle2">🔧 Technical Details (for troubleshooting)</Typography>
                    </AccordionSummary>
                    <AccordionDetails>
                      <Paper variant="outlined" sx={{ p: 1, backgroundColor: 'grey.100' }}>
                        <Typography variant="caption" component="pre" sx={{ whiteSpace: 'pre-wrap', fontSize: '0.75rem' }}>
                          {errorDetails.technical}
                        </Typography>
                      </Paper>
                      <Button
                        size="small"
                        onClick={() => navigator.clipboard.writeText(errorDetails.technical || '')}
                        sx={{ mt: 1 }}
                      >
                        Copy Technical Details
                      </Button>
                    </AccordionDetails>
                  </Accordion>
                )}
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setErrorDialogOpen(false)}>Close</Button>
                <Button
                  variant="outlined"
                  onClick={() => {
                    setErrorDialogOpen(false);
                    setAutoMappingOpen(true);
                  }}
                >
                  Try Manual Auto-Map
                </Button>
              </DialogActions>
            </Dialog>

            {/* Smart Auto-Map Success Dialog */}
            <Dialog open={autoMapSuccessOpen} onClose={() => setAutoMapSuccessOpen(false)} fullWidth maxWidth="sm">
              <DialogTitle>✅ Smart Auto-Map Successful!</DialogTitle>
              <DialogContent>
                <Typography variant="body1" gutterBottom>
                  Detected and mapped your Windows folders successfully.
                </Typography>
                <Paper variant="outlined" sx={{ p: 2, mt: 2, mb: 2, backgroundColor: 'action.hover' }}>
                  <Grid container spacing={1}>
                    <Grid item xs={5}><Typography variant="body2" color="text.secondary">Partition:</Typography></Grid>
                    <Grid item xs={7}><Typography variant="body2">{autoMapResult?.partitionInfo}</Typography></Grid>

                    <Grid item xs={5}><Typography variant="body2" color="text.secondary">Mount Point:</Typography></Grid>
                    <Grid item xs={7}><Typography variant="body2">{autoMapResult?.mountPoint}</Typography></Grid>

                    <Grid item xs={5}><Typography variant="body2" color="text.secondary">Windows User:</Typography></Grid>
                    <Grid item xs={7}><Typography variant="body2">{autoMapResult?.username}</Typography></Grid>

                    <Grid item xs={5}><Typography variant="body2" color="text.secondary">Mappings:</Typography></Grid>
                    <Grid item xs={7}><Typography variant="body2"><strong>{autoMapResult?.count}</strong> new folder mappings added</Typography></Grid>
                  </Grid>
                </Paper>
                <Typography variant="body2">
                  You can review them in the list or activate them immediately.
                </Typography>
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setAutoMapSuccessOpen(false)}>Review List</Button>
                <Button variant="contained" color="success" onClick={() => {
                  // "Mount All Now" logic
                  if (autoMapResult?.newMappings) {
                    setPendingMountRows(autoMapResult.newMappings);
                    // Generate a script preview for all items (optional, or just reuse existing dialog logic)
                    // For "Mount All", let's re-use the confirmation dialog to be safe and consistent
                    // But we need to generate a script that includes ALL rows
                    const lines: string[] = [];
                    lines.push('#!/bin/sh');
                    lines.push('set -e');
                    if (!skipPartition && partitionUuid && partitionUuid.trim() !== '') {
                      lines.push(`mkdir -p "${baseMount}"`);
                      lines.push(`mount -U ${partitionUuid} "${baseMount}" || mount UUID=${partitionUuid} "${baseMount}" || true`);
                    }
                    autoMapResult.newMappings.forEach((r: Mapping) => {
                      if (r.src && r.target) {
                        lines.push(`mkdir -p "${r.target}"`);
                        lines.push(`mount --bind "${r.src}" "${r.target}"`);
                      }
                    });
                    setDialogScript(lines.join('\n') + '\n');
                    setDialogOpen(true);
                    setAutoMapSuccessOpen(false);
                  }
                }}>
                  Mount All Now
                </Button>
              </DialogActions>
            </Dialog>

            <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
              <Grid container alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
                <Grid item><Typography variant="h6">Disks & Partitions</Typography></Grid>
                <Grid item>
                  <Tooltip title="Refresh"><IconButton onClick={refreshPartitions}><RefreshIcon /></IconButton></Tooltip>
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
                            <IconButton size="small" onClick={() => { navigator.clipboard.writeText(p.uuid); setCopied(true); }}>
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
            <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
              <Grid container alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
                <Grid item><Typography variant="h6">Existing Mappings</Typography></Grid>
                <Grid item>
                  <Grid container spacing={1}>
                    <Grid item>
                      <Button variant="contained" onClick={addRow}>Add Mapping</Button>
                    </Grid>
                    <Grid item>
                      <Button
                        variant="contained"
                        color="success"
                        onClick={smartAutoMap}
                        disabled={smartAutoMapLoading}
                      >
                        {smartAutoMapLoading ? (
                          <>
                            <CircularProgress size={18} color="inherit" sx={{ mr: 1 }} />
                            Detecting...
                          </>
                        ) : (
                          'Smart Auto-Map'
                        )}
                      </Button>
                    </Grid>
                    <Grid item>
                      <Button
                        variant="outlined"
                        color="secondary"
                        onClick={() => {
                          detectUserFolders();
                          setAutoMappingOpen(true);
                        }}
                      >
                        Manual Auto-Map
                      </Button>
                    </Grid>
                  </Grid>
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
                    <Paper variant="outlined" sx={{ p: 1 }}>
                      <Grid container spacing={1} alignItems="center">
                        <Grid item xs={12} md={5}><code>{row.src || '—'}</code></Grid>
                        <Grid item xs={12} md={5}><code>{row.target || '—'}</code></Grid>
                        <Grid item xs={6} md={1}>
                          {(() => {
                            const mounted = installedBlocks.some(b => b.targets && b.targets.includes(row.target || ''));
                            return (
                              <Button
                                size="small"
                                variant={mounted ? "outlined" : "contained"}
                                color={mounted ? "error" : "primary"}
                                disabled={!row.src || !row.target}
                                onClick={() => {
                                  if (mounted) {
                                    // Unmount logic
                                    if (row.target) {
                                      setRemoveDialogId(null); // Clear ID, we are removing by target
                                      setRemoveDialogTarget(row.target);
                                      setRemoveDialogForce(false);
                                      setRemoveDialogOpen(true);
                                    }
                                  } else {
                                    mountRow(row);
                                  }
                                }}
                              >
                                {mounted ? "Unmount" : "Mount"}
                              </Button>
                            );
                          })()}
                        </Grid>
                        <Grid item xs={6} md={1}>
                          <IconButton size="small" aria-label="remove" onClick={() => removeRow(row.id)}><DeleteIcon fontSize="small" /></IconButton>
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
      </div>
    </div>
  );
}



export default App;
