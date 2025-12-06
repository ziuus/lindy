import { createTheme } from "@mui/material/styles";
import type { PaletteMode } from "@mui/material";

// Create application theme based on mode
export type Accent =
  | 'green'
  | 'teal'
  | 'blue'
  | 'purple'
  | 'orange'
  | 'red'
  | 'pink'
  | 'indigo'
  | 'cyan'
  | 'lime'
  | 'amber'
  | 'deepOrange';

export const ACCENT_ORDER: Accent[] = [
  'green', 'teal', 'blue', 'purple', 'orange', 'red', 'pink', 'indigo', 'cyan', 'lime', 'amber', 'deepOrange'
];

const accentMap: Record<Accent, { main: string; light: string; dark: string }> = {
  green: { main: '#00c853', light: '#5efc82', dark: '#009624' },
  teal: { main: '#009688', light: '#52c7b8', dark: '#00675b' },
  blue: { main: '#2962ff', light: '#768fff', dark: '#0039cb' },
  purple: { main: '#7e57c2', light: '#b085f5', dark: '#4d2c91' },
  orange: { main: '#fb8c00', light: '#ffbd45', dark: '#c25e00' },
  red: { main: '#d32f2f', light: '#ff6659', dark: '#9a0007' },
  pink: { main: '#e91e63', light: '#ff6090', dark: '#b0003a' },
  indigo: { main: '#3f51b5', light: '#757de8', dark: '#002984' },
  cyan: { main: '#00bcd4', light: '#62efff', dark: '#008ba3' },
  lime: { main: '#cddc39', light: '#ffff72', dark: '#99aa00' },
  amber: { main: '#ffc107', light: '#fff350', dark: '#c79100' },
  deepOrange: { main: '#ff5722', light: '#ff8a50', dark: '#c41c00' },
};

export function createAppTheme(mode: PaletteMode, accent: Accent = 'green') {
  const isDark = mode === "dark";
  const acc = accentMap[accent];
  return createTheme({
    palette: {
      mode,
      primary: { ...acc, contrastText: isDark ? '#0b0b0b' : '#ffffff' },
      secondary: { ...acc, contrastText: isDark ? '#0b0b0b' : '#ffffff' },
      background: isDark
        ? {
            default: "#0e1116",
            paper: "#141922",
          }
        : {
            default: "#f5f7fa",
            paper: "#ffffff",
          },
    },
    shape: { borderRadius: 10 },
    typography: {
      fontFamily: 'Inter, "Segoe UI", system-ui, Avenir, Helvetica, Arial, sans-serif',
    },
    components: {
      MuiPaper: {
        styleOverrides: {
          root: {
            border: isDark ? "1px solid rgba(255,255,255,0.06)" : "1px solid rgba(0,0,0,0.06)",
          },
        },
      },
      MuiButton: {
        styleOverrides: {
          root: {
            textTransform: "none",
            fontWeight: 600,
          },
        },
      },
    },
  });
}

export default createAppTheme;
